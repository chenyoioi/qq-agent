// 合并转发展开（修复版） —— 让机器人真正读懂「合并转发聊天记录」。
//
// ── 为什么需要这个插件（根因，两份日志定位到的） ──────────────────────
// 用户点开的转发「是空的」，日志里成对出现：
//   SnowLuma : get_forward_msg failed: download forward message payload is empty
//   本体     : [ingest] 展开合并转发失败（保留占位符）: retcode=100 ...
//
// 根因不是"QQ 服务端把内容丢了"，而是**传错了参数**：
//   · 本体 app.js:878 / tools.js:502 传的是 { message_id }，而 OneBot 事件里的
//     message_id 在协议端是**消息哈希**，可以是负数（实测 -973329211）。
//   · 协议端 get_forward_msg 的实现（snowluma/config-*.js:8315-8339）只认字符串 `id`：
//       - message_id > 0 → 拿它去消息库取原始段，从转发段 data.id 里读真实 id；
//       - message_id < 0 → **跳过换段这一步**，直接把 "-973329211" 当 resId 去
//         长消息服务下载 → 服务端当然回空 payload。
//   · 而真实 id 一直就在消息段里（snowluma/index.mjs:3199）：
//       { type:'forward', data:{ id:'zhojjjYRU5dGWvPAy6doNE+W5Yc5ctvsGlTCfRN9/qjcBa/...' } }
//
// 本人已在本机 messages.db 里只读取证过这条真实消息，段内确实带可用 id。
//
// ── 本插件怎么修 ──────────────────────────────────────────────────────
// ① 解析出真实 id：message_id 是负数（或明显不是 res_id 的正数）时，先用 get_msg
//    取回原始消息段，从 forward 段的 data.id / res_id / forward_id 里读出真实 id。
// ② 用真实 id 调 get_forward_msg(id) 拿回节点数组。
// ③ 把节点数组转成可读文本，写回存档（一次展开，永久生效）。
//
// ── 为什么是"插件"而不是"技能"（按 plugin-development.md §0 三问） ──
//   一、触发时机能写死：`if (消息里有 forward 段 || 文本含 [合并转发…)` → 能
//   二、漏一次的代价：转发内容整段丢失、模型只能干瞪眼或瞎编 → 丢数据，必须确定性
//   三、参数从哪来：真实 id 由协议端给（不需要理解人话）→ 系统给
//   三问一致 → 确定性型 → plugins/。同时它也给模型一个工具（§1.1：两型清单等价，
//   插件同样能 registerTool），所以"模型主动展开"和"确定性修复"两条路都覆盖。
//
// ── 硬约束遵守情况（§3.2 / §10 自检清单） ─────────────────────────────
//   · 钩子里**没有**网络请求：before-context 只做字符串加工，after 不做事
//     （5 秒超时会跳过，网络请求一律放在工具/能力里）
//   · 发消息走 ctx.sender（并未在此插件里主动发消息）
//   · 操作 QQ 只用只读接口 get_msg / get_forward_msg，且每个 call 都 try/catch
//   · available() 是同步的
//   · 没有在 setup 里启动任何需要 deactivate 清理的东西
//   · 清单不带 BOM；id 只用小写英文与连字符

let cfg = () => ({});
let log = () => {};
/** 本插件注册后工具的全名（setup 里由 registerTool 返回，带 skillId__ 前缀）。 */
let MY_TOOL = 'forward-reader__expand';

/** 转发占位符（本体 onebot.js:490 与 552 产出的两种形态）。 */
const PLACEHOLDER_RE = /\[合并转发聊天记录\]|\[转发消息[^\]]*\]/g;
/** 已展开文本的前缀（本体 onebot.js:563 的 head 格式）。 */
const EXPANDED_PREFIX = '[合并转发 共';
/** 读不到时的标注：明确告诉模型"没读到"，防止它照着上下文瞎编。 */
const UNREADABLE_MARK = '[合并转发聊天记录·插件未能读取]';

const MIN_REASONABLE_MID = 1000;   // 真实 message_id 至少这个量级；更小的当 res_id 用

// ── 小工具 ────────────────────────────────────────────────────────────

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function stripCq(text) {
  return String(text ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim();
}

/**
 * 从一条原始消息里找出转发段携带的真实 id（res_id）。
 * 字段名在不同协议端之间漂移，所以四个都认。
 */
function forwardIdOf(segments) {
  if (!Array.isArray(segments)) return '';
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'forward') continue;
    const d = (seg.data && typeof seg.data === 'object') ? seg.data : {};
    const raw = d.id ?? d.res_id ?? d.forward_id ?? d.data_id;
    const s = raw == null ? '' : String(raw).trim();
    if (s) return s;
  }
  return '';
}

/** 从原始消息里收集图片（转发里的图也要能被取图工具看到）。 */
function collectMedia(segments, out) {
  if (!Array.isArray(segments)) return;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const d = (seg.data && typeof seg.data === 'object') ? seg.data : {};
    if (seg.type === 'image') {
      out.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'video') {
      out.push({ kind: 'video', file: String(d.file ?? ''), url: String(d.url ?? ''), path: String(d.path ?? '') });
    }
  }
}

/**
 * 单个消息段 → 文本。刻意**不**做语音转写（§3.2：转发链里逐条跑转写会把
 * ingest 串行阻塞住，代价不划算），保持占位符即可。
 */
function segToText(seg) {
  const d = (seg && typeof seg.data === 'object' && seg.data) ? seg.data : {};
  switch (seg?.type) {
    case 'text': return String(d.text ?? '');
    case 'at': return String(d.qq ?? '') === 'all' ? '@全体成员' : `@${String(d.qq ?? '')}`;
    case 'face': return `[表情${d.id ?? ''}]`;
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件${d.name ?? ''}]`;
    case 'reply': return '[引用消息]';
    case 'json': return '[卡片消息]';
    // 嵌套转发深度 1 封顶，套娃截断（与本体一致，避免无限膨胀）
    case 'forward': return '[转发消息]';
    default: return `[${seg?.type ?? '未知'}]`;
  }
}

/**
 * get_forward_msg 返回的节点数组 → 可读文本 + 图片。
 * 与本体 onebot.js:533 的 expandForwardNodes 同格式（含 [合并转发 共N条] 头），
 * 这样存档里两种来源的展开文本长得一样，read_forward 的"已展开"判定也能命中。
 *
 * @param {Array} nodes 节点数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
function nodesToText(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return null;
  const c = cfg();
  const maxNodes = clampInt(c.maxNodes, 50, 1, 200);
  const maxChars = clampInt(c.maxChars, 4000, 200, 20000);

  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < list.length; i++) {
    if (lines.length >= maxNodes) { truncated = list.length - i; break; }
    const n = list[i] || {};
    // 发言人带 QQ 号：转发记录里的人也要能被稳定识别（与主历史同口径）
    const rawName = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nid = String(n.sender?.user_id ?? n.user_id ?? '').trim();
    const name = (nid && nid !== rawName) ? `${rawName}(QQ:${nid})` : rawName;

    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      body = stripCq(nm);
    } else if (Array.isArray(nm)) {
      body = nm.map(segToText).join('');
      collectMedia(nm, media);
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = list.length - i - 1; break; }
  }

  const head = `[合并转发 共${list.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}

/** 从 OneBot 响应里取出节点数组（有的协议端把 messages 包在 data 里）。 */
function nodesOf(response) {
  if (Array.isArray(response?.messages)) return response.messages;
  if (Array.isArray(response?.data?.messages)) return response.data.messages;
  return [];
}

/**
 * 把 { message_id } 解析成协议端真正认的转发 id。
 *
 * 这是整个修复的核心：负数 message_id 直接当 resId 用，服务端一定回
 * "download forward message payload is empty"。必须先取原始段、读出段里的 id。
 */
async function resolveForwardId(onebot, messageId, notes) {
  const s = String(messageId ?? '').trim();
  if (!s) return '';
  // 非纯数字 → 本来就是 res_id（base64 形态），直接用
  if (!/^-?\d+$/.test(s)) return s;

  const n = Number(s);
  // 明显是消息哈希值（负数）或过小的正数 → 不能当 resId，必须先反查
  if (n >= MIN_REASONABLE_MID) return s;

  if (cfg().fallbackByGetMsg === false) return s;

  try {
    const raw = await onebot.call('get_msg', { message_id: n });
    const id = forwardIdOf(raw?.message);
    if (id) {
      notes.push(`已用 get_msg 反查真实 id（len=${id.length}）`);
      log(`message_id=${n} → 反查到真实转发 id（长度 ${id.length}）`);
      return id;
    }
    notes.push('get_msg 取回的原始段里没有 forward 段');
    log(`message_id=${n} 的原始消息里没有 forward 段，无法反查 id`);
  } catch (e) {
    notes.push(`get_msg 失败：${e?.message ?? e}`);
    log(`反查真实 id 失败（message_id=${n}）：${e?.message ?? e}`);
  }
  return '';
}

/**
 * 展开一条合并转发（同步能力 + 工具共用）。
 *
 * @returns {Promise<{ok:boolean, text?:string, media?:Array, expanded?:boolean,
 *                    fromStore?:boolean, error?:string, notes?:string[]}>}
 */
async function expandForward(onebot, messageId, store, chatKey) {
  const notes = [];
  const s = String(messageId ?? '').trim();
  if (!s) return { ok: false, error: '缺少 messageId（填那条消息的 #数字）', notes };

  // ① 存档里已经是展开文本 → 直接给，不再打扰 QQ
  let entry = null;
  try { entry = store?.findByMid?.(chatKey, s) ?? null; } catch { entry = null; }
  if (entry && String(entry.text || '').startsWith(EXPANDED_PREFIX)) {
    return { ok: true, text: entry.text, expanded: true, fromStore: true, notes: ['读的是存档，未请求 QQ'] };
  }

  // ② 解析真实 id
  const resId = await resolveForwardId(onebot, s, notes);
  if (!resId) {
    return {
      ok: false,
      error: `拿不到这条转发的真实 id —— ${notes.join('；') || '协议端没给出可用 id'}`,
      notes
    };
  }

  // ③ 用真实 id 取节点（失败要 try/catch：协议端失败会抛错）
  let response;
  try {
    response = await onebot.call('get_forward_msg', { id: String(resId) }, 30000);
  } catch (e) {
    return { ok: false, error: `get_forward_msg 失败：${e?.message ?? e}`, notes };
  }

  // ④ 节点 → 文本
  const nodes = nodesOf(response);
  if (!nodes.length) return { ok: false, error: '转发节点为空（QQ 服务端可能已丢弃这条记录）', notes };
  const ex = nodesToText(nodes);
  if (!ex?.text) return { ok: false, error: '转发内容为空或全部是空节点', notes };

  // ⑤ 写回存档：一次展开，永久生效（模型不用重复调、记忆整理也能看到）
  if (cfg().writeBack !== false) {
    try {
      store?.updateByMid?.(chatKey, s, { text: ex.text, appendMedia: ex.media || [] });
      notes.push('已写回存档');
    } catch (e) {
      notes.push(`写回存档失败（不影响本次读取）：${e?.message ?? e}`);
    }
  }

  log(`展开成功：messageId=${s}，共 ${nodes.length} 条，${ex.text.length} 字符`);
  return { ok: true, text: ex.text, media: ex.media || [], expanded: true, fromStore: false, notes };
}

// ── 生命周期 ──────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log(...a);

  // 给模型一个工具：什么时候用由模型判断（description 里写清楚时机）
  MY_TOOL = api.registerTool({
    id: 'expand',
    name: '展开合并转发（可靠版）',
    description:
      '读取「合并转发聊天记录」的完整内容。当消息里出现 [合并转发聊天记录]、'
      + '[转发消息 …] 或你说"这条转发点开是空的"时使用。参数填那条消息前面的 #数字'
      + '（可为负数，例如 -973329211），不是方括号里的长 id。'
      + '成功后会写回存档，同一条不要重复调用。',
    category: 'query',
    icon: '📨',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条转发消息的 #数字（可为负数）' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const r = await expandForward(ctx.onebot, args?.messageId, ctx.store, ctx.chatKey);
      if (!r.ok) return { content: `展开失败：${r.error}`, isError: true };
      const from = r.fromStore ? '（读的是存档，之前已展开过）' : '';
      return { content: `${r.text}\n\n${from}${r.notes?.length ? `[说明] ${r.notes.join('；')}` : ''}`.trim() };
    }
  });

  log('合并转发展开（修复版）已加载：'
    + '负数 message_id 会先经 get_msg 反查真实 id，再调 get_forward_msg 展开');
}

// ── 能力（别的扩展可用 api.capability('forward.expand') 取用） ────────

export const providers = {
  /**
   * 展开合并转发。
   * 入参由本插件自定义（核心不认识这个名字）—— 消费方按需取用：
   *   const r = api.capability('forward.expand', { onebot, messageId, store, chatKey });
   */
  'forward.expand': async ({ onebot, messageId, store, chatKey } = {}) => {
    if (!onebot) return { ok: false, error: '缺少 onebot 客户端' };
    return expandForward(onebot, messageId, store, chatKey);
  }
};

// ── 钩子 ──────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * 组装提示词之前：把"读不到的转发"标成"读不到"。
   *
   * 刻意**不**在这里请求 QQ —— 钩子超过 5 秒会被直接跳过（§3.2 硬约束 1）。
   * 这里只做纯字符串加工，代价是微秒级。它的价值是防幻觉：
   * 日志里模型当时说的是"？你这转发我点开是空的" —— 说明占位符没告诉它"读不到"，
   * 它就只能在"装作看到了"和"承认看不到"之间二选一。标注之后它只会老实说读不到。
   */
  'before-context': ({ triggerEntries } = {}) => {
    if (cfg().markUnreadable === false) return;
    const list = Array.isArray(triggerEntries) ? triggerEntries : [];
    let marked = 0;
    for (const e of list) {
      if (!e || typeof e.text !== 'string') continue;
      if (e.text.startsWith(EXPANDED_PREFIX)) continue;   // 已展开，别动
      if (!PLACEHOLDER_RE.test(e.text)) continue;
      PLACEHOLDER_RE.lastIndex = 0;                        // 带 /g 的正则有状态，复位
      e.text = e.text.replace(PLACEHOLDER_RE, UNREADABLE_MARK);
      marked++;
    }
    if (marked) log(`已把 ${marked} 条读不到的转发标注为「未读取」（防模型编造内容）`);
  },

  /**
   * 模型调用内置 read_forward 之前：把"负数 #数字"这一路改道到本插件。
   *
   * 为什么必须在这里拦：内置 read_forward（src/tools.js:502）把 message_id 直接当
   * 资源 id 传给协议端，负数一定拿到 "payload is empty"。模型不知道这件事，
   * 它会以为"这条转发确实没内容"然后放弃 —— 这是功能静默失效。
   *
   * 否决返回的 reason 会原样作为工具错误回给模型（orchestrator.js:1179），
   * 所以 reason 里必须写清"改用哪个工具"，否则模型就卡住了。
   *
   * 硬约束：钩子内**不发网络请求**（5 秒超时会被跳过），只做纯字符串判断；
   * 过小的正数（< 1000）一并改道 —— 真实 message_id 不会那么小。
   */
  'before-tool': ({ toolName, argsRaw } = {}) => {
    if (cfg().autoUse === false) return;
    if (toolName !== 'read_forward') return;
    let mid = '';
    try {
      const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
      mid = String(args?.messageId ?? '').trim();
    } catch { return; }
    if (!/^-?\d+$/.test(mid)) return;         // 不是数字（已是 res_id 形态）→ 不管
    const n = Number(mid);
    if (n > 0 && n >= MIN_REASONABLE_MID) return;   // 真实消息 id → 内置路径可用，放行
    // 剩下的都是内置路径必然失败的：负数（消息哈希）与过小的正数
    return {
      block: true,
      reason: `内置展开路径处理不了这个 messageId=${mid}（协议端只认转发段里的真实 id，`
        + `直接拿数字 message_id/哈希 去取会返回 payload is empty）。请改用工具 ${MY_TOOL}，`
        + `参数 messageId 填同一个 ${mid} —— 它会先用 get_msg 取出真实 id 再展开。`
    };
  }
};
