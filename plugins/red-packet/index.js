// 群红包（依赖货币能力 currency.v1，用 transfer 结算）
//
// 为什么不用 reserve 预扣：
//   货币接口的 capture/release 都是**全额**的，做不了"抢走一部分、剩下的退回"。
//   换成"谁抢到才给谁转账"更简单也更安全：钱平时还在发红包的人账上，
//   没抢完/过期都不会产生冻结死账，也不需要后台释放任务。
//
// 幂等：每笔转账的 requestId 固定成 `红包:<红包id>:领:<QQ>`。
//   同一人重试、模型重复调用、进程重启后重放都不会多发一次钱。
import { randomInt } from 'node:crypto';

const DEFAULTS = { maxTotal: 10000, maxCount: 20, expireSec: 300 };
const num = (v, fb, min, max) => {
  const n = Math.floor(Number(v ?? fb));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};

let hostApi = null;
let storage = null;

function readSettings() {
  const c = (() => { try { return hostApi?.config?.() ?? {}; } catch { return {}; } })();
  return {
    maxTotal: num(c.maxTotal, DEFAULTS.maxTotal, 1, 1e6),
    maxCount: num(c.maxCount, DEFAULTS.maxCount, 1, 100),
    expireSec: num(c.expireSec, DEFAULTS.expireSec, 10, 86400)
  };
}

function money() {
  const api = hostApi?.capability?.('currency.v1', { consumer: 'red-packet' });
  return api && api.apiVersion === 1 ? api : null;
}

const listKey = (scope) => `packets:${scope}`;
const packetKey = (id) => `packet:${id}`;

function loadPackets(scope) {
  const arr = storage?.get(listKey(scope), []);
  return Array.isArray(arr) ? arr : [];
}

function savePackets(scope, arr) {
  // 只留最近 50 个，避免存储无限膨胀
  storage?.set(listKey(scope), arr.slice(-50));
}

/** 二倍均值法：随机但不会有 0 元份额，也不会一个人吃掉大半。 */
function nextShare(remainingAmount, remainingCount) {
  if (remainingCount <= 1) return remainingAmount;
  const max = Math.max(1, Math.floor((remainingAmount / remainingCount) * 2));
  const picked = 1 + randomInt(max);           // 1..max
  // 给后面的人至少留 1 元
  return Math.min(picked, remainingAmount - (remainingCount - 1));
}

function summarize(packet) {
  const claimedAmount = packet.claims.reduce((sum, c) => sum + c.amount, 0);
  return {
    id: packet.id,
    total: packet.total,
    count: packet.count,
    claimedCount: packet.claims.length,
    claimedAmount,
    remaining: packet.total - claimedAmount,
    expiresAt: packet.expiresAt,
    status: packet.status
  };
}

export function setup(api) {
  hostApi = api;
  storage = api.storage;

  api.registerTool({
    id: 'send_red_packet',
    name: '发红包',
    category: 'economy',
    description: '群友明确要求发红包时使用。total=总金币，count=份数。只创建红包、不发消息；成功后必须用 send_message 告诉大家红包编号/总额/份数。',
    parameters: {
      type: 'object',
      properties: {
        total: { type: 'integer', minimum: 1, maximum: 100000000, description: '总金币（正整数）' },
        count: { type: 'integer', minimum: 1, maximum: 100, description: '份数（正整数）' }
      },
      required: ['total', 'count'],
      additionalProperties: false
    },
    async execute(ctx, args = {}) {
      const scope = String(ctx?.chatKey || '');
      const senderId = String(ctx?.sender?.userId || ctx?.senderId || '').trim();
      if (!/^group:\d+$/.test(scope)) {
        return { content: JSON.stringify({ ok: false, reason: '红包只能在群里发' }), isError: true };
      }
      if (!/^[1-9]\d{4,11}$/.test(senderId)) {
        return { content: JSON.stringify({ ok: false, reason: '拿不到发红包人的 QQ 号' }), isError: true };
      }
      const currency = money();
      if (!currency) return { content: JSON.stringify({ ok: false, reason: '货币系统未启用或未授权 red-packet' }), isError: true };

      const s = readSettings();
      const total = num(args.total, 0, 1, s.maxTotal);
      const count = num(args.count, 0, 1, s.maxCount);
      if (!total || !count) return { content: JSON.stringify({ ok: false, reason: `总金币需 1~${s.maxTotal}，份数需 1~${s.maxCount}` }), isError: true };
      if (count > total) return { content: JSON.stringify({ ok: false, reason: '份数不能超过总金币（每份至少 1）' }), isError: true };

      const bal = currency.balance({ scope, userId: senderId });
      if (!bal?.ok) return { content: JSON.stringify({ ok: false, reason: bal?.message || '查余额失败' }), isError: true };
      if (bal.available < total) {
        return { content: JSON.stringify({ ok: false, reason: `可用余额不足：只有 ${bal.available}，要发 ${total}` }), isError: true };
      }

      const id = `rp${Date.now().toString(36)}${randomInt(1000, 9999)}`;
      const packet = {
        id,
        scope,
        senderId,
        total,
        count,
        claims: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + s.expireSec * 1000,
        status: 'open'
      };
      storage?.set(packetKey(id), packet);
      const list = loadPackets(scope);
      list.push(id);
      savePackets(scope, list);

      return {
        content: JSON.stringify({
          ok: true,
          ...summarize(packet),
          note: '红包已创建（钱还在发红包的人账上，抢到才转出）。用 send_message 简短说明总额与份数。'
        })
      };
    }
  });

  api.registerTool({
    id: 'grab_red_packet',
    name: '抢红包',
    category: 'economy',
    description: '群友要求抢/领红包时使用。省略 packetId 抢本群最新一个还能抢的红包。抢到会真的把金币转到抢的人账上；结果要用 send_message 转述。',
    parameters: {
      type: 'object',
      properties: {
        packetId: { type: 'string', description: '红包编号（可省略，省略则抢本群最新的）' }
      },
      additionalProperties: false
    },
    async execute(ctx, args = {}) {
      const scope = String(ctx?.chatKey || '');
      const userId = String(ctx?.sender?.userId || ctx?.senderId || '').trim();
      if (!/^group:\d+$/.test(scope)) {
        return { content: JSON.stringify({ ok: false, reason: '红包只能在群里抢' }), isError: true };
      }
      if (!/^[1-9]\d{4,11}$/.test(userId)) {
        return { content: JSON.stringify({ ok: false, reason: '拿不到抢红包人的 QQ 号' }), isError: true };
      }
      const currency = money();
      if (!currency) return { content: JSON.stringify({ ok: false, reason: '货币系统未启用或未授权 red-packet' }), isError: true };

      const wantedId = String(args.packetId || '').trim();
      const ids = loadPackets(scope);
      const candidates = (wantedId ? [wantedId] : [...ids].reverse());
      let packet = null;
      let lastClosed = null;
      for (const id of candidates) {
        const p = storage?.get(packetKey(id), null);
        if (!p || p.scope !== scope) continue;
        if (p.status !== 'open') { lastClosed = p; continue; }
        packet = p;
        break;
      }
      if (!packet) {
        if (lastClosed) {
          const sum = summarize(lastClosed);
          return { content: JSON.stringify({ ok: false, reason: `这个红包已经结束（${sum.status === 'done' ? '抢完了' : '过期了'}）`, ...sum }), isError: true };
        }
        return { content: JSON.stringify({ ok: false, reason: '本群现在没有可抢的红包' }), isError: true };
      }
      if (Date.now() > packet.expiresAt) {
        packet.status = 'expired';
        storage?.set(packetKey(packet.id), packet);
        return { content: JSON.stringify({ ok: false, reason: '红包已过期', ...summarize(packet) }), isError: true };
      }
      if (packet.claims.some((c) => c.userId === userId)) {
        return { content: JSON.stringify({ ok: false, reason: '你已经抢过这个红包了', ...summarize(packet) }), isError: true };
      }
      if (packet.senderId === userId) {
        return { content: JSON.stringify({ ok: false, reason: '不能抢自己发的红包' }), isError: true };
      }

      const remainingAmount = packet.total - packet.claims.reduce((sum, c) => sum + c.amount, 0);
      const remainingCount = packet.count - packet.claims.length;
      if (remainingAmount <= 0 || remainingCount <= 0) {
        packet.status = 'done';
        storage?.set(packetKey(packet.id), packet);
        return { content: JSON.stringify({ ok: false, reason: '红包抢完了', ...summarize(packet) }), isError: true };
      }

      const share = nextShare(remainingAmount, remainingCount);
      const moved = currency.transfer({
        scope,
        fromUserId: packet.senderId,
        toUserId: userId,
        amount: share,
        requestId: `红包:${packet.id}:领:${userId}`,
        reason: `抢红包 ${packet.id}`
      });
      if (!moved?.ok) {
        // 发红包的人余额被花掉了：这个红包就地作废，别让人反复点
        if (moved?.code === 'INSUFFICIENT_FUNDS') {
          packet.status = 'void';
          storage?.set(packetKey(packet.id), packet);
        }
        return { content: JSON.stringify({ ok: false, reason: moved?.message || moved?.code || '转账失败', ...summarize(packet) }), isError: true };
      }

      packet.claims.push({ userId, amount: share, at: Date.now(), transactionId: moved.receipt?.id ?? null });
      if (packet.claims.length >= packet.count) packet.status = 'done';
      storage?.set(packetKey(packet.id), packet);

      const bal = currency.balance({ scope, userId });
      return {
        content: JSON.stringify({
          ok: true,
          amount: share,
          balance: bal?.ok ? bal.balance : null,
          ...summarize(packet),
          note: '抢到了。用 send_message 说一句抢到多少、还剩几份。'
        })
      };
    }
  });
}

/** 面板只读视图：本群红包列表。 */
export async function handleUiRequest({ action, payload } = {}) {
  if (action !== 'list') return { ok: false, error: `未知动作：${action}` };
  const scope = String(payload?.chatKey || '');
  if (!/^group:\d+$/.test(scope)) return { ok: false, error: '需要 chatKey（group:123456）' };
  const rows = loadPackets(scope)
    .map((id) => storage?.get(packetKey(id), null))
    .filter(Boolean)
    .map((p) => ({ ...summarize(p), senderId: p.senderId, createdAt: p.createdAt }))
    .reverse();
  return { ok: true, rows: rows.slice(0, 50) };
}
