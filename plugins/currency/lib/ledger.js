import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { command, fail, isObject, MAX_AMOUNT } from './validation.js';

export const emptyState = () => ({ accounts: {}, receipts: [], byId: new Map(), holds: new Map(), refunds: new Map() });
export const transactionId = ({ consumer, scope, requestId }) => createHash('sha256').update(JSON.stringify([consumer, scope, requestId])).digest('hex');
const accountKey = (scope, userId) => `${scope}/${userId}`;
export const balanceOf = (state, scope, userId) => {
  const account = state.accounts[accountKey(scope, userId)] ?? { balance: 0, held: 0 };
  return { scope, userId, balance: account.balance, held: account.held, available: account.balance - account.held };
};

// 单个命令先在局部副本算完所有余额；只有完整命令成功才应用到内存。
export function prepare(state, input, at) {
  const id = transactionId(input);
  const existing = state.byId.get(id);
  if (existing) {
    if (!isDeepStrictEqual(existing.input, input)) fail('IDEMPOTENCY_CONFLICT', '该 requestId 已用于不同参数；不能改参数重试。');
    return { receipt: existing, replayed: true };
  }
  const accounts = {};
  const entries = [];
  let holdChange = null;
  let refundChange = null;
  let value = input.amount;

  function change(userId, delta, heldDelta = 0) {
    const before = balanceOf(state, input.scope, userId);
    const balance = before.balance + delta, held = before.held + heldDelta;
    if (!Number.isSafeInteger(balance) || balance > MAX_AMOUNT) fail('BALANCE_LIMIT', '账户达到余额上限，本次交易未执行。');
    if (balance < 0 || balance < held) fail('INSUFFICIENT_FUNDS', '可用余额不足，本次交易未执行。');
    if (!Number.isSafeInteger(held) || held < 0) fail('INVALID_STATE', '冻结余额异常。');
    accounts[accountKey(input.scope, userId)] = { balance, held };
    entries.push({ userId, delta, heldDelta, balance, held, available: balance - held });
  }

  function reference(refId) {
    const ref = state.byId.get(refId);
    if (!ref || ref.input.scope !== input.scope) fail('NOT_FOUND', '当前账户范围内找不到这笔交易。');
    if (ref.input.consumer !== input.consumer && input.consumer !== 'currency') fail('FORBIDDEN', '只能操作本扩展建立的交易。');
    return ref;
  }

  switch (input.operation) {
    case 'credit': change(input.userId, value); break;
    case 'debit': change(input.userId, -value); break;
    case 'transfer': change(input.fromUserId, -value); change(input.toUserId, value); break;
    case 'reserve':
      change(input.userId, 0, value);
      holdChange = { id, scope: input.scope, consumer: input.consumer, userId: input.userId, amount: value, status: 'pending', resolvedBy: null };
      break;
    case 'capture':
    case 'release': {
      reference(input.reservationId);
      const hold = state.holds.get(input.reservationId);
      if (!hold) fail('INVALID_ARGUMENT', '指定交易不是预扣款。');
      if (hold.status !== 'pending') fail('HOLD_CLOSED', `预扣款已经${hold.status === 'captured' ? '结算' : '释放'}。`);
      value = hold.amount;
      change(hold.userId, input.operation === 'capture' ? -value : 0, -value);
      holdChange = { ...hold, status: input.operation === 'capture' ? 'captured' : 'released', resolvedBy: id };
      break;
    }
    case 'refund': {
      const original = reference(input.transactionId);
      if (!['debit', 'capture'].includes(original.input.operation)) fail('INVALID_ARGUMENT', '只能全额退回 debit 或 capture 的扣款。');
      if (state.refunds.has(original.id)) fail('ALREADY_REFUNDED', '这笔扣款已经退款。');
      value = original.amount;
      change(original.entries[0].userId, value);
      refundChange = { originalId: original.id, refundId: id };
      break;
    }
    default: fail('INVALID_ARGUMENT', '未知操作。');
  }
  if (!Number.isSafeInteger(at) || at < 0) fail('INVALID_ARGUMENT', '交易时间无效。');
  const receipt = { id, sequence: state.receipts.length + 1, at, input, amount: value, entries };
  return { receipt, accounts, holdChange, refundChange, replayed: false };
}

export function commit(state, prepared) {
  if (prepared.replayed) return;
  Object.assign(state.accounts, prepared.accounts);
  if (prepared.holdChange) state.holds.set(prepared.holdChange.id, prepared.holdChange);
  if (prepared.refundChange) state.refunds.set(prepared.refundChange.originalId, prepared.refundChange.refundId);
  state.receipts.push(prepared.receipt);
  state.byId.set(prepared.receipt.id, prepared.receipt);
}

export function restore(parsed) {
  if (!isObject(parsed) || parsed.pluginId !== 'currency' || parsed.version !== 1 || !Array.isArray(parsed.transactions)) {
    fail('CORRUPT_DATA', '货币数据格式不匹配；保留原文件，停止写入。');
  }
  const state = emptyState();
  try {
    for (const receipt of parsed.transactions) {
      if (!isObject(receipt) || !isObject(receipt.input)) throw new Error('交易格式无效');
      const { operation, consumer, ...args } = receipt.input;
      const input = command(operation, consumer, args);
      const result = prepare(state, input, receipt.at);
      if (result.replayed || !isDeepStrictEqual(result.receipt, receipt)) throw new Error('流水与余额不一致');
      commit(state, result);
    }
  } catch (error) { fail('CORRUPT_DATA', `货币流水校验失败：${error.message}；保留原文件，停止写入。`); }
  return state;
}
