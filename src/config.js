// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    baseUrl: 'http://127.0.0.1:8787/v1',   // 例如本机 buddy2api 网关或任何 OpenAI 兼容端点
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 展示用单价（元 / 百万 token），不参与任何请求
    priceInputPerM: 0,
    priceOutputPerM: 0
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  providersSourceYaml: '',
  providersImported: true,
  // 联网搜索
  //   provider: 'auto'      = 有 AnySearch key 就用它，失败自动回退 Bing（推荐）
  //             'anysearch' = 只用 AnySearch（需配置 key，结果更全）
  //             'bing'      = 只用 Bing 网页抓取（无需 key）
  webSearch: {
    enabled: true,
    provider: 'auto',
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // AnySearch 的 API key（可选；也可用环境变量 ANYSEARCH_API_KEY / _2 注入，env 优先）
    // 支持多个 key 轮换：某个 key 返回 429 时自动换下一个
    anysearchKeys: []
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: ''                         // 追加自定义规则（可选）
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 多身份：按会话绑定人设。key = chatKey（可含模式后缀，如 private:123456789:tutor），
  // value = 人设 id（'builtin:xxx' 内置 / 'persona:<name>' 自定义人设名，见 resolvePersona）
  personaBindings: {},
  // 身份模式（学习模式等）：按会话记录当前激活的身份
  // { "<chatKey>": { "mode": "tutor"|"assistant", "personaRef": "...", "switchedAt": 123 } }
  personaModes: {},
  // 身份模式定义：每个模式一套完整配置（人设 + 工具 + 提示注入）
  identityModes: {
    // 示例（默认留空，由实际项目配置填充）：
    // tutor: { label: '教师模式', personaRef: '', extraPrompt: '', masterOnly: true }
  },
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 群聊未提及机器人时的触发概率（0.05 = 5%；@/提及/图片/提问必触发）
  groupMentionProbability: 0.05,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 0,   // 0 = 不限速（已取消频率限制）
    maxPerHour: 0,    // 0 = 不限速（已取消频率限制）
    hardSplitAt: 4000       // QQ 硬限制切分（0 = 不限制）
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10
  },
  // 存储
  store: {
    maxMessagesPerChat: 2000,   // 单群 JSON 最大保留条数（0 = 无限）
    pastStateLimit: 80,         // 提示词里"过去状态"最多带多少条
    pastStateMaxChars: 6000,    // "过去状态"文本预算
    keepSessionFiles: 300       // 保留最近多少个会话记录文件
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000  // 默认 6 小时
  },
  // 桌面端/控制台
  server: {
    port: 3210,
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  // 群聊回复门禁：只在被 @ / 叫名字时必回，其余按概率偶尔回（私聊不受影响）
  replyPolicy: {
    enabled: true,
    keywords: ['大肥鱼', '小鲸鱼', 'DeepSeek'],
    otherProbability: 0.03
  },
  // 扩展系统（skills/ + plugins/）
  //   skills[id]    每个 Skill/Plugin 的开关与设置（唯一开关来源）
  //   tools         工具总开关 / 分类开关 / 单工具覆盖
  //   extensions    热重载等全局行为
  skills: {},
  tools: {
    enabled: true,
    categories: {},
    overrides: {}
  },
  extensions: {
    hotReload: true
  },
  // 预算保险丝：今日估算成本达到上限（元）自动暂停；0 = 不限制
  budget: {
    dailyCostYuan: 0
  }
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

let currentConfig = null;
let saveTimers = new Map();

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  currentConfig = deepMerge(getConfig(), patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}

// ── 多身份（身份模式 Identity Mode）──────────────────────────────────────
// 设计要点：
//   物理会话键 baseChatKey（如 private:123456789）= 消息"从哪来"；
//   有效会话键 = baseChatKey + ':' + mode（如 private:123456789:tutor）；
//   不同身份的历史/记忆/进度天然隔离（store/memory 都按 chatKey 分文件）。

export const DEFAULT_MODE = 'assistant';

/** 拆解 chatKey：kind / id / mode / base。 */
export function parseChatKey(chatKey) {
  const parts = String(chatKey || '').split(':');
  const kind = parts[0] || '';
  const id = parts[1] || '';
  const mode = parts[2] || '';
  return { kind, id, mode, base: `${kind}:${id}` };
}

/** 取某物理会话当前激活的身份模式（未配置或已删除的模式回退默认）。 */
export function getIdentityMode(baseChatKey) {
  const cfg = getConfig();
  const rec = cfg.personaModes?.[baseChatKey];
  const mode = rec?.mode || DEFAULT_MODE;
  if (mode !== DEFAULT_MODE && !cfg.identityModes?.[mode]) return DEFAULT_MODE;
  return mode;
}

/** 设置某物理会话的身份模式并持久化。
 *  注意：deepMerge 对同名字段做"深层合并"，删除 key 会失效，因此显式重建整个对象后整体覆盖。 */
export function setIdentityMode(baseChatKey, mode) {
  const cfg = getConfig();
  const m = String(mode || DEFAULT_MODE);
  const next = { ...(cfg.personaModes || {}) };
  if (m === DEFAULT_MODE) delete next[baseChatKey];
  else next[baseChatKey] = { mode: m, switchedAt: Date.now() };
  // 先清空再写入，绕开 deepMerge 的"保留旧键"行为
  getConfig().personaModes = {};
  updateConfig({ personaModes: next });
  return m;
}

/** 物理会话键 → 有效会话键（按当前身份模式追加后缀）。 */
export function resolveChatKey(baseChatKey) {
  const { mode } = parseChatKey(baseChatKey);
  if (mode) return String(baseChatKey);
  const m = getIdentityMode(baseChatKey);
  return m === DEFAULT_MODE ? String(baseChatKey) : `${baseChatKey}:${m}`;
}

/** personaRef → 完整 persona 对象。支持 builtin:<id> / custom:<名或custom_N>。 */
export function resolvePersonaRef(ref) {
  if (!ref) return null;
  const cfg = getConfig();
  const s = String(ref).trim();
  if (s.startsWith('builtin:')) {
    const p = PERSONAS[s.slice(8)];
    if (!p) return null;
    return { botName: p.name, selfNickname: '', roleText: p.text, participation: 'medium', customRules: '' };
  }
  const key = s.startsWith('custom:') ? s.slice(7) : (s.startsWith('persona:') ? s.slice(8) : s);
  const list = cfg.customPersonas || [];
  let found = list.find((p) => p && p.name === key);
  if (!found && /^custom_\d+$/.test(key)) found = list[Number(key.slice(7))];
  if (!found) return null;
  return {
    botName: found.botName || found.name || cfg.persona.botName,
    selfNickname: found.selfNickname ?? '',
    roleText: found.text || '',
    participation: found.participation || cfg.persona.participation,
    customRules: found.customRules || ''
  };
}

/**
 * 解析某会话键应使用的人设与模式信息。
 * 优先级：personaBindings[有效键] > personaBindings[物理键] > 模式映射表 > 模式人设 > 全局默认。
 */
export function resolvePersona(chatKey) {
  const cfg = getConfig();
  const { base, mode } = parseChatKey(chatKey);
  const activeMode = mode || getIdentityMode(base);
  const modeDef = activeMode === DEFAULT_MODE ? null : (cfg.identityModes?.[activeMode] || null);

  const bindings = cfg.personaBindings || {};
  const ref = bindings[String(chatKey)] || bindings[base] || modeDef?.personaRef || '';
  const fromRef = resolvePersonaRef(ref);

  const persona = fromRef || {
    botName: cfg.persona.botName,
    selfNickname: cfg.persona.selfNickname,
    roleText: cfg.persona.roleText,
    participation: cfg.persona.participation,
    customRules: cfg.persona.customRules
  };
  return { persona, mode: activeMode, modeDef, baseChatKey: base };
}
