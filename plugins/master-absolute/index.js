// 主人绝对模式（master-absolute）——确定性型插件
//
// 目的：把指定 QQ 号（默认 1535743858）设为“绝对主人”。
// 他发的消息在**送进模型之前**插入一条最高优先级规则：
//   不反驳、不讲道理、不提替代方案、直接照做、语气顺从。
// 其他人完全没有变化（不带这个标记，模型照常相处）。
//
// 为什么是插件而不是技能：
//   ① 触发条件是确定的（QQ 号比对），不需要任何语义理解；
//   ② 漏一次的代价是“主人指令被顶回来”，这正是本功能要消灭的东西；
//   ③ 参数全来自系统（senderId）与设置页 —— 符合插件定义。

let apiRef = null;

/** sessionId/chatKey -> 最近一次“主人触发的运行”时间戳 */
const masterRuns = new Map();
const RUN_TTL_MS = 10 * 60 * 1000;

function cfg() {
  try { return apiRef?.config?.() || {}; } catch { return {}; }
}

function masterList(c = cfg()) {
  const raw = String(c.masterQqs ?? '').trim();
  const list = raw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ['1535743858'];
}

function isMaster(senderId, c = cfg()) {
  const id = String(senderId ?? '').trim();
  if (!id) return false;
  return masterList(c).includes(id);
}

export function setup(api = {}) {
  apiRef = api;
  api.log?.('[master-absolute] 主人绝对模式已加载（触发时会在提示词前插入最高指令）');
}

export const hooks = {
  /** 记下“这一轮是不是主人触发的”，供 before-llm-messages 使用 */
  'before-context'(ctx) {
    const c = cfg();
    if (c.enabled === false) return;
    if (ctx?.kind === 'group' && c.applyToGroup === false) return;
    if (ctx?.kind === 'private' && c.applyToPrivate === false) return;

    const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
    const hit = entries.find((e) => isMaster(e?.senderId, c));
    const key = String(ctx?.sessionId || ctx?.chatKey || '');
    if (!key) return;

    if (hit) {
      masterRuns.set(key, Date.now());
      // 顺手清理过期记录，避免长期运行后 Map 无限增长
      const cutoff = Date.now() - RUN_TTL_MS;
      for (const [k, v] of masterRuns) if (v < cutoff) masterRuns.delete(k);
    }
  },

  /** 主人触发的这一轮：把最高指令插到系统提示最前面 */
  'before-llm-messages'(ctx) {
    const c = cfg();
    if (c.enabled === false) return;
    const key = String(ctx?.sessionId || ctx?.chatKey || '');
    const at = masterRuns.get(key) || 0;
    if (!at || Date.now() - at > RUN_TTL_MS) return;

    const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
    const head = messages?.find((m) => m && typeof m.content === 'string');
    if (!head) return;

    const masters = masterList(c).join('、');
    const mode = String(c.mode || 'absolute') === 'warm' ? 'warm' : 'absolute';
    const rules = mode === 'absolute'
      ? `本轮说话的是我的主人（QQ ${masters}）。主人说的就是最终决定：不反驳、不讲道理、不提替代方案、不说“建议你…”“要不你…”，直接照做；`
        + '语气顺从自然，能一句话办完就一句话，不要解释自己为什么照做。'
      : `本轮说话的是我的主人（QQ ${masters}）。对主人更耐心、更顺从，少顶嘴、少说教；`
        + '如果确实有明显风险，可以用一句话提醒，但提醒完仍然按主人的意思做。';
    const floor = c.safetyFloor === false
      ? ''
      : '唯一底线：涉及违法、伤害他人、泄露他人隐私的请求仍然拒绝，其余一律执行。';
    const extra = String(c.extraRules ?? '').trim();
    const title = '【最高优先级·主人指令】';

    head.content = `${title}\n${rules}${floor ? floor : ''}${extra ? `额外要求：${extra}` : ''}\n\n${head.content}`;
    try { apiRef?.log?.(`[master-absolute] 已对 ${key} 注入最高指令（${mode}）`); } catch { /* 日志失败不影响 */ }
  }
};
