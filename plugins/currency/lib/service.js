import { balanceOf, transactionId } from './ledger.js';
import { command, consumerId, fail, limit, MAX_AMOUNT, object, scope, text, userId, WRITE_METHODS } from './validation.js';

export function createService({ storage, readSettings, guard }) {
  function run(work, epoch) {
    try { guard(epoch); return { ok: true, ...work() }; }
    catch (error) { return { ok: false, code: error.code || 'INTERNAL_ERROR', message: error.code ? error.message : '货币服务内部错误。' }; }
  }

  function read(kind, consumer, args = {}, privileged = false) {
    object(args);
    const config = readSettings();
    if (kind === 'info') return { apiVersion: 1, currencyName: config.currencyName, unit: 'integer', maxBalance: MAX_AMOUNT,
      permissions: privileged ? [...WRITE_METHODS] : [...(Object.hasOwn(config.permissions, consumer) ? config.permissions[consumer] : [])] };
    const chat = scope(args.scope), state = storage.state;
    if (kind === 'balance') return { ...balanceOf(state, chat, userId(args.userId)), currencyName: config.currencyName };
    if (kind === 'receipt') {
      const id = transactionId({ consumer, scope: chat, requestId: text(args.requestId, 'requestId', 160) });
      const receipt = state.byId.get(id);
      if (!receipt) fail('NOT_FOUND', '找不到该请求的成功交易；失败的操作不会占用 requestId。');
      return { receipt: structuredClone(receipt), reservation: structuredClone(state.holds.get(id) ?? null),
        refundId: state.refunds.get(id) ?? null };
    }
    if (kind === 'history') {
      const target = userId(args.userId), count = limit(args.limit);
      const before = args.before ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(before) || before <= 0) fail('INVALID_ARGUMENT', 'before 必须是正整数流水序号。');
      const receipts = state.receipts.filter(receipt => receipt.sequence < before && receipt.input.scope === chat
        && receipt.entries.some(entry => entry.userId === target)).slice(-count).reverse();
      return { receipts: structuredClone(receipts), nextBefore: receipts.length ? receipts.at(-1).sequence : null };
    }
    if (kind === 'reservations') {
      const target = args.userId === undefined ? null : userId(args.userId);
      const count = limit(args.limit);
      const after = args.after ?? 0;
      if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_ARGUMENT', 'after 必须是非负整数流水序号。');
      const holds = [...state.holds.values()].filter(hold => hold.scope === chat && hold.status === 'pending'
        && (privileged || hold.consumer === consumer) && (!target || hold.userId === target)
        && state.byId.get(hold.id).sequence > after).slice(0, count)
        .map(hold => ({ ...hold, sequence: state.byId.get(hold.id).sequence }));
      return { reservations: structuredClone(holds), nextAfter: holds.length ? holds.at(-1).sequence : null };
    }
    if (kind === 'rank') {
      const count = limit(args.limit);
      const accounts = Object.entries(state.accounts).filter(([key]) => key.startsWith(`${chat}/`))
        .map(([key]) => balanceOf(state, chat, key.slice(chat.length + 1)))
        .sort((a, b) => b.balance - a.balance || a.userId.localeCompare(b.userId)).slice(0, count);
      return { accounts, currencyName: config.currencyName };
    }
    fail('INVALID_ARGUMENT', '未知查询。');
  }

  function write(operation, consumer, args, privileged = false) {
    const config = readSettings();
    const permissions = Object.hasOwn(config.permissions, consumer) ? config.permissions[consumer] : [];
    if (!privileged && !permissions.includes(operation)) fail('FORBIDDEN', `扩展 ${consumer} 未获 ${operation} 权限，请在货币插件设置中配置接入权限。`);
    const receipt = storage.transact(command(operation, consumer, args));
    return { receipt, currencyName: config.currencyName };
  }

  function client(consumer, epoch) {
    consumerId(consumer);
    const api = { apiVersion: 1, consumer };
    for (const kind of ['info', 'balance', 'receipt', 'history', 'reservations', 'rank']) {
      api[kind] = args => run(() => read(kind, consumer, args), epoch);
    }
    for (const operation of WRITE_METHODS) api[operation] = args => run(() => write(operation, consumer, args), epoch);
    return Object.freeze(api);
  }

  return { client, run, read, write };
}
