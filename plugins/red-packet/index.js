// 群红包（确定性插件：不走模型）
//
// 群里说「发红包 100 5份」→ 建包；说「抢红包」→ 抢本群最新还能抢的。
// 抢到那一刻才 transfer，所以没抢完/过期都不会有冻结死账，也不需要后台释放。
// 幂等：转账 requestId 固定「红包:<包id>:领:<QQ>」，重试/重启都不会多发。
import { randomInt } from 'node:crypto';

const DEFAULTS = { maxTotal: 10000, maxCount: 20, expireSec: 300 };
const num = (v, fb, min, max) => {
  const n = Math.floor(Number(v ?? fb));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};

let hostApi = null;
let storage = null;
let log = () => {};

function conf() {
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
function unit() {
  try { const info = money()?.info?.(); return info?.currencyName ? String(info.currencyName) : '金币'; } catch { return '金币'; }
}

const listKey = (scope) => `packets:${scope}`;
const packetKey = (id) => `packet:${id}`;
const loadIds = (scope) => { const a = storage?.get(listKey(scope), []); return Array.isArray(a) ? a : []; };
const saveIds = (scope, arr) => storage?.set(listKey(scope), arr.slice(-50));

/** 二倍均值法：不会出现 0 元份，也不会一个人吃光。 */
function nextShare(remainingAmount, remainingCount) {
  if (remainingCount <= 1) return remainingAmount;
  const max = Math.max(1, Math.floor((remainingAmount / remainingCount) * 2));
  const picked = 1 + randomInt(max);
  return Math.min(picked, remainingAmount - (remainingCount - 1));
}

function summarize(p) {
  const claimedAmount = p.claims.reduce((sum, c) => sum + c.amount, 0);
  return {
    id: p.id, total: p.total, count: p.count,
    claimedCount: p.claims.length, claimedAmount,
    remaining: p.total - claimedAmount,
    expiresAt: p.expiresAt, status: p.status
  };
}

function cleanText(text) {
  return String(text || '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/@\S+/g, ' ')
    .trim();
}

export function setup(api) {
  hostApi = api;
  storage = api.storage;
  log = api.log || (() => {});
}

async function reply(ctx, text) {
  try {
    ctx?.sender?.allowRateBypass?.(ctx.chatKey, 5000);   // 命令类回复不被限流吞掉
    if (typeof ctx?.sender?.sendTextBatch === 'function') await ctx.sender.sendTextBatch(ctx.chatKey, text, {});
  } catch (error) { log(`红包回复失败：${error?.message ?? error}`); }
}
function markHandled(ctx) {
  try { ctx?.store?.markEntryRead?.(ctx.chatKey, ctx?.entry?.id); } catch { /* 忽略 */ }
}

export const hooks = {
  async onMessage(ctx) {
    const raw = cleanText(ctx?.text);
    if (!raw) return;
    if (!/^group:\d+$/.test(String(ctx?.chatKey || ''))) return;
    const userId = String(ctx?.senderId || '').trim();
    if (!/^[1-9]\d{4,11}$/.test(userId)) return;
    const currency = money();
    if (!currency) return;
    const s = conf();

    // ① 发红包：「发红包 100 5份」「发个红包100金币 5个」「撒币 50」
    if (/^(发红包|发个红包|撒币|发一个红包)/.test(raw.replace(/\s+/g, ''))) {
      const body = raw.replace(/^(发红包|发个红包|撒币|发一个红包)/, ' ');
      const nums = (body.match(/\d+/g) || []).map(Number);
      const total = nums[0];
      const count = nums[1] || 5;
      if (!total) {
        await reply(ctx, '发红包要写金额，比如「发红包 100 5份」');
        markHandled(ctx);
        return;
      }
      if (total > s.maxTotal || count > s.maxCount || count > total) {
        await reply(ctx, `发不了：单个红包最多 ${s.maxTotal} ${unit()} / ${s.maxCount} 份，且每份至少 1`);
        markHandled(ctx);
        return;
      }
      const bal = currency.balance({ scope: ctx.chatKey, userId });
      if (bal?.ok && bal.available < total) {
        await reply(ctx, `你只有 ${bal.available} ${unit()}，不够发 ${total}`);
        markHandled(ctx);
        return;
      }
      const id = `rp${Date.now().toString(36)}${randomInt(1000, 9999)}`;
      const packet = { id, scope: ctx.chatKey, senderId: userId, total, count, claims: [], createdAt: Date.now(), expiresAt: Date.now() + s.expireSec * 1000, status: 'open' };
      storage?.set(packetKey(id), packet);
      const ids = loadIds(ctx.chatKey);
      ids.push(id);
      saveIds(ctx.chatKey, ids);
      await reply(ctx, `红包发好了：${total} ${unit()} · ${count} 份，${Math.round(s.expireSec / 60) || 5} 分钟内有效，抢吧`);
      markHandled(ctx);
      return;
    }

    // ② 抢红包：「抢红包 / 领红包 / 抢」
    if (/^(抢红包|领红包|抢|领取红包|红包)$/.test(raw.replace(/\s+/g, ''))) {
      const ids = loadIds(ctx.chatKey);
      let packet = null;
      let closed = null;
      for (const id of [...ids].reverse()) {
        const p = storage?.get(packetKey(id), null);
        if (!p || p.scope !== ctx.chatKey) continue;
        if (p.status !== 'open') { closed = p; continue; }
        packet = p;
        break;
      }
      if (!packet) {
        await reply(ctx, closed ? '这个红包已经结束了' : '现在没有可抢的红包');
        markHandled(ctx);
        return;
      }
      if (Date.now() > packet.expiresAt) {
        packet.status = 'expired';
        storage?.set(packetKey(packet.id), packet);
        await reply(ctx, '这个红包已经过期了');
        markHandled(ctx);
        return;
      }
      if (packet.senderId === userId) {
        await reply(ctx, '自己发的红包抢不了');
        markHandled(ctx);
        return;
      }
      if (packet.claims.some((c) => c.userId === userId)) {
        await reply(ctx, '这个红包你已经抢过了');
        markHandled(ctx);
        return;
      }
      const remainingAmount = packet.total - packet.claims.reduce((sum, c) => sum + c.amount, 0);
      const remainingCount = packet.count - packet.claims.length;
      if (remainingAmount <= 0 || remainingCount <= 0) {
        packet.status = 'done';
        storage?.set(packetKey(packet.id), packet);
        await reply(ctx, '红包抢完了');
        markHandled(ctx);
        return;
      }
      const share = nextShare(remainingAmount, remainingCount);
      const moved = currency.transfer({
        scope: ctx.chatKey,
        fromUserId: packet.senderId, toUserId: userId, amount: share,
        requestId: `红包:${packet.id}:领:${userId}`, reason: `抢红包 ${packet.id}`
      });
      if (!moved?.ok) {
        if (moved?.code === 'INSUFFICIENT_FUNDS') {
          packet.status = 'void';
          storage?.set(packetKey(packet.id), packet);
        }
        await reply(ctx, `没抢到：${moved?.message || '转账失败'}`);
        markHandled(ctx);
        return;
      }
      packet.claims.push({ userId, amount: share, at: Date.now(), transactionId: moved.receipt?.id ?? null });
      if (packet.claims.length >= packet.count) packet.status = 'done';
      storage?.set(packetKey(packet.id), packet);
      const bal = currency.balance({ scope: ctx.chatKey, userId });
      const left = packet.count - packet.claims.length;
      const bits = [`抢到 ${share} ${unit()}`];
      if (bal?.ok) bits.push(`余额 ${bal.balance}`);
      bits.push(left > 0 ? `还剩 ${left} 份` : '抢完了');
      await reply(ctx, bits.join('，'));
      markHandled(ctx);
    }
  }
};

/** 面板：本群红包列表（只读）。 */
export async function handleUiRequest({ action, payload } = {}) {
  if (action !== 'list') return { ok: false, error: `未知动作：${action}` };
  const scope = String(payload?.chatKey || payload?.scope || '');
  if (!/^group:\d+$/.test(scope)) return { ok: false, error: '需要 chatKey（group:123456）' };
  const rows = loadIds(scope)
    .map((id) => storage?.get(packetKey(id), null))
    .filter(Boolean)
    .map((p) => {
      const sum = summarize(p);
      return { ...sum, senderId: p.senderId, createdAt: p.createdAt, status: sum.status === 'open' && sum.expiresAt < Date.now() ? 'expired' : sum.status, unit: unit() };
    })
    .reverse();
  return { ok: true, rows: rows.slice(0, 50) };
}
