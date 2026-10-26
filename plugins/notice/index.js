// 群通知：主人发「通知 具体内容」，机器人立刻 @全员 说一遍。
//
// 确定性插件（不走模型）：命中就直接发，0 token、秒回；只有主人（persona.masterQQ）能发。
// 想发长文/排版好的内容，用控制台的「群通知」页编辑后发送（走 api.sender）。
import { getConfig } from '../../src/config.js';

const DEFAULTS = { header: '📢 群通知', atAll: true, allowTargetGroup: true };
// 触发词：「通知 xxx」「公告 xxx」「群通知 xxx」「发通知 xxx」
const CMD = /^(?:发)?(?:群)?(?:通知|公告)[\s:：]*(.*)$/s;

let hostApi = null;
let storage = null;
let log = () => {};

function conf() {
  const c = (() => { try { return hostApi?.config?.() ?? {}; } catch { return {}; } })();
  return {
    header: String(c.header ?? DEFAULTS.header).slice(0, 40),
    atAll: c.atAll !== false,
    allowTargetGroup: c.allowTargetGroup !== false
  };
}

function masterQQ() {
  try { return String(getConfig().persona?.masterQQ || '').trim(); } catch { return ''; }
}

const logKey = (scope) => `notices:${scope}`;

function record(scope, item) {
  const raw = storage?.get(logKey(scope), []);
  const list = Array.isArray(raw) ? raw : [];
  list.push(item);
  storage?.set(logKey(scope), list.slice(-100));
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

/** 组装最终要发出去的那段文字：开头那句 + 正文。 */
function compose(content, { header }) {
  const body = String(content || '').trim();
  if (!body) return '';
  return header ? `${header}\n${body}` : body;
}

export const hooks = {
  async onMessage(ctx) {
    const master = masterQQ();
    if (!master || String(ctx?.senderId || '') !== master) return;   // 只有主人能发
    const text = cleanText(ctx?.text);
    const m = CMD.exec(text);
    if (!m) return;
    if (!/^group:\d+$/.test(String(ctx?.chatKey || ''))) return;     // 只在群里发

    const s = conf();
    let content = String(m[1] || '').trim();
    let chatKey = ctx.chatKey;

    // 「通知 571522597 内容」→ 发到指定群（必须在白名单里）
    const target = /^(\d{6,12})\s+([\s\S]+)$/.exec(content);
    if (s.allowTargetGroup && target) {
      const gid = target[1];
      const allowed = (() => {
        try { return (getConfig().allow?.groups || []).map(String).includes(gid); } catch { return false; }
      })();
      if (allowed) { chatKey = `group:${gid}`; content = target[2].trim(); }
    }

    if (!content) {
      await say(ctx, '要通知什么？发「通知 具体内容」就行');
      markHandled(ctx);
      return;
    }

    const sent = await sendNotice(chatKey, compose(content, s), { atAll: s.atAll, sender: ctx.sender });
    if (!sent.ok) {
      await say(ctx, `通知没发出去：${sent.error || '未知原因'}`);
      markHandled(ctx);
      return;
    }
    record(chatKey, { at: Date.now(), by: String(ctx.senderId), content, atAll: s.atAll, messageId: sent.messageId ?? null, from: 'chat' });
    markHandled(ctx);
  }
};

/** 统一发送：优先用调用方给的队列（钩子里有），否则用 api.sender（面板里用）。 */
async function sendNotice(chatKey, text, { atAll, sender } = {}) {
  const q = sender || hostApi?.sender;
  if (!q?.sendTextBatch) return { ok: false, error: '没有可用的发送队列' };
  try {
    q.allowRateBypass?.(chatKey, 5000);            // 主人通知不吃闲聊限流
    const out = await q.sendTextBatch(chatKey, text, { atAll: atAll === true });
    return { ok: true, messageId: out?.sent?.[0]?.messageId ?? null };
  } catch (error) {
    log(`通知发送失败：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function say(ctx, text) {
  try { await ctx?.sender?.sendTextBatch?.(ctx.chatKey, text, {}); } catch { /* 忽略 */ }
}
function markHandled(ctx) {
  try { ctx?.store?.markEntryRead?.(ctx.chatKey, ctx?.entry?.id); } catch { /* 忽略 */ }
}

/** 面板：发送记录 + 手动发送。 */
export async function handleUiRequest({ action, payload } = {}) {
  const s = conf();
  if (action === 'list') {
    const scope = String(payload?.chatKey || '');
    if (!/^group:\d+$/.test(scope)) return { ok: false, error: '需要 chatKey（group:123456）' };
    const raw = storage?.get(logKey(scope), []);
    return { ok: true, settings: s, rows: (Array.isArray(raw) ? [...raw] : []).reverse().slice(0, 50) };
  }
  if (action === 'send') {
    const scope = String(payload?.chatKey || '');
    if (!/^group:\d+$/.test(scope)) return { ok: false, error: '需要 chatKey（group:123456）' };
    const content = String(payload?.text || '').trim();
    if (!content) return { ok: false, error: '通知内容不能为空' };
    if (content.length > 2000) return { ok: false, error: '太长了（上限 2000 字）' };
    const atAll = payload?.atAll === undefined ? s.atAll : payload.atAll === true;
    const sent = await sendNotice(scope, compose(content, s), { atAll });
    if (!sent.ok) return { ok: false, error: sent.error };
    record(scope, { at: Date.now(), by: 'console', content, atAll, messageId: sent.messageId ?? null, from: 'console' });
    return { ok: true, messageId: sent.messageId ?? null, atAll, text: compose(content, s) };
  }
  return { ok: false, error: `未知动作：${action}` };
}
