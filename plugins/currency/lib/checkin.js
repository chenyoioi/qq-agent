// 每日签到（合并进经济系统后的模块）
// 每日签到（LLM 型工具 + 货币能力消费方）
//
// 设计要点（都是踩过的坑）：
//   · 幂等键固定成 `签到:<QQ>:<日期>`：模型重试、热重载、同一句被触发两次都不会重复发钱
//     （货币插件按 consumer+scope+requestId 去重，重放会返回 replayed）。
//   · 日期用本地时区的"业务日"（resetHour 之前算前一天），不用 Date.now() 毫秒。
//   · 连签天数只以本地存储为准；金币本身存在货币插件里，这里不重复记账。
//   · 货币不可用（插件被停用/没授权）时如实返回错误，不要让模型假装签到成功。

const DEFAULTS = {
  baseReward: 20,
  streakBonus: 5,
  maxBonus: 50,
  resetHour: 0,
  announceRank: true
};

const num = (v, fallback, min, max) => {
  const n = Math.floor(Number(v ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** 业务日：resetHour 之前算前一天，返回 YYYY-MM-DD。 */
function businessDate(now = new Date(), resetHour = 0) {
  const d = new Date(now.getTime());
  if (d.getHours() < resetHour) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

let hostApi = null;
let storage = null;
// 内存里的"今天谁签过"缓存，避免每次都读盘；进程重启后由 storage 兜底
const memory = new Map();
const K = (k) => `chk:${k}`;

function readSettings() {
  const c = (() => { try { return hostApi?.config?.() ?? {}; } catch { return {}; } })();
  return {
    baseReward: num(c.checkinBaseReward ?? c.baseReward, DEFAULTS.baseReward, 1, 100000),
    streakBonus: num(c.checkinStreakBonus ?? c.streakBonus, DEFAULTS.streakBonus, 0, 10000),
    maxBonus: num(c.checkinMaxBonus ?? c.maxBonus, DEFAULTS.maxBonus, 0, 100000),
    resetHour: num(c.checkinResetHour ?? c.resetHour, DEFAULTS.resetHour, 0, 23),
    announceRank: (c.checkinAnnounceRank ?? c.announceRank) !== false
  };
}

function money() {
  const api = hostApi?.capability?.('currency.v1', { consumer: 'checkin' });
  return api && api.apiVersion === 1 ? api : null;
}

function loadUser(scope, userId) {
  const key = K(`user:${scope}:${userId}`);
  if (memory.has(key)) return memory.get(key);
  const saved = storage?.get(key, null);
  const value = saved && typeof saved === 'object'
    ? { lastDate: String(saved.lastDate || ''), streak: num(saved.streak, 0, 0, 100000), total: num(saved.total, 0, 0, 1e12) }
    : { lastDate: '', streak: 0, total: 0 };
  memory.set(key, value);
  return value;
}

function saveUser(scope, userId, value) {
  const key = K(`user:${scope}:${userId}`);
  memory.set(key, value);
  storage?.set(key, value);
}

export function register(api) {
  hostApi = api;
  storage = api.storage;

  api.registerTool({
    id: 'checkin',
    name: '每日签到',
    category: 'economy',
    description: '群友说「签到/打卡/领金币」时调用。每天只能签一次，连签有加成。工具只算账不发消息，结果要用 send_message 自然转述给对方。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx, args = {}) {
      if (args && Object.keys(args).length) {
        return { content: JSON.stringify({ ok: false, reason: '签到不接受参数' }), isError: true };
      }
      const chatKey = String(ctx?.chatKey || '');
      const userId = String(ctx?.sender?.userId || ctx?.senderId || '').trim();
      if (!chatKey || !/^[1-9]\d{4,11}$/.test(userId)) {
        return { content: JSON.stringify({ ok: false, reason: '拿不到当前会话或发言人的 QQ 号，无法签到' }), isError: true };
      }
      const currency = money();
      if (!currency) {
        return { content: JSON.stringify({ ok: false, reason: '货币系统未启用或未给 checkin 授权，签到暂时不可用' }), isError: true };
      }

      const s = readSettings();
      const today = businessDate(new Date(), s.resetHour);
      const state = loadUser(chatKey, userId);

      if (state.lastDate === today) {
        const bal = currency.balance({ scope: chatKey, userId });
        return {
          content: JSON.stringify({
            ok: true,
            alreadyChecked: true,
            streak: state.streak,
            balance: bal?.ok ? bal.balance : null,
            note: '今天已经签过了，不要重复发放，也不要编造奖励。'
          })
        };
      }

      const streak = state.lastDate === yesterdayOf(today) ? state.streak + 1 : 1;
      const bonus = Math.min(s.maxBonus, Math.max(0, (streak - 1) * s.streakBonus));
      const reward = s.baseReward + bonus;

      // requestId 固定成「签到:QQ:日期」——重放安全
      const credited = currency.credit({
        scope: chatKey,
        userId,
        amount: reward,
        requestId: `签到:${userId}:${today}`,
        reason: '每日签到'
      });
      if (!credited?.ok) {
        return {
          content: JSON.stringify({ ok: false, reason: credited?.message || credited?.code || '发放失败，稍后再试' }),
          isError: true
        };
      }

      const next = { lastDate: today, streak, total: state.total + reward };
      saveUser(chatKey, userId, next);
      const bal = s.announceRank ? currency.balance({ scope: chatKey, userId }) : null;

      return {
        content: JSON.stringify({
          ok: true,
          alreadyChecked: false,
          reward,
          bonus,
          streak,
          balance: bal?.ok ? bal.balance : null,
          replayed: credited.receipt?.replayed === true,
          note: '签到成功。用一两句自然的话告诉对方拿到多少、连签几天，别念 JSON。'
        })
      };
    }
  });

}

/** 面板只读视图：今天谁签了、连签榜。 */
export async function ui({ action, payload } = {}) {
  if (action !== 'status') return { ok: false, error: `未知动作：${action}` };
  const chatKey = String(payload?.chatKey || '');
  if (!/^group:\d+$|^private:\d+$/.test(chatKey)) return { ok: false, error: '需要 chatKey（group:123456）' };
  const rows = [];
  const all = storage?.all?.() ?? {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(K('user:' + chatKey + ':'))) continue;
    const userId = key.slice(K('user:' + chatKey + ':').length);
    rows.push({ userId, lastDate: String(value?.lastDate || ''), streak: num(value?.streak, 0, 0, 100000), total: num(value?.total, 0, 0, 1e12) });
  }
  rows.sort((a, b) => b.streak - a.streak || b.total - a.total);
  return { ok: true, today: businessDate(new Date(), readSettings().resetHour), rows: rows.slice(0, 100) };
}

export function deactivate() { memory.clear(); }
export function dispose() { memory.clear(); }
