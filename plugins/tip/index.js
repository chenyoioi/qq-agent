// 群友打赏：机器人觉得谁说的话有意思，就给那条消息的作者发金币。
//
// 这是**唯一**走模型的经济功能： критерий是"有意思"，没法用触发词判断。
// 模型调用 tip_reward(messageId, reason)，这里负责所有硬约束：
//   · 只能打赏**本轮真实发言**的人（从 session.trigger 里按 messageId 找发信人）
//   · 一条消息只能打赏一次（requestId = 打赏:<群>:<消息id>，幂等重放不会多发）
//   · 同一个人 minGapMinutes 内只打赏一次；本群每天最多 maxPerDay 笔
//   · 金额固定为设置里的 amount（模型传更大的值会被压回来），不许打赏自己/机器人
//   · source=mint 直接印；source=bot 从机器人自己的钱包转（不够就失败，不偷偷印）
import { randomInt } from 'node:crypto';

const DEFAULTS = { amount: 10, minGapMinutes: 60, maxPerDay: 8, source: 'mint' };
const num = (v, fb, min, max) => {
  const n = Math.floor(Number(v ?? fb));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};

let hostApi = null;
let storage = null;
let log = () => {};

function conf() {
  const c = (() => { try { return hostApi?.config?.() ?? {}; } catch { return {}; } })();
  const source = String(c.source || DEFAULTS.source).toLowerCase() === 'bot' ? 'bot' : 'mint';
  return {
    amount: num(c.amount, DEFAULTS.amount, 1, 1000),
    minGapMinutes: num(c.minGapMinutes, DEFAULTS.minGapMinutes, 0, 10080),
    maxPerDay: num(c.maxPerDay, DEFAULTS.maxPerDay, 1, 200),
    source
  };
}

function money() {
  const api = hostApi?.capability?.('currency.v1', { consumer: 'tip' });
  return api && api.apiVersion === 1 ? api : null;
}
function unit() {
  try { const i = money()?.info?.(); return i?.currencyName ? String(i.currencyName) : '金币'; } catch { return '金币'; }
}

const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const lastKey = (scope, userId) => `last:${scope}:${userId}`;
const dayKeyOf = (scope, day) => `day:${day}:${scope}`;
const logKey = (scope) => `tips:${scope}`;

/** 从本轮真实发言里按 #消息id 找发信人（宿主提示里的 #数字 就是 mid）。 */
function speakerOf(ctx, messageId) {
  const raw = Array.isArray(ctx?.session?.triggerEntries) ? ctx.session.triggerEntries : ctx.session?.trigger;
  const list = Array.isArray(raw) ? raw : [];
  const want = String(messageId ?? '').trim();
  if (!want) return null;
  return list.find((e) => e && !e.self && !e.recalled && String(e.mid ?? `local:${e.id}`) === want) || null;
}

export function setup(api) {
  hostApi = api;
  storage = api.storage;
  log = api.log || (() => {});
  api.registerTool({
    id: 'tip_reward',
    name: '打赏有意思的发言',
    description: '给本群里某条让你觉得有意思的发言打赏金币（金额由设置决定，通常 10）。只传那条消息的 messageId 和一句理由。一条消息只能打赏一次，同一人一小时内一次，本群每天有上限。工具只记账不发消息。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: '那条发言的消息 id（提示里 # 后面的数字）' },
        reason: { type: 'string', description: '打赏理由，一两句，会写进流水' },
        amount: { type: 'number', description: '可选，想给多少；超过设置上限会被压回上限' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const scope = String(ctx?.chatKey || '');
      if (!/^group:\d+$/.test(scope)) {
        return { content: JSON.stringify({ ok: false, reason: '只能在群里打赏' }), isError: true };
      }
      const currency = money();
      if (!currency) return { content: JSON.stringify({ ok: false, reason: '货币系统未启用（或没给 tip 授权）' }), isError: true };

      const entry = speakerOf(ctx, args?.messageId);
      if (!entry) {
        // 是不是打赏自己的消息？（speakerOf 会跳过 self 条目）
        const raw = Array.isArray(ctx?.session?.triggerEntries) ? ctx.session.triggerEntries : ctx.session?.trigger;
        const hit = (Array.isArray(raw) ? raw : []).find((e) => e && String(e.mid ?? `local:${e.id}`) === String(args?.messageId ?? ''));
        return {
          content: JSON.stringify({ ok: false, reason: hit?.self ? '不能打赏自己的消息' : '找不到这条消息的发言人，请用本轮真实消息的 #消息id' }),
          isError: true
        };
      }
      const userId = String(entry.senderId || '').trim();
      if (!/^[1-9]\d{4,11}$/.test(userId)) {
        return { content: JSON.stringify({ ok: false, reason: '这条消息没有可用的 QQ 号' }), isError: true };
      }
      if (userId === String(ctx?.selfId || '')) {
        return { content: JSON.stringify({ ok: false, reason: '不能打赏自己' }), isError: true };
      }

      const s = conf();
      const mid = String(entry.mid ?? `local:${entry.id}`);
      const day = dayKey();

      // 这条消息已经打赏过？（比幂等重放更早拦住，免得重复计数）
      const preLogs = storage?.get(logKey(scope), []);
      if (Array.isArray(preLogs) && preLogs.some((x) => String(x.mid) === mid)) {
        return { content: JSON.stringify({ ok: false, reason: '这条消息已经打赏过了' }), isError: true };
      }

      // 本群当天笔数
      const dayRecord = storage?.get(dayKeyOf(scope, day), { count: 0 });
      if (num(dayRecord?.count, 0, 0, 10000) >= s.maxPerDay) {
        return { content: JSON.stringify({ ok: false, reason: `本群今天已经打赏 ${dayRecord.count} 笔，到上限了`, limit: s.maxPerDay }), isError: true };
      }
      // 同一个人的冷却
      const last = storage?.get(lastKey(scope, userId), null);
      if (s.minGapMinutes > 0 && last?.at && Date.now() - Number(last.at) < s.minGapMinutes * 60000) {
        const mins = Math.ceil((s.minGapMinutes * 60000 - (Date.now() - Number(last.at))) / 60000);
        return { content: JSON.stringify({ ok: false, reason: `刚打赏过 TA，还要等 ${mins} 分钟`, cooldownMinutes: s.minGapMinutes }), isError: true };
      }

      const amount = num(args?.amount, s.amount, 1, s.amount);   // 模型想加码也只能到上限
      const reason = String(args?.reason || '发言有意思').slice(0, 80);
      const requestId = `打赏:${scope}:${mid}`;

      let receipt = null;
      if (s.source === 'bot') {
        const from = String(ctx?.selfId || '');
        const moved = currency.transfer({ scope, fromUserId: from, toUserId: userId, amount, requestId: `${requestId}:自付`, reason: `打赏：${reason}` });
        if (!moved?.ok) {
          return { content: JSON.stringify({ ok: false, reason: `机器人自己余额不够或转账失败：${moved?.message || moved?.code || ''}` }), isError: true };
        }
        receipt = moved.receipt;
      } else {
        const credited = currency.credit({ scope, userId, amount, requestId, reason: `打赏：${reason}` });
        if (!credited?.ok) {
          return { content: JSON.stringify({ ok: false, reason: credited?.message || credited?.code || '记账失败' }), isError: true };
        }
        receipt = credited.receipt;
      }

      // 记账成功后再更新冷却/计数/日志（幂等重放会走上面的重复提交，不会重复计数）
      storage?.set(lastKey(scope, userId), { at: Date.now(), amount, mid });
      storage?.set(dayKeyOf(scope, day), { count: num(dayRecord?.count, 0, 0, 10000) + 1, day });
      const logs = storage?.get(logKey(scope), []);
      const list = Array.isArray(logs) ? logs : [];
      list.push({ at: Date.now(), userId, name: String(entry.senderName || ''), amount, reason, mid, source: s.source, receiptId: receipt?.id ?? null });
      storage?.set(logKey(scope), list.slice(-200));

      const bal = currency.balance({ scope, userId });
      return {
        content: JSON.stringify({
          ok: true,
          amount,
          unit: unit(),
          userId,
          name: String(entry.senderName || ''),
          balance: bal?.ok ? bal.balance : null,
          reason,
          todayCount: num(dayRecord?.count, 0, 0, 10000) + 1,
          note: '打赏已记账。想说话就再用 send_message 自然带一句（别每条都播报），不想说就不说。'
        })
      };
    }
  });
}

/** 面板：本群打赏记录 + 今日用量。 */
export async function handleUiRequest({ action, payload } = {}) {
  if (action !== 'tips') return { ok: false, error: `未知动作：${action}` };
  const scope = String(payload?.chatKey || payload?.scope || '');
  if (!/^group:\d+$/.test(scope)) return { ok: false, error: '需要 chatKey（group:123456）' };
  const s = conf();
  const day = dayKey();
  const dayRecord = storage?.get(dayKeyOf(scope, day), { count: 0 });
  const rows = (() => {
    const raw = storage?.get(logKey(scope), []);
    return Array.isArray(raw) ? [...raw].reverse() : [];
  })();
  return {
    ok: true,
    unit: unit(),
    settings: s,
    today: { day, count: num(dayRecord?.count, 0, 0, 10000), limit: s.maxPerDay },
    rows: rows.slice(0, 100)
  };
}
