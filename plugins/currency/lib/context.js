import { fail, scope, userId } from './validation.js';

export function chatScope(ctx) {
  const chat = scope(ctx?.chatKey);
  if (chat !== `${ctx.kind}:${ctx.chatId}`) fail('INVALID_CONTEXT', '会话标识不一致。');
  if (ctx.session?.chatKey && ctx.session.chatKey !== chat) fail('INVALID_CONTEXT', '会话对象不属于当前聊天。');
  return chat;
}

export function assertSession(ctx) {
  if (!ctx?.session || ['done', 'noreply', 'error', 'aborted'].includes(ctx.session.status)) fail('INVALID_CONTEXT', '当前会话不存在或已结束。');
}

function messageId(value) {
  if (Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^(?:-?\d+|local:[1-9]\d*)$/.test(value)) fail('INVALID_ARGUMENT', 'messageId 必须是本轮真实消息编号。');
  return value;
}

export function requester(ctx, requestedMessageId, now = Date.now()) {
  assertSession(ctx);
  const raw = Array.isArray(ctx.session.triggerEntries) ? ctx.session.triggerEntries : ctx.session.trigger;
  if (!Array.isArray(raw) || ctx.proactive === true) fail('INVALID_CONTEXT', '没有本轮真实发言，不能确定操作人。');
  const entries = raw.filter(entry => entry && !entry.self && !entry.recalled && !entry.isPoke
    && String(entry.senderId) !== String(ctx.selfId));
  if (!entries.length || new Set(entries.map(entry => String(entry.senderId))).size !== 1) {
    fail('AMBIGUOUS_REQUESTER', '本轮发言者不唯一，请操作人单独 @ 机器人重新提出请求。');
  }
  const actor = userId(entries[0].senderId);
  if (ctx.kind === 'private' && actor !== String(ctx.chatId)) fail('INVALID_CONTEXT', '私聊发言者与会话不一致。');
  if (requestedMessageId === undefined) return { userId: actor };
  const id = messageId(requestedMessageId);
  const matches = entries.filter(entry => String(entry.mid ?? `local:${entry.id}`) === id);
  if (matches.length !== 1) fail('INVALID_CONTEXT', '消息编号无法唯一对应本轮实际发言。');
  const entry = matches[0];
  if (!Number.isSafeInteger(entry.ts) || entry.ts < now - 86400000 || entry.ts > now + 60000) fail('INVALID_CONTEXT', '请求消息过旧或时间无效，请重新发送。');
  return { userId: actor, messageId: id };
}
