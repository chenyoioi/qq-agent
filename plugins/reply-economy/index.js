/**
 * reply-economy —— 闲聊减负（确定性型插件 / 放在 plugins/）
 *
 * ── 需求原话 ──────────────────────────────────────────────────────────────
 *   「减少每次回复对话时减少不必要的运转思考，为整体软件做一个运作减负」
 *
 * ── 判定：为什么是「插件」而不是「技能」──────────────────────────────────
 * 三问（README 扩展章节的判据：规则能写死 → 插件；要理解人话 → 技能）：
 *   ① 规则能写死吗？能。"这轮是不是闲聊"用机械信号判定：触发批每条
 *      ≤30 字（可调）、没命中复杂词表、没有图片/文件。判定哲学是**保守**：
 *      宁可漏判（不少省），绝不误伤（把正经求助当闲聊砍了）。
 *   ② 要不要理解人话？不要。减负动作（关思考/裁工具/限输出）全是机械操作。
 *   ③ 何时执行由谁定？必须由核心**必然执行**。"每轮闲聊都要减负"这件事
 *      不能指望模型记得去调某个工具 —— 做成技能 = 模型想不起来调 = 静默失效。
 * 三条都指向确定性型 → plugins/，靠 hooks + llm.request-params 工作。
 *
 * ── 减了哪三处"运转"（对应真实成本）───────────────────────────────────────
 *   1. 思考 token：闲聊轮显式下发"关闭思考"（按宿主方言表适配；
 *      拿不到方言表时静默跳过，绝不瞎发参数被网关 400）
 *   2. 工具往返轮次：把 web/知识库/媒体类**重工具**从本轮工具列表里裁掉 ——
 *      模型看不见就不会调，一次工具调用 = 一次完整的模型往返，
 *      这是闲聊轮里最贵的一类浪费
 *   3. 输出长度：max_tokens 压到设置值（默认 600）——闲聊说不了几个字，
 *      上限松了只会纵容模型写小作文
 * 另外在本次输入末尾追加一行轻量化引导（可关），提示词层面让它别绕路。
 *
 * ── 与两个现成插件的边界（都写在 README 里，这里只记结论）─────────────────
 *   · thinking-toggle-pro（smart 档）：它也按复杂度开关思考。转换链按目录
 *     字母序串行执行，本插件排在它**前面** —— 若它把同一条消息判成
 *     "开思考"，它的结论会在后面覆盖本插件。这是可接受的：用户显式选了
 *     smart/on，就让用户的选择赢；本插件独有的价值在裁工具与限输出，
 *     这两件事没有任何现成插件做。
 *   · early-finish：它负责"话发完了就别再调一轮 finish"，与本插件互补不重叠。
 *
 * ── 落盘的坑（都按宿主真实行为处理）────────────────────────────────────────
 *   · before-context 钩子拿到 triggerEntries（触发批原文），是判定唯一
 *     可靠的数据源；llm.request-params 里的 context 只有 sessionId ——
 *     所以判定在钩子里做一次、按 sessionId 记账，整个运行期间结论不变
 *     （同一轮里工具列表忽有忽无，会破坏模型对话历史的一致性）。
 *   · request-params 转换器是**同步等待**的（llm.js 里 await），但本插件
 *     在里面只做对象操作，不做任何等待 —— 排队的事归 llm-throttle 管。
 *   · max_tokens 只在"思考确认已关"或本来就没思考参数时才压：
 *     思考还开着的请求（比如方言表没拿到、关不掉），思考 token 也算在
 *     max_tokens 里（部分渠道），压了会把正文预算掐死 —— 宁可不省。
 *   · 裁工具按 tool-registry 的 category 判（web/knowledge/media），
 *     拿不到注册表就整段跳过（保守），绝不按猜的工具名硬删。
 *   · 引导语追加到**最后一条 user 消息末尾**并带去重标记（重试路径会
 *     重新进一次钩子，没标记的话提示会被叠两遍）。
 */

const BUILD_TAG = 'v1.0.0';

const DEFAULTS = {
  enabled: true,
  maxTriggerChars: 30,
  // 命中任一词 → 按全功率跑。除了求助/查询类动词，还包含"图/表情包"：
  // 闲聊里说"来张图"是要真发图的（走 search_images/send_image 这对联网工具，
  // 正好落在被裁的 web/media 类里）—— 这种诉求宁可全功率，也不裁了工具让它办不了事。
  complexWords: '为什么,怎么,如何,解释,分析,推荐,比较,评测,评价,教程,攻略,代码,编程,数学,物理,化学,翻译,总结,排行,区别,原理,故障,报错,帮忙,搜,查一下,查查,新闻,天气,价格,多少,链接,下载,打开,看看,是什么,是谁,什么意思,教我,帮我,图,表情包,发张,来张,来一张',
  thinkingOff: true,
  maxTokens: 600,
  trimHeavyTools: true,
  nudge: true
};

/** 闲聊轮会裁掉的工具分类（tool-registry 的 category 口径）。 */
const HEAVY_CATEGORIES = new Set(['web', 'knowledge', 'media']);

/** 引导语标记（去重用；同时也是提示词里最靠近发言位置的指令）。 */
const NUDGE_MARK = '【本轮轻量化】';

/** 引导语正文。注意绝不能出现"不要调用工具"这类一刀切 —— 发消息本身就是工具调用。 */
const NUDGE_TEXT = `${NUDGE_MARK}这批消息是日常闲聊：一两句话直接回完就收尾（想发言仍用 send_message），不需要查资料、不需要翻记录、不需要动表情库，也别再抛新话题。`;

let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** 核心模块（软依赖；取不到就降级，绝不让 import 抛错把插件变成"加载失败"） */
let coreThinking = null;      // { detectDialect, buildThinkingParams, stripThinkingParams, THINKING_BODY_KEYS }
let coreToolRegistry = null;  // { getTool }

/** sessionId -> { economy, why, at }：一轮运行的判定结论（整轮保持一致） */
const verdicts = new Map();
const VERDICT_TTL_MS = 3 * 60 * 60 * 1000;

// ───────────────────────────── 设置 ─────────────────────────────

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const num = (k, min, max) => {
    const n = Number(s[k]);
    if (!Number.isFinite(n)) return DEFAULTS[k];
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const bool = (k) => (s[k] === undefined || s[k] === null ? DEFAULTS[k] : s[k] !== false);
  return {
    enabled: bool('enabled'),
    maxTriggerChars: num('maxTriggerChars', 5, 200),
    complexWords: String(s.complexWords ?? DEFAULTS.complexWords),
    thinkingOff: bool('thinkingOff'),
    maxTokens: num('maxTokens', 0, 32000),
    trimHeavyTools: bool('trimHeavyTools'),
    nudge: bool('nudge')
  };
}

/** 复杂词表：逗号分隔（中英文逗号都认），转成小写数组。 */
function complexWordList(raw) {
  return String(raw || '')
    .split(/[,，、;；\n]+/)
    .map((w) => String(w || '').trim().toLowerCase())
    .filter(Boolean);
}

// ───────────────────────────── 闲聊判定 ─────────────────────────────

/** 去掉占位符与 @ 片段，只留真正打出来的字（长度判定用干净口径）。 */
function plainText(text) {
  return String(text == null ? '' : text)
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/\[[^\]]{0,20}\]/g, ' ')
    .replace(/@[^\s]{1,24}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 判定一批触发消息是不是"日常闲聊"。
 * 保守策略：**任何一条**不满足就整体不算闲聊（宁可漏省不误伤）。
 *
 * @returns {{ economy: boolean, why: string }}
 */
function classifyEconomy(triggerEntries = [], conf, { proactive = false } = {}) {
  // 主动开口（活跃模式抛话题）需要模型自己发挥，不归减负管
  if (proactive) return { economy: false, why: '主动开口，全功率' };

  const list = (Array.isArray(triggerEntries) ? triggerEntries : []).filter(Boolean);
  if (!list.length) return { economy: false, why: '没有触发消息' };

  const words = complexWordList(conf.complexWords);
  let sawText = false;
  for (const entry of list) {
    // 有图/视频/文件 → 看得懂图才回得上来，全功率
    if (Array.isArray(entry.media) && entry.media.length) {
      return { economy: false, why: '带媒体附件' };
    }
    const text = plainText(entry.text);
    // 拍一拍：本身就是一个字的互动，不算"复杂内容"
    if (entry.isPoke) continue;
    if (!text) continue;
    sawText = true;
    if (text.length > conf.maxTriggerChars) {
      return { economy: false, why: `单条 ${text.length} 字 > ${conf.maxTriggerChars}` };
    }
    const lower = text.toLowerCase();
    for (const w of words) {
      if (w && lower.includes(w)) return { economy: false, why: `命中复杂词「${w}」` };
    }
  }
  if (!sawText) return { economy: false, why: '触发批没有可判文本' };
  return { economy: true, why: '短句闲聊' };
}

/** 记账表清理（会话对象没人来收，靠 TTL 自清）。 */
function pruneVerdicts() {
  if (verdicts.size <= 300) return;
  const now = Date.now();
  for (const [k, v] of verdicts) {
    if (now - Number(v?.at || 0) > VERDICT_TTL_MS) verdicts.delete(k);
  }
}

// ───────────────────────────── 生命周期 ─────────────────────────────

export async function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
  warn = typeof api?.warn === 'function' ? api.warn : log;

  // 软依赖：方言表（关思考用）与工具注册表（裁重工具用）。
  // 取不到只影响对应的那一项减负，不影响其它项 —— 各自独立降级。
  try {
    const mod = await import('../../src/thinking.js');
    coreThinking = (typeof mod?.detectDialect === 'function'
      && typeof mod?.buildThinkingParams === 'function'
      && typeof mod?.stripThinkingParams === 'function')
      ? mod
      : null;
  } catch { coreThinking = null; }
  try {
    const mod = await import('../../src/tool-registry.js');
    coreToolRegistry = typeof mod?.getTool === 'function' ? mod : null;
  } catch { coreToolRegistry = null; }

  verdicts.clear();
  const conf = settings();
  log('闲聊减负已加载（%s）：触发批单条 ≤%s 字且不命中复杂词 → 轻量回复'
    + '（思考关闭：%s%s；输出上限 %s；裁重工具：%s%s；轻量引导：%s）',
  BUILD_TAG, conf.maxTriggerChars,
  conf.thinkingOff ? '开' : '关', coreThinking ? '' : '（⚠️ 没拿到方言表，这项会跳过）',
  conf.maxTokens > 0 ? conf.maxTokens : '不限',
  conf.trimHeavyTools ? '开' : '关', coreToolRegistry ? '' : '（⚠️ 没拿到工具注册表，这项会跳过）',
  conf.nudge ? '开' : '关');
}

/** 自检必须同步返回。本插件没有硬依赖（软依赖各自降级）。 */
export function available() {
  return true;
}

export function deactivate() {
  verdicts.clear();
}

export function dispose() {
  verdicts.clear();
}

// ───────────────────────────── 钩子 ─────────────────────────────

/**
 * 提示词组装之前：做本轮的闲聊判定（整轮一次，之后所有轮次沿用）。
 *
 * 为什么在这里判而不是在 request-params 里判：只有这个钩子拿得到
 * triggerEntries（触发批原文）；request-params 的 context 里只有 sessionId。
 * 判定结论按 sessionId 记账，同轮内保持一致 —— 工具列表忽有忽无
 * 会让模型的对话历史前后对不上。
 */
export const hooks = {
  'before-context'(ctx = {}) {
    try {
      const conf = settings();
      const sid = String(ctx?.sessionId || '');
      if (!conf.enabled || !sid) return;

      const verdict = classifyEconomy(ctx.triggerEntries, conf, { proactive: ctx.proactive === true });
      verdicts.set(sid, { ...verdict, at: Date.now() });
      pruneVerdicts();
      if (verdict.economy) {
        log('闲聊减负：本轮判为闲聊（%s）→ 关思考 / 裁重工具 / 输出上限 %s',
          verdict.why, conf.maxTokens > 0 ? conf.maxTokens : '不限');
      }
    } catch (error) {
      warn('闲聊判定失败（本轮按全功率跑）：%s', error?.message ?? error);
    }
  },

  /**
   * 消息即将发给模型：在最后一条 user 消息末尾追加轻量化引导。
   * 只追加 user 消息（系统提示词一个字节不动，前缀缓存不受影响）；
   * 带 NUDGE_MARK 去重，重试路径不会叠两遍。
   */
  'before-llm-messages'(ctx = {}) {
    try {
      const conf = settings();
      if (!conf.enabled || !conf.nudge) return;
      const sid = String(ctx?.sessionId || '');
      const v = sid ? verdicts.get(sid) : null;
      if (!v?.economy) return;
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string' && !m.content.includes(NUDGE_MARK)) {
          m.content = `${m.content}\n\n${NUDGE_TEXT}`;
        }
        return;
      }
    } catch (error) {
      warn('追加轻量引导失败（不影响发言）：%s', error?.message ?? error);
    }
  }
};

// ───────────────────────────── 能力 ─────────────────────────────

/** 查本轮的判定结论；查不到（裁判调用/未过钩子）一律按"不减负"处理。 */
function economyOf(context) {
  const sid = String(context?.sessionId || '');
  if (!sid) return null;
  const v = verdicts.get(sid);
  return v && v.economy ? v : null;
}

/** body 里是否还带着思考参数（压 max_tokens 前的自查）。 */
function hasThinkingParams(body) {
  const keys = Array.isArray(coreThinking?.THINKING_BODY_KEYS)
    ? coreThinking.THINKING_BODY_KEYS
    : ['thinking', 'enable_thinking', 'thinking_budget', 'reasoning_effort', 'reasoning', 'think', 'extra_body'];
  return keys.some((k) => body && typeof body === 'object' && k in body);
}

/**
 * 请求体转换器：闲聊轮做三件事 —— 关思考 / 裁重工具 / 压输出上限。
 *
 * 入参/返回与核心约定一致（src/llm.js）：
 *   fn({ body, api, model, messages, tools, temperature, context })
 *   → { body, omitTemperature? }；返回 undefined = 不改。
 */
export const providers = {
  'llm.request-params'({ body, api, model, context } = {}) {
    try {
      const conf = settings();
      if (!conf.enabled) return undefined;
      if (!body || typeof body !== 'object') return undefined;
      // 判定/裁判类调用（宿主显式要求"这次别思考"）核心已自理，不掺和
      if (String(context?.thinkingMode || '').trim().toLowerCase() === 'off') return undefined;
      const v = economyOf(context);
      if (!v) return undefined;

      let next = body;
      let omitTemperature = false;
      let did = [];
      let thinkingOffApplied = false;

      // ① 关闭思考：先剥掉已有的思考参数（前一个转换器可能加过，留下残键
      //    会跟"关闭"参数打架），再按方言下发显式的"关"。
      if (conf.thinkingOff && coreThinking) {
        const dialect = coreThinking.detectDialect({ baseUrl: api?.baseUrl || '', model: model || api?.model || '' }).dialect;
        const off = coreThinking.buildThinkingParams({ effort: 'off', dialect, budget: 0 });
        if (off?.applied) {
          next = coreThinking.stripThinkingParams(next);
          next = { ...next, ...off.params };
          omitTemperature = omitTemperature || off.omitTemperature === true;
          thinkingOffApplied = true;
          did.push('关思考');
        }
      }

      // ② 裁掉重工具：按注册表 category 判，认不出的工具一律保留（保守）。
      //    只在裁完还剩工具时才生效 —— 绝不让模型两手空空（发消息也是工具）。
      if (conf.trimHeavyTools && coreToolRegistry && Array.isArray(next.tools) && next.tools.length) {
        const total = next.tools.length;
        const kept = next.tools.filter((t) => {
          const name = String(t?.function?.name || '');
          if (!name) return true;
          const def = coreToolRegistry.getTool(name);
          if (!def) return true;                        // 注册表里没有：不猜，保留
          return !HEAVY_CATEGORIES.has(String(def.category || ''));
        });
        if (kept.length && kept.length < total) {
          next = { ...next, tools: kept };
          did.push(`裁 ${total - kept.length} 个重工具`);
        }
      }

      // ③ 压输出上限：只在思考确认已关（我亲手关的，或本来就没思考参数）时才压。
      //    ⚠️ 不能用"body 里有没有思考键"来判断：①里下发的 enable_thinking=false
      //    本身就是思考键 —— 那是"关"的声明，不是"开"。拿键存在与否当开关，
      //    这条上限就永远压不上去（集成自测就是这么抓出来的）。
      //    思考还开着的请求（比如方言表没拿到、没关成）里思考 token 也计入
      //    max_tokens（部分渠道），压了会把正文预算掐死 —— 宁可不省。
      if (conf.maxTokens > 0 && (thinkingOffApplied || !hasThinkingParams(next))) {
        const cur = Number(next.max_tokens) || 0;
        if (cur <= 0 || cur > conf.maxTokens) {
          next = { ...next, max_tokens: conf.maxTokens };
          did.push(`输出上限 ${conf.maxTokens}`);
        }
      }

      if (next === body) return undefined;
      // 标记本轮生效过：llm.usage 转换器从同一个 context 上读它，
      // 把计数写进会话页的用量统计（用户能直接看到"这轮减负了"）。
      if (context && typeof context === 'object') context._replyEconomyApplied = 1;
      log('闲聊减负生效：%s', did.join(' / ') || '无改动');
      return { body: next, omitTemperature };
    } catch (error) {
      // 减负坏了绝不能弄坏请求本身：返回 undefined = 原样发出
      warn('减负转换失败（本次按原请求发送）：%s', error?.message ?? error);
      return undefined;
    }
  },

  /**
   * 附加统计：本轮减负是否生效（进会话页的"Skill 附加统计"，
   * 与 reasoning tokens 同一条通道，orchestrator 里累加进 session.usage.extra）。
   *
   * ⚠️ 宿主调 llm.usage 的形态是 fn({ result, usage, ...ctx }) —— 上下文是
   *    **平铺**进参数里的，没有嵌套的 context 字段。第一版就读错了这里
   *    （读 context._replyEconomyApplied），集成自测抓出来时它永远 undefined，
   *    统计一个都不会记，而且是悄无声息的那种失效。
   */
  'llm.usage'(args = {}) {
    try {
      if (Number(args?._replyEconomyApplied) === 1) return { replyEconomy: 1 };
      return undefined;
    } catch {
      return undefined;
    }
  }
};

// ───────────────────────────── 自检/排障导出 ─────────────────────────────

export const __internals = {
  settings, classifyEconomy, plainText, complexWordList, economyOf,
  verdicts,
  get coreThinkingOk() { return Boolean(coreThinking); },
  get coreToolRegistryOk() { return Boolean(coreToolRegistry); },
  setConfig: (fn) => { cfg = fn; },
  NUDGE_MARK
};
