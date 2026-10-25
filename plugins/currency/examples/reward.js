/**
 * 接入示例，不会自动执行。调用者从自己的可信任务记录取得 eventId、用户和金额。
 * 主人配置：{"quest-reward":["credit"]}
 * eventId 是业务事件 ID，必须在第一次请求前保存；不要每次重试生成一个新 ID。
 */
export async function grantReward(api, { scope, userId, eventId, amount }) {
  const currency = api.capability('currency.v1', { consumer: 'quest-reward' });
  if (!currency || currency.apiVersion !== 1) return { ok: false, code: 'UNAVAILABLE', message: '货币系统未启用。' };
  return await currency.credit({ scope, userId, amount, requestId: `reward:${eventId}`, reason: '任务奖励' });
}
