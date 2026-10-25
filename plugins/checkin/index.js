// 每日签到（确定性插件：不走模型）
//
// 群里有人发「签到 / 打卡 / 领金币」→ onMessage 钩子里直接记账 + 回复，
// 然后把这条消息标成已读：调度器后面 drainUnread 时看到没有未读，就不会再叫模型
// （既不重复回复，也不花 token）。
//
// 幂等：requestId 固定成「签到:<QQ>:<业务日>」，同一天重复触发、失败重试都不会多发。
const DEFAULTS = { baseReward: 20, streakBonus: 5, maxBonus: 50, resetHour: 0, showBalance: true };
const TRIGGERS = ['签到', '打卡', '领金币', '每日签到', '签到一下'];

const num = (v, fallback, min, max) => {
  const n = Math.floor(Number(v ?? fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** 业务日：resetHour 之前算前一天。 */
function businessDate(now = new Date(), resetHour = 0) {
  const d = new Date(now.getTime());
  if (d.getHours() < resetHour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function yesterdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** 去掉 @、CQ 码、空白和标点，只留正文，方便精确匹配触发词。 */
function cleanText(text) {
  return String(text || '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/[，。！？、,.!?~～\s]/g, '')
    .trim();
}

let hostApi = null;
let storage = null;
let log = () => {};

function conf() {
  const c = (() => { try { return hostApi?.config?.() ?? {}; } catch { return {}; } })();
  return {
    baseReward: num(c.baseReward, DEFAULTS.baseReward, 1, 100000),
    streakBonus: num(c.streakBonus, DEFAULTS.streakBonus, 0, 10000),
    maxBonus: num(c.maxBonus, DEFAULTS.maxBonus, 0, 100000),
    resetHour: num(c.resetHour, DEFAULTS.resetHour, 0, 23),
    showBalance: c.showBalance !== false
  };
}

function money() {
  const api = hostApi?.capability?.('currency.v1', { consumer: 'checkin' });
  return api && api.apiVersion === 1 ? api : null;
}

const keyOf = (scope, userId) => `user:${scope}:${userId}`;

export function setup(api) {
  hostApi = api;
  storage = api.storage;
  log = api.log || (() => {});
}

async function reply(ctx, text) {
  try {
    // 确定性命令的回复不能被"每分钟 3 条"这类限流吞掉：开一个短豁免窗口
    // （群友连发几条别的消息时，签到回复仍发得出去）
    ctx?.sender?.allowRateBypass?.(ctx.chatKey, 5000);
    if (typeof ctx?.sender?.sendTextBatch === 'function') await ctx.sender.sendTextBatch(ctx.chatKey, text, {});
  } catch (error) {
    log(`签到回复失败：${error?.message ?? error}`);
  }
}

/** 标已读：调度器 drainUnread 时就不会再为这条叫模型。 */
function markHandled(ctx) {
  try { ctx?.store?.markEntryRead?.(ctx.chatKey, ctx?.entry?.id); } catch { /* 忽略 */ }
}

export const hooks = {
  async onMessage(ctx) {
    const text = cleanText(ctx?.text);
    if (!text || !TRIGGERS.includes(text)) return;
    if (!/^group:\d+$/.test(String(ctx?.chatKey || ''))) return;   // 只在群里签
    const userId = String(ctx?.senderId || '').trim();
    if (!/^[1-9]\d{4,11}$/.test(userId)) return;

    const currency = money();
    if (!currency) return;                       // 货币没启用就交给模型处理
    const s = conf();
    const today = businessDate(new Date(), s.resetHour);
    const k = keyOf(ctx.chatKey, userId);
    const state = storage?.get(k, null) || {};
    const lastDate = String(state.lastDate || '');
    const streakOld = num(state.streak, 0, 0, 100000);

    // 今天已经签过：直接回一句，不再记账
    if (lastDate === today) {
      const bal = s.showBalance ? currency.balance({ scope: ctx.chatKey, userId }) : null;
      const suffix = bal?.ok ? `，余额 ${bal.balance}` : '';
      await reply(ctx, `今天已经签过啦（连签 ${streakOld} 天${suffix}），明天再来`);
      markHandled(ctx);
      return;
    }

    const streak = lastDate === yesterdayOf(today) ? streakOld + 1 : 1;
    const bonus = Math.min(s.maxBonus, Math.max(0, (streak - 1) * s.streakBonus));
    const reward = s.baseReward + bonus;

    const credited = currency.credit({
      scope: ctx.chatKey,
      userId,
      amount: reward,
      requestId: `签到:${userId}:${today}`,
      reason: '每日签到'
    });
    if (!credited?.ok) {
      log(`签到记账失败：${credited?.message || credited?.code || '未知'}`);
      await reply(ctx, '签到这会儿没记上，等会儿再试一下');
      return;                                    // 没记账就不标已读
    }

    storage?.set(k, { lastDate: today, streak, total: num(state.total, 0, 0, 1e12) + reward });
    const bal = s.showBalance ? currency.balance({ scope: ctx.chatKey, userId }) : null;
    const bits = [`签到成功 +${reward} 金币`];
    bits.push(bonus > 0 ? `连签 ${streak} 天加成 ${bonus}` : `连签 ${streak} 天`);
    if (bal?.ok) bits.push(`余额 ${bal.balance}`);
    await reply(ctx, bits.join('，'));
    markHandled(ctx);
  }
};

/** 面板：签到榜（只读）。 */
export async function handleUiRequest({ action, payload } = {}) {
  if (action !== 'status') return { ok: false, error: `未知动作：${action}` };
  const scope = String(payload?.chatKey || payload?.scope || '');
  if (!/^group:\d+$|^private:\d+$/.test(scope)) return { ok: false, error: '需要 chatKey（group:123456）' };
  const all = storage?.all?.() ?? {};
  const rows = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(`user:${scope}:`)) continue;
    rows.push({
      userId: key.slice(`user:${scope}:`.length),
      lastDate: String(value?.lastDate || ''),
      streak: num(value?.streak, 0, 0, 100000),
      total: num(value?.total, 0, 0, 1e12)
    });
  }
  rows.sort((a, b) => b.streak - a.streak || b.total - a.total);
  return { ok: true, today: businessDate(new Date(), conf().resetHour), rows: rows.slice(0, 100) };
}
