// 每日签到（确定性插件：不走模型）
//
// 群里有人发「签到 / 打卡 / 领金币」→ onMessage 钩子里直接记账 + 回复，
// 然后把这条消息标成已读：调度器后面 drainUnread 时看到没有未读，就不会再叫模型
// （既不重复回复，也不花 token）。
//
// 幂等：requestId 固定成「签到:<QQ>:<业务日>」，同一天重复触发、失败重试都不会多发。
const DEFAULTS = { baseReward: 20, streakBonus: 5, maxBonus: 50, resetHour: 0, showBalance: true, recallAfterSec: 10 };
const TRIGGERS = ['签到', '打卡', '领金币', '每日签到', '签到一下'];
// 查自己余额（同样不走模型：问一句就把数字报出来）
const QUERY_TRIGGERS = [
  '余额', '我的余额', '查余额', '余额查询', '我有多少金币', '我多少金币',
  '有多少金币', '金币余额', '我的金币', '金币'
];

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
    showBalance: c.showBalance !== false,
    recallAfterSec: num(c.recallAfterSec, DEFAULTS.recallAfterSec, 0, 600)   // 0 = 不撤回
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

/** 「余额 / 我的金币」：报自己的余额 + 连签 + 今天签没签。 */
async function replyBalance(ctx, { currency, userId, conf: s }) {
  const bal = currency.balance({ scope: ctx.chatKey, userId });
  if (!bal?.ok) {
    await reply(ctx, '余额这会儿查不到，等会儿再试');
    return;
  }
  const unit = (() => {
    try { const info = currency.info?.(); return info?.currencyName ? String(info.currencyName) : '金币'; } catch { return '金币'; }
  })();
  const bits = [`你现在有 ${bal.balance} ${unit}`];
  if (Number(bal.held) > 0) bits.push(`其中冻结 ${bal.held}，可用 ${bal.available}`);
  const state = storage?.get(keyOf(ctx.chatKey, userId), null) || {};
  const today = businessDate(new Date(), s.resetHour);
  const streak = num(state.streak, 0, 0, 100000);
  if (streak > 0) bits.push(`签到连签 ${streak} 天（今天${state.lastDate === today ? '已签' : '还没签'}）`);
  else bits.push('还没签到过，发「签到」领金币');
  await reply(ctx, bits.join('，'));
}

async function reply(ctx, text) {
  try {
    // 确定性命令的回复不能被"每分钟 3 条"这类限流吞掉：开一个短豁免窗口
    // （群友连发几条别的消息时，签到回复仍发得出去）
    ctx?.sender?.allowRateBypass?.(ctx.chatKey, 5000);
    if (typeof ctx?.sender?.sendTextBatch !== 'function') return null;
    let out = null;
    try {
      out = await ctx.sender.sendTextBatch(ctx.chatKey, text, {});
    } catch (error) {
      // 发送偶发被 QQ 挡回（风控抖动）：等一秒再试一次；禁言这类硬失败会在第二次照样抛
      await new Promise((r) => setTimeout(r, 1200));
      out = await ctx.sender.sendTextBatch(ctx.chatKey, text, {});
      log(`重试后仍失败：${error?.message ?? error}`);
    }
    const messageId = out?.sent?.[0]?.messageId ?? null;
    scheduleRecall(messageId, ctx.chatKey);
    return messageId;
  } catch (error) {
    log(`签到回复失败：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 发完 N 秒后撤回（默认 10 秒，设置里可改；0 = 不撤回）。
 * 用 api.onebot 的 delete_msg；发出去就立即撤会让群友看不到，所以只做延时撤回。
 */
function scheduleRecall(messageId, chatKey) {
  const sec = conf().recallAfterSec;
  if (!sec || !messageId) return;
  const timer = setTimeout(async () => {
    const client = hostApi?.onebot;
    if (!client?.call) { log('撤回跳过：没有可用的 OneBot 客户端'); return; }
    try {
      await client.call('delete_msg', { message_id: messageId }, 8000, { noExplain: true });
    } catch (error) {
      log(`撤回失败（${chatKey} / ${messageId}）：${error?.message ?? error}`);
    }
  }, sec * 1000);
  timer.unref?.();      // 别拖住进程退出
}

/** 标已读：调度器 drainUnread 时就不会再为这条叫模型。 */
function markHandled(ctx) {
  try { ctx?.store?.markEntryRead?.(ctx.chatKey, ctx?.entry?.id); } catch { /* 忽略 */ }
}

export const hooks = {
  async onMessage(ctx) {
    const text = cleanText(ctx?.text);
    if (!text) return;
    const isCheckin = TRIGGERS.includes(text);
    const isQuery = QUERY_TRIGGERS.includes(text);
    if (!isCheckin && !isQuery) return;
    if (!/^group:\d+$/.test(String(ctx?.chatKey || ''))) return;   // 只在群里签/查
    const userId = String(ctx?.senderId || '').trim();
    if (!/^[1-9]\d{4,11}$/.test(userId)) return;

    const currency = money();
    if (!currency) return;                       // 货币没启用就交给模型处理
    const s = conf();

    // 查余额：只报自己的（别人问他人的余额会让模型/面板去查，避免这里越权）
    if (isQuery) {
      await replyBalance(ctx, { currency, userId, conf: s });
      markHandled(ctx);
      return;
    }
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
