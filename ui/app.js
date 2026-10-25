// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  tools: [],
  config: null,
  personaTemplates: {},
  // 覆盖人设前的临时备份（仅本页面会话内有效，刷新即失效）
  personaBackup: null,
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'capabilities'
};

// ── 工具函数 ──
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 时间一律按**北京时间**渲染：进程已锁 TZ=Asia/Shanghai（见 src/server.js 首行），
// 所以这里的 getHours()/getMonth() 取到的就是北京时间，不是服务器 UTC。
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 主题（浅色 / 深色）──────────────────────────────────────────
// 首屏防闪由 index.html 里的内联脚本负责（它在样式表之前把 data-theme 定好），
// 这里只管切换、记忆和按钮文案。颜色本身全在 style.css 的变量里，切主题不碰 DOM 样式。
const THEME_KEY = 'qq-agent-theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, { persist = true } = {}) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, t); } catch { /* 隐私模式下存不了，只影响"下次还记得" */ }
  }
  const btn = $('#theme-toggle');
  if (btn) {
    btn.textContent = t === 'light' ? '☀ 浅色' : '🌙 深色';
    btn.title = t === 'light' ? '当前浅色主题，点击切到深色' : '当前深色主题，点击切到浅色';
  }
}

function initTheme() {
  applyTheme(currentTheme(), { persist: false });   // 只同步按钮文案，不动已存的选择
  $('#theme-toggle')?.addEventListener('click', () => {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });
  // 用户没手动选过时跟随系统主题变化（选过就尊重用户，不再跟着系统跳）
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (ev) => {
      let stored = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch { /* 同上 */ }
      if (!stored) applyTheme(ev.matches ? 'light' : 'dark', { persist: false });
    });
  } catch { /* 老浏览器没有 matchMedia 事件，忽略 */ }
}

initTheme();

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('协议端已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认协议端（NapCat）在运行，或到「协议端」页签查看。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  const modelOk = !!(cfg.api.model && cfg.api.baseUrl);
  checks.push({ ok: modelOk, label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（必填）', fix: modelOk ? null : 'settings-api' });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  const acct2 = status?.onebot?.account || {};
  const acctOffline2 = acct2.online === false;
  // 分两条报：WS 连接 / 账号在线。只报前者会把"账号掉线"判成健康（2026-09-14 事故）
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot 未连接 —— 请到「协议端」页签检查协议端', fix: obOk ? null : 'snowluma-tab' });
  if (obOk) {
    const mins2 = acct2.offlineMs ? Math.round(acct2.offlineMs / 60000) : 0;
    checks.push({
      ok: !acctOffline2,
      label: acctOffline2
        ? `⚠ QQ 账号已离线${mins2 ? `（${mins2} 分钟）` : ''} —— 机器人收不到消息，请重新登录`
        : (acct2.online === true ? 'QQ 账号在线' : 'QQ 账号状态未探测（稍候自动重试）'),
      fix: acctOffline2 ? 'snowluma-tab' : null
    });
  }
  return { ready: modelOk && allowOk && obOk && !acctOffline2, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  if (state.paused && state.pauseReason === 'budget') {
    show = true;
    const cap = state.config?.budget?.dailyCostYuan || 0;
    const cost = state.status?.usage?.cost ?? 0;
    html = `💰 已触发今日预算上限（¥${cost.toFixed(2)} / ¥${cap}），机器人自动暂停。可先 <a href="#" id="banner-goto-settings">设置 → 预算保险丝</a> 调整上限，然后选择"恢复"（补处理积压消息）或"恢复并全部标为已读"（丢弃积压）。`;
  } else if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot 还没连上：请确认协议端（NapCat）在运行，且设置里的 WS/HTTP 地址正确。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

// ── 技能（扩展）页 ──────────────────────────────────────────────
// 数据全部来自 /api/skills 与 /api/tools；开关写 config.skills[id].enabled，
// 与后端唯一开关来源一致（UI 不另存状态）。
//
// 2026-10-21 重构：卡片里不再平铺输入框。
// 过去每个字段是裸 <input>，字段一多（点歌插件 36 项）就得在卡片里滚很久，
// 改一个值要点一次「保存设置」，enum 还只能当文本框手打。
// 现在卡片只留「⚙ 设置 / 启用 / 打开面板 / 卸载」，编辑全在右侧抽屉
// （openSkillDrawer）：按 configSchema 选控件、按 group 折叠分组、
// 就地校验、改完一次保存。卡片与抽屉共用同一份 /api/skills 数据（skillsData），
// 保存成功后只重画那**一张**卡片，不整页重载 —— 滚动位置与搜索词都不会丢。
let skillsBound = false;
let skillsData = null;              // 最近一次 /api/skills 的响应
let skillsToolsData = { total: 0, tools: [] };
let skillsRenderDeferred = false;   // 抽屉有未保存改动时，卡片重画推迟到关闭后
let skillQuery = '';                // 卡片搜索词：客户端过滤，不重新请求
let skillFilter = 'all';            // 状态筛选：all | active | disabled | broken

// 密钥类字段的兜底判定：清单作者忘标 secret 时按名字识别。
// 必须与后端 looksLikeSecretKey()（skills/manager.js）用同一套规则：
// **切词后整词匹配**，不是查子串 —— 否则 group-manner 的 interestKeywords
// （兴趣关键词）会被当成密钥，渲染成一个只能看见 ****** 的密码框。
const SKILL_SECRET_WORD_RE = /^(api-?keys?|keys?|tokens?|secrets?|cookies?|passwords?|passwd|pwd|creds?|credentials?)$/i;
function looksLikeSecretKey(key) {
  return String(key ?? '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((part) => SKILL_SECRET_WORD_RE.test(part));
}

// 抽屉的编辑态。草稿（draft）与快照（original）分开存：两者不同 = 有未保存修改。
// original 只在「打开面板」和「保存成功」时刷新，撤销修改就是把 draft 拷回去。
// 放在这里（而不是抽屉函数旁边）是为了让上面的 loadSkillsPage 闭包能安全引用。
const skillDrawer = {
  id: null,
  skill: null,
  fields: [],        // 字段元信息（含未声明字段，见 buildSkillFields）
  draft: {},         // key -> 表单里的值（boolean 或 string）
  original: {},      // key -> 打开/保存时的值
  touched: new Set(),
  errors: {},        // key -> 错误文案
  collapsed: new Set(),
  fieldQuery: '',    // 抽屉内字段筛选词
  saving: false
};

async function loadSkillsPage() {
  const panel = $('#skills-panel');
  if (!panel) return;
  if (!panel.dataset.ready) panel.innerHTML = '<div class="empty-hint">正在读取扩展列表…</div>';
  try {
    const [data, tools] = await Promise.all([
      api('/api/skills'),
      api('/api/tools').catch(() => ({ total: 0, tools: [] }))
    ]);
    skillsData = data;
    skillsToolsData = tools;
    // SSE 的 skills-changed 也会打到这里。抽屉里有未保存的改动时先记下新数据、
    // 不重画卡片：否则用户改到一半，下面的卡片列表突然整体换了一批节点。
    if (skillDrawer.id && skillDrawerDirty()) skillsRenderDeferred = true;
    else renderSkillsPage(data, tools);
  } catch (e) {
    panel.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
  if (!skillsBound) {
    skillsBound = true;
    panel.dataset.ready = '1';
    panel.addEventListener('click', onSkillsClick);
    panel.addEventListener('change', onSkillsChange);
    panel.addEventListener('input', onSkillsChange);
  }
}

const skillKindLabel = (sk) => (sk.kind === 'plugin' ? '确定性型' : (sk.kind === 'skill' ? 'LLM 型' : '扩展'));

function renderSkillsPage(data, toolsData) {
  const panel = $('#skills-panel');
  const list = data.skills || [];
  const sum = data.summary || {};
  panel.innerHTML = `
    <div class="skills-toolbar">
      <input id="skill-search" class="skills-search" placeholder="搜索扩展名 / 描述 / 字段名" value="${esc(skillQuery)}">
      <div class="skill-filters" id="skill-filters">
        ${skillFilterChip('all', '全部', sum.total ?? list.length)}
        ${skillFilterChip('active', '启用', sum.active ?? 0)}
        ${skillFilterChip('disabled', '停用', sum.disabled ?? 0)}
        ${skillFilterChip('broken', '异常', sum.broken ?? 0)}
      </div>
      <div class="skills-toolbar-actions">
        <button class="btn-mini" data-act="reload" title="重新扫描 skills/ 与 plugins/">重新扫描</button>
        <button class="btn-mini" data-act="install">安装（zip）</button>
        <input type="file" id="skill-zip" accept=".zip" hidden>
      </div>
    </div>
    <div class="skills-hint muted">
      <b>skills/</b> 注册工具，模型自己判断何时用 · <b>plugins/</b> 提供能力/钩子，命中即执行 · 放进目录即热重载
    </div>
    <div class="skills-list" id="skills-list"></div>
    ${(data.duplicates || []).length ? `<div class="skills-hint warn">
      ⚠ 有 ${data.duplicates.length} 个扩展装了多份副本（${data.duplicates.map((d) => esc(d.id)).join('、')}）——
      加载时后一份会盖掉前一份，卡片只显示一个，看起来就像"安装了却没出现"。
      <button class="btn-mini" data-act="dedupe">清理重复副本</button>
    </div>` : ''}
    ${(data.uninstalled || []).length ? `<div class="skills-hint muted">配置里还有已删除的扩展记录：${data.uninstalled.map((u) => esc(u.id)).join('、')}</div>` : ''}
    <details class="tools-box">
      <summary>工具清单（本轮可用 <b>${toolsData.available ?? '?'}</b> / 注册 <b>${toolsData.total ?? 0}</b> 个）</summary>
      <div class="tools-filter">
        <input id="tool-search" placeholder="搜索工具名 / 描述 / 分类" value="${esc(toolSearch)}">
        <label><input type="checkbox" id="tool-only-unavailable" ${toolOnlyUnavailable ? 'checked' : ''}> 只看不可用</label>
      </div>
      <div id="tool-rows" class="tools-table"></div>
    </details>
  `;
  state.tools = toolsData.tools || [];
  renderSkillCards();
  renderToolRows();
}

// ── 卡片列表（客户端过滤）──

const SKILL_FILTER_LABEL = { all: '全部', active: '启用', disabled: '停用', broken: '异常' };

function skillFilterChip(key, label, count) {
  const on = skillFilter === key ? ' active' : '';
  return `<button type="button" class="skill-filter${on}" data-act="filter" data-filter="${key}">${label}<b>${count}</b></button>`;
}

function updateSkillFilterChips() {
  const box = $('#skill-filters');
  if (!box) return;
  for (const btn of box.querySelectorAll('.skill-filter')) {
    btn.classList.toggle('active', btn.dataset.filter === skillFilter);
  }
}

/** 扩展是否通过状态筛选（搜索词另算）。 */
function skillPassesFilter(sk) {
  if (skillFilter === 'active') return !!sk.active;
  if (skillFilter === 'disabled') return !sk.active;
  if (skillFilter === 'broken') return !!sk.loadError;
  return true;
}

/** 卡片筛选：先匹配扩展自身信息，再下钻到字段名/字段标签/字段说明。 */
function matchSkill(sk, q) {
  if (!q) return { fields: [] };
  const own = [sk.id, sk.name, sk.description || ''].join(' ').toLowerCase();
  if (own.includes(q)) return { fields: [] };
  const schema = sk.configSchema || {};
  const fields = [];
  for (const [key, spec] of Object.entries(schema)) {
    const label = spec?.label || spec?.title || '';
    const text = `${key} ${label} ${spec?.description || spec?.hint || ''}`.toLowerCase();
    if (text.includes(q)) fields.push(label || key);
  }
  // settings 里有、schema 没声明的字段（如 quota-guard 的 perUser）也能被搜到
  for (const key of Object.keys(sk.settings || {})) {
    if (key === 'enabled' || key in schema) continue;
    if (key.toLowerCase().includes(q)) fields.push(key);
  }
  return fields.length ? { fields } : null;
}

/**
 * 卡片：只放进"一眼要判断的东西"，简介整段不展示。
 * 扩展简介动辄几百字（点歌插件两屏都放不下），铺在卡片里会把网格撑成
 * 一排排高低不齐的长条，反而找不到卡片。完整简介在「⚙ 设置」抽屉顶部，
 * 默认两行、点「展开」看全文 —— 要看简介就进去看，浏览时只看结论。
 */
function skillCardHtml(sk, hit) {
  const kind = skillKindLabel(sk);
  const statePill = sk.loadError
    ? '<span class="skill-state bad">异常</span>'
    : (sk.active ? '<span class="skill-state ok">启用</span>' : '<span class="skill-state off">停用</span>');
  const tools = sk.toolIds || [];
  const caps = sk.capabilities || [];
  // 工具/能力只留数量 + 前两项能力，完整清单放 title：卡片是用来扫的，不是用来读的
  const toolChip = `<span class="skill-chip" title="工具：${esc(tools.length ? tools.join('、') : '无（确定性型不注册工具）')}">🧰 ${tools.length ? `${tools.length} 工具` : '无工具'}</span>`;
  // 没有能力就不摆一块「无能力」的牌子：8 张卡片都挂同一句废话，纯属噪音
  const capChips = caps.length
    ? caps.slice(0, 2).map((c) => `<span class="skill-chip" title="能力：${esc(caps.join('、'))}">⚡ ${esc(c)}</span>`).join('')
      + (caps.length > 2 ? `<span class="skill-chip" title="能力：${esc(caps.join('、'))}">+${caps.length - 2}</span>` : '')
    : '';
  // 上次修改时间取自配置文件 mtime（后端给 configMtime），没有就整块省略
  const mtime = sk.configMtime ? `<span class="skill-mtime" title="data/config.json 的上次修改时间：所有扩展设置都存在这个文件里">改于 ${fmtTime(sk.configMtime)}</span>` : '';
  const err = sk.loadError ? `<div class="skill-loaderr" title="${esc(sk.loadError)}">${esc(sk.loadError)}</div>` : '';
  const hitHint = (hit?.fields || []).length
    ? `<div class="skill-hit">命中字段：${hit.fields.slice(0, 3).map((x) => esc(x)).join('、')}${hit.fields.length > 3 ? ` …+${hit.fields.length - 3}` : ''}</div>`
    : '';
  const fieldCount = Object.keys(sk.configSchema || {}).length;
  return `<div class="skill-card${sk.loadError ? ' has-error' : ''}" data-id="${esc(sk.id)}">
    <div class="skill-card-head">
      <div class="skill-card-title"><b>${esc(sk.name || sk.id)}</b><span class="skill-kind">${kind}</span><span class="skill-ver" title="扩展 id：${esc(sk.id)}">v${esc(sk.version || '')}</span></div>
      ${statePill}
    </div>
    ${err}
    <div class="skill-card-meta">${toolChip}${capChips}${mtime}</div>
    ${hitHint}
    <div class="skill-card-actions">
      <button class="btn-mini btn-accent" data-act="settings" title="打开设置面板（按分组编辑、就地校验）">⚙ 设置${fieldCount ? `<span class="skill-field-count">${fieldCount}</span>` : ''}</button>
      <label class="skill-enable"><input type="checkbox" data-act="toggle" ${sk.active ? 'checked' : ''}> 启用</label>
      ${sk.hasUi ? '<button class="btn-mini" data-act="panel">面板</button>' : ''}
      <button class="btn-mini" data-act="uninstall">卸载</button>
    </div>
  </div>`;
}

function renderSkillCards() {
  const box = $('#skills-list');
  if (!box) return;
  const q = skillQuery.trim().toLowerCase();
  const rows = [];
  for (const sk of (skillsData?.skills || [])) {
    if (!skillPassesFilter(sk)) continue;
    const hit = matchSkill(sk, q);
    if (!hit) continue;
    rows.push(skillCardHtml(sk, hit));
  }
  const filtered = skillFilter !== 'all' || !!q;
  box.innerHTML = rows.join('') || `<div class="empty-hint">${filtered
    ? `没有符合条件的扩展${skillFilter !== 'all' ? `（${SKILL_FILTER_LABEL[skillFilter]}）` : ''}${q ? `，关键词「${esc(skillQuery.trim())}」` : ''}
       <button class="btn-mini" data-act="filter-reset">清除筛选</button>`
    : '还没有安装任何扩展'}</div>`;
}

/** 刚装完的卡片闪一下并滚到可见：装完什么都不提示、只在列表里静悄悄多一个，很容易以为没装上。 */
function highlightSkillCard(id) {
  if (!id) return;
  const box = $('#skills-list');
  if (!box) return;
  const node = [...box.querySelectorAll('.skill-card')].find((n) => n.dataset.id === id);
  if (!node) return;
  node.classList.add('just-installed');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => node.classList.remove('just-installed'), 2600);
}

/** 只重画一张卡片：保存成功后用它，保住 .skills-pane 的滚动位置。 */
function refreshSkillCardNode(sk) {
  const box = $('#skills-list');
  if (!box) return;
  const node = [...box.querySelectorAll('.skill-card')].find((n) => n.dataset.id === sk.id);
  if (!node) return;   // 当前搜索词/筛选把它挡在外面了，就不硬插回来
  node.outerHTML = skillCardHtml(sk, matchSkill(sk, skillQuery.trim().toLowerCase()) || { fields: [] });
}

// ── 右上角 toast（保存/撤销等轻提示）──
// 不用 alert：它会抢焦点，而设置面板里可能正停在密码框上。
function showToast(text, kind = 'ok') {
  let box = document.getElementById('toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-box';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 240);
  }, 1800);
}

const allDrawerFields = () => skillDrawer.fields;

const prettyJson = (v) => {
  try { return JSON.stringify(v ?? null, null, 2); } catch { return String(v ?? ''); }
};

/** 把 schema 声明 + 现值 + 默认值整理成渲染用的字段表。 */
function buildSkillFields(sk) {
  const schema = sk.configSchema || {};
  const defaults = sk.defaults || {};
  const values = sk.settings || {};
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const fields = [];
  for (const [key, rawSpec] of Object.entries(schema)) {
    // 启用开关在卡片上（唯一开关来源 config.skills[id].enabled），抽屉里不重复一份
    if (key === 'enabled') continue;
    const spec = (rawSpec && typeof rawSpec === 'object') ? rawSpec : {};
    // 历史清单里 token-saver 用 type:'select' + options 表达枚举，语义与 enum+values 相同；
    // quota-guard 用 title/hint 而不是 label/description —— 两种都认，别让老扩展变瞎。
    const options = Array.isArray(spec.values) ? spec.values : (Array.isArray(spec.options) ? spec.options : null);
    const type = spec.type === 'boolean' ? 'boolean'
      : spec.type === 'number' ? 'number'
        : (spec.type === 'enum' || spec.type === 'select' || options) ? 'enum'
          : (spec.type === 'array' || Array.isArray(spec.default)) ? 'json'
            : 'string';
    const hasDefault = has(spec, 'default') || has(defaults, key);
    const def = has(spec, 'default') ? spec.default : defaults[key];
    const value = values[key] !== undefined ? values[key] : def;
    const secret = type === 'string' && (!!spec.secret || looksLikeSecretKey(key));
    const len = (v) => (v === undefined || v === null ? 0 : String(v).length);
    const strValues = [value, def].filter((v) => typeof v === 'string' && v);
    // 多值列表（用 | 或逗号连起来、或本来就带换行）：单行 input 里改起来容易越界，同样给文本域
    const listLike = strValues.some((v) => /[|\n]/.test(v) || v.split(',').length >= 3);
    // 长文本：清单标了 multiline/textarea、值本身超过 60 字、或是个多值列表 —— 单行 input 会看不全
    const multiline = type === 'string' && (!!spec.multiline || spec.type === 'textarea' || listLike || len(value) > 60 || len(def) > 60);
    fields.push({
      key,
      type,
      label: spec.label || spec.title || key,
      description: spec.description || spec.hint || '',
      group: String(spec.group || '').trim() || '常规',
      values: options,
      def,
      hasDefault,
      value,
      secret,
      masked: secret && value === '******',
      multiline,
      required: !!spec.required,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      undeclared: false
    });
  }
  // settings 里有、configSchema 没声明的字段 → 「其它（JSON）」高级区。
  // enabled 是卡片上的开关，__ 前缀是内部字段，都不该混进来。
  for (const key of Object.keys(values)) {
    if (key === 'enabled' || key.startsWith('__') || has(schema, key)) continue;
    fields.push({
      key,
      type: 'json',
      label: key,
      description: '这个字段没在 configSchema 里声明，按 JSON 编辑（保存前会校验格式）。',
      group: '其它（JSON）',
      values: null,
      def: defaults[key],
      hasDefault: has(defaults, key),
      value: values[key],
      secret: false,
      masked: false,
      multiline: false,
      required: false,
      undeclared: true
    });
  }
  return fields;
}

function initialDraftValue(f) {
  if (f.type === 'boolean') return !!f.value;
  if (f.type === 'json') return prettyJson(f.value ?? {});
  if (f.secret && f.masked) return '';   // 掩码值不放进输入框，留空 + 占位提示
  return f.value === undefined || f.value === null ? '' : String(f.value);
}

function defaultValueFor(f) {
  if (f.hasDefault) {
    if (f.type === 'boolean') return !!f.def;
    if (f.type === 'json') return prettyJson(f.def);
    return f.def === undefined || f.def === null ? '' : String(f.def);
  }
  // 清单没给默认值时的中性值
  if (f.type === 'boolean') return false;
  if (f.type === 'json') return '{}';
  if (f.type === 'enum') {
    const first = f.values?.[0];
    return String((first && typeof first === 'object') ? (first.value ?? '') : (first ?? ''));
  }
  return '';
}

function optionValue(v) {
  return String((v && typeof v === 'object') ? (v.value ?? v.label ?? '') : (v ?? ''));
}

function skillFieldControl(f, value) {
  const attrs = `data-key="${esc(f.key)}" id="skf-${esc(f.key)}"`;
  if (f.type === 'boolean') {
    return `<label class="skill-switch">
      <input type="checkbox" ${attrs} ${value ? 'checked' : ''}>
      <span class="skill-switch-track"></span>
      <span class="skill-switch-text" data-switch-text-for="${esc(f.key)}">${value ? '已开启' : '已关闭'}</span>
    </label>`;
  }
  if (f.type === 'enum') {
    const opts = (f.values || []).map((v) => `<option value="${esc(optionValue(v))}" ${optionValue(v) === String(value) ? 'selected' : ''}>${esc((v && typeof v === 'object') ? (v.label ?? v.value ?? '') : v)}</option>`);
    // 现值不在可选值里（清单改过而配置还是老值）：保留它，别让"打开面板点保存"顺手改掉配置
    if (!(f.values || []).some((v) => optionValue(v) === String(value))) {
      opts.unshift(`<option value="${esc(value)}" selected>${esc(value)}（当前值，不在可选项里）</option>`);
    }
    return `<select ${attrs}>${opts.join('')}</select>`;
  }
  if (f.type === 'json') {
    return `<textarea ${attrs} class="skill-json" rows="4" spellcheck="false">${esc(value)}</textarea>`;
  }
  if (f.multiline) {
    return `<textarea ${attrs} rows="3" spellcheck="false">${esc(value)}</textarea>`;
  }
  if (f.secret) {
    return `<span class="skill-secret">
      <input type="password" ${attrs} value="${esc(value)}" placeholder="${f.masked ? '已保存（留空 = 不修改）' : '未设置'}" autocomplete="new-password" spellcheck="false">
      <button type="button" class="skill-eye" data-act="toggle-secret" data-key="${esc(f.key)}" title="显示 / 隐藏">👁</button>
    </span>`;
  }
  const numAttrs = [
    f.min !== undefined ? `min="${esc(f.min)}"` : '',
    f.max !== undefined ? `max="${esc(f.max)}"` : '',
    f.step !== undefined ? `step="${esc(f.step)}"` : ''
  ].filter(Boolean).join(' ');
  return `<input type="${f.type === 'number' ? 'number' : 'text'}" ${attrs} ${numAttrs} value="${esc(value)}" spellcheck="false">`;
}

function skillFieldHtml(f) {
  const resetBtn = f.hasDefault
    ? `<button type="button" class="skill-reset" data-act="field-reset" data-key="${esc(f.key)}" title="恢复此项默认值">↺</button>`
    : '';
  const tag = f.undeclared ? '<span class="skill-field-tag">未声明</span>' : '';
  const keyHint = f.key !== f.label ? `<code class="skill-field-key">${esc(f.key)}</code>` : '';
  // 数字范围直接标在标签右侧：比让用户在说明里翻「1~50」快得多
  const range = (f.type === 'number' && (f.min !== undefined || f.max !== undefined))
    ? `<span class="skill-range">${f.min !== undefined ? esc(f.min) : '−∞'} ~ ${f.max !== undefined ? esc(f.max) : '∞'}</span>`
    : '';
  return `<div class="skill-field-row" data-field="${esc(f.key)}">
    <div class="skill-field-head">
      <label class="skill-field-label" for="skf-${esc(f.key)}">${esc(f.label)}${f.required ? '<span class="skill-req">*</span>' : ''}${tag}</label>
      <span class="skill-field-head-right">${range}${keyHint}${resetBtn}</span>
    </div>
    ${skillFieldControl(f, skillDrawer.draft[f.key])}
    ${f.description ? `<div class="skill-field-desc">${esc(f.description)}</div>` : ''}
    <div class="skill-field-error" data-error-for="${esc(f.key)}"></div>
  </div>`;
}

/**
 * 说明文字折行：清单作者写的说明常常是三四行（有些超过 200 字），
 * 全部摊开会让 36 个字段的面板变成一堵墙。这里默认折成两行，
 * 只给真正被折叠的那些补一个「展开」按钮（量一下有没有溢出，
 * 不靠字数猜，短说明就完全不多一个按钮）。
 */
function enhanceDescriptions(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('.skill-field-desc, .skill-drawer-desc')) {
    if (el.dataset.enhanced) continue;
    el.dataset.enhanced = '1';
    // 有布局就按真实是否溢出判断（最准）；没有布局（隐藏/无头环境）时退回字数
    const measured = el.clientHeight > 0 || el.scrollHeight > 0;
    const overflowing = measured
      ? el.scrollHeight > el.clientHeight + 1
      : (el.textContent || '').length > 60;
    if (!overflowing) continue;
    el.classList.add('clamped');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skill-desc-toggle';
    btn.dataset.act = 'desc-toggle';
    btn.textContent = '展开';
    el.insertAdjacentElement('afterend', btn);
  }
}

function toggleDescription(btn) {
  const desc = btn.previousElementSibling;
  if (!desc) return;
  const open = desc.classList.toggle('open');
  btn.textContent = open ? '收起' : '展开';
}

function skillGroupHtml(name, fields) {
  return `<section class="skill-group" data-group="${esc(name)}">
    <header class="skill-group-head" data-act="group-toggle" role="button" tabindex="0">
      <span class="skill-group-arrow">▾</span><span class="skill-group-name">${esc(name)}</span>
      <span class="skill-group-count">${fields.length} 项</span>
    </header>
    <div class="skill-group-body">${fields.map(skillFieldHtml).join('')}</div>
  </section>`;
}

const drawerRoot = () => document.getElementById('skill-drawer');

function findDrawerControl(key) {
  const root = drawerRoot();
  if (!root) return null;
  return [...root.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key && el.matches('input, select, textarea')) || null;
}

function findErrorBox(key) {
  const root = drawerRoot();
  if (!root) return null;
  return [...root.querySelectorAll('[data-error-for]')].find((el) => el.dataset.errorFor === key) || null;
}

// ── 抽屉渲染 ──

function drawerSubHtml(sk) {
  const count = allDrawerFields().filter((f) => !f.undeclared).length;
  const groups = new Set(allDrawerFields().map((f) => f.group)).size;
  const mtime = sk.configMtime ? `<span class="skill-mtime" title="data/config.json 的上次修改时间">改于 ${fmtTime(sk.configMtime)}</span>` : '';
  return `<span class="muted">${count} 项设置${groups > 1 ? ` · ${groups} 组` : ''}</span>${mtime}`;
}

function drawerStatePill(sk) {
  return sk.loadError ? '<span class="skill-state bad">异常</span>'
    : (sk.active ? '<span class="skill-state ok">启用</span>' : '<span class="skill-state off">停用</span>');
}

function renderDrawerBody() {
  const body = document.getElementById('skill-drawer-body');
  if (!body) return;
  const scrollTop = body.scrollTop;
  // 分组按首次出现顺序排列（清单作者写的顺序就是语义顺序），「其它（JSON）」天然在最后
  const groups = new Map();
  for (const f of allDrawerFields()) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  const html = [...groups.entries()].map(([name, fs]) => skillGroupHtml(name, fs)).join('');
  body.innerHTML = html || '<div class="empty-hint">这个扩展没有可配置项（只受卡片上的「启用」开关控制）。</div>';
  for (const sec of body.querySelectorAll('.skill-group')) {
    sec.classList.toggle('collapsed', skillDrawer.collapsed.has(sec.dataset.group));
  }
  body.scrollTop = scrollTop;   // 重画不跳位置
  enhanceDescriptions(drawerRoot());
  applyFieldFilter();
  refreshErrors();
  updateDirtyHint();
}

/**
 * 抽屉内字段筛选：字段多（点歌插件 35 项）时靠滚动找一项太慢。
 * 只隐藏不匹配的行，不重画 —— 输入焦点和已填内容都不受影响。
 */
function applyFieldFilter() {
  const root = drawerRoot();
  if (!root) return;
  const q = skillDrawer.fieldQuery.trim().toLowerCase();
  let visible = 0;
  for (const sec of root.querySelectorAll('.skill-group')) {
    let hit = 0;
    for (const row of sec.querySelectorAll('.skill-field-row')) {
      const f = allDrawerFields().find((x) => x.key === row.dataset.field);
      const hay = f ? `${f.key} ${f.label} ${f.description}`.toLowerCase() : '';
      const show = !q || hay.includes(q);
      row.hidden = !show;
      if (show) hit++;
    }
    sec.hidden = hit === 0;
    visible += hit;
  }
  const nohit = document.getElementById('skill-field-nohit');
  if (nohit) nohit.hidden = !(q && visible === 0);
}

function updateDirtyHint() {
  const dirty = skillDrawerDirty();
  const hint = document.getElementById('skill-dirty-hint');
  if (hint) hint.hidden = !dirty;
  const saveBtn = drawerRoot()?.querySelector('[data-act="save-settings"]');
  if (saveBtn && !skillDrawer.saving) saveBtn.disabled = hasErrors();
}

function updateDrawerHead() {
  if (!skillDrawer.skill) return;
  const sub = document.getElementById('skill-drawer-sub');
  if (sub) sub.innerHTML = drawerSubHtml(skillDrawer.skill);
  const state = document.getElementById('skill-drawer-state');
  if (state) state.innerHTML = drawerStatePill(skillDrawer.skill);
}

// ── 草稿 / 校验 ──

function skillDrawerDirty() {
  for (const f of allDrawerFields()) {
    if (!fieldValueEqual(f, skillDrawer.draft[f.key], skillDrawer.original[f.key])) return true;
  }
  return false;
}

function fieldValueEqual(f, a, b) {
  if (f.type === 'json') {
    // JSON 按"解析后的语义"比：只调整缩进/换行不算修改
    try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch { return String(a ?? '').trim() === String(b ?? '').trim(); }
  }
  if (f.type === 'boolean') return !!a === !!b;
  return String(a ?? '') === String(b ?? '');
}

function validateField(f, raw) {
  if (f.type === 'boolean') return '';
  const text = String(raw ?? '');
  if (f.type === 'json') {
    if (!text.trim()) return '';   // 留空 = 本次不提交这个字段
    try { JSON.parse(text); } catch (e) { return `JSON 格式错误：${e.message}`; }
    return '';
  }
  if (f.type === 'number') {
    if (!text.trim()) {
      if (f.required) return '必填';
      // 本来有值却被清空：拦住并说清楚 —— 否则这个字段会被静默跳过，
      // 用户以为改成功了（number input 里敲字母也会变成空串，同样落进这里）
      return (f.value !== undefined && f.value !== null && f.value !== '') ? '请填数字（不想改就点 ↺ 恢复默认）' : '';
    }
    const n = Number(text);
    if (!Number.isFinite(n)) return '请填数字';
    if (f.min !== undefined && n < Number(f.min)) return `不能小于 ${f.min}`;
    if (f.max !== undefined && n > Number(f.max)) return `不能大于 ${f.max}`;
    return '';
  }
  if (f.required && !text.trim()) return '必填';
  // 枚举：打开面板时若现值不在可选项里，下拉会额外插入一条"当前值"，
  // 校验要认它，不能一打开就报错（那会白白禁用保存按钮）
  if (f.type === 'enum' && f.values?.length && text !== String(f.value ?? '')
    && !f.values.some((v) => optionValue(v) === text)) return '不是可选项里的值';
  return '';
}

function validateAll() {
  const errors = {};
  for (const f of allDrawerFields()) {
    const msg = validateField(f, skillDrawer.draft[f.key]);
    if (msg) errors[f.key] = msg;
  }
  skillDrawer.errors = errors;
  return errors;
}

function hasErrors() {
  return Object.values(skillDrawer.errors).some(Boolean);
}

function refreshErrors() {
  const errors = validateAll();
  for (const f of allDrawerFields()) {
    const msg = errors[f.key] || '';
    const box = findErrorBox(f.key);
    if (box) box.textContent = msg;
    const row = box?.closest('.skill-field-row');
    if (row) row.classList.toggle('has-error', !!msg);
  }
  const saveBtn = drawerRoot()?.querySelector('[data-act="save-settings"]');
  if (saveBtn && !skillDrawer.saving) saveBtn.disabled = hasErrors();
}

function focusField(key) {
  const el = findDrawerControl(key);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
  if (typeof el.select === 'function' && el.tagName !== 'SELECT') { try { el.select(); } catch { /* number input 不支持 select */ } }
}

function setControlValue(f, value) {
  const el = findDrawerControl(f.key);
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = !!value;
    const t = [...drawerRoot().querySelectorAll('[data-switch-text-for]')].find((x) => x.dataset.switchTextFor === f.key);
    if (t) t.textContent = value ? '已开启' : '已关闭';
  } else {
    el.value = value;
  }
}

// ── 抽屉交互 ──

function onDrawerInput(ev) {
  const el = ev.target;
  if (el?.id === 'skill-field-search') {
    skillDrawer.fieldQuery = el.value || '';
    applyFieldFilter();
    return;
  }
  const key = el?.dataset?.key;
  if (!key || !(key in skillDrawer.draft)) return;
  skillDrawer.draft[key] = el.type === 'checkbox' ? !!el.checked : el.value;
  if (el.type === 'checkbox') {
    const t = [...drawerRoot().querySelectorAll('[data-switch-text-for]')].find((x) => x.dataset.switchTextFor === key);
    if (t) t.textContent = el.checked ? '已开启' : '已关闭';
  }
  skillDrawer.touched.add(key);
  refreshErrors();      // 就地校验，不抢焦点
  updateDirtyHint();
}

function toggleSecret(key) {
  const el = findDrawerControl(key);
  const btn = [...drawerRoot().querySelectorAll('[data-act="toggle-secret"]')].find((b) => b.dataset.key === key);
  if (!el) return;
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  if (btn) btn.textContent = show ? '🙈' : '👁';
}

function toggleGroup(section) {
  if (!section) return;
  const name = section.dataset.group;
  const collapsed = !section.classList.contains('collapsed');
  section.classList.toggle('collapsed', collapsed);
  if (collapsed) skillDrawer.collapsed.add(name);
  else skillDrawer.collapsed.delete(name);
}

function resetFieldToDefault(key) {
  const f = allDrawerFields().find((x) => x.key === key);
  if (!f) return;
  const val = defaultValueFor(f);
  skillDrawer.draft[key] = val;
  skillDrawer.touched.add(key);
  setControlValue(f, val);
  refreshErrors();
  updateDirtyHint();
}

function resetAllToDefaults() {
  for (const f of allDrawerFields()) {
    skillDrawer.draft[f.key] = defaultValueFor(f);
    skillDrawer.touched.add(f.key);
  }
  renderDrawerBody();
  showToast('已填入默认值，点「保存」生效', 'info');
}

function discardChanges() {
  skillDrawer.draft = { ...skillDrawer.original };
  skillDrawer.touched.clear();
  renderDrawerBody();
  showToast('已撤销修改', 'info');
}

function showDrawerError(msg) {
  const bar = document.getElementById('skill-drawer-errorbar');
  if (!bar) return;
  bar.textContent = msg;
  bar.hidden = !msg;
}

function setSaving(flag) {
  skillDrawer.saving = flag;
  const btn = drawerRoot()?.querySelector('[data-act="save-settings"]');
  if (btn) {
    btn.textContent = flag ? '保存中…' : '保存';
    btn.disabled = flag || hasErrors();
  }
}

/** 只提交这个扩展的 settings：草稿 → 后端需要的类型。 */
function collectSkillSettings() {
  const out = {};
  for (const f of allDrawerFields()) {
    const raw = skillDrawer.draft[f.key];
    const text = String(raw ?? '');
    if (f.type === 'boolean') { out[f.key] = !!raw; continue; }
    if (!text.trim() && f.type !== 'string') continue;   // 空数字 / 空 JSON = 本次不改
    if (f.type === 'json') { out[f.key] = JSON.parse(text); continue; }
    if (f.type === 'number') { out[f.key] = Number(text); continue; }
    if (f.type === 'enum') {
      // 沿用清单里的原始类型：数字型枚举别被下拉框悄悄变成字符串
      const hit = (f.values || []).find((v) => optionValue(v) === text);
      out[f.key] = (hit && typeof hit === 'object') ? (hit.value ?? text) : (hit ?? text);
      continue;
    }
    // 密文：掩码没动（输入框还是空的）就别提交，免得把 '******' 或空串写回去
    if (f.secret && f.masked && !text.trim()) continue;
    out[f.key] = text;
  }
  return out;
}

async function saveSkillSettings() {
  if (!skillDrawer.id || skillDrawer.saving) return;
  refreshErrors();
  const errKeys = Object.entries(skillDrawer.errors).filter(([, m]) => m).map(([k]) => k);
  if (errKeys.length) {
    // 有错就地提示 + 聚焦第一个：用户不用自己找哪一项红了
    focusField(errKeys[0]);
    showDrawerError(`有 ${errKeys.length} 处需要修正，已定位到第一个（红线处）。`);
    return;
  }
  showDrawerError('');
  setSaving(true);
  try {
    const r = await api('/api/skills/config', {
      method: 'POST',
      body: JSON.stringify({ id: skillDrawer.id, settings: collectSkillSettings() })
    });
    applySavedSkill(r);
    showToast('已保存');
  } catch (e) {
    // 失败保留面板与草稿：用户改的东西不能因为一次网络错误就没了
    showDrawerError(`保存失败：${e.message}`);
  } finally {
    setSaving(false);
  }
}

/** 保存成功：更新本地缓存 → 只重画这张卡片 → 刷新抽屉快照。 */
function applySavedSkill(r) {
  const sk = (skillsData?.skills || []).find((s) => s.id === skillDrawer.id);
  if (!sk) return;
  if (r?.settings) sk.settings = r.settings;
  if (r?.skill) {
    sk.active = !!r.skill.active;
    sk.enabled = !!r.skill.enabled;
    sk.loadError = r.skill.loadError || '';
    sk.reason = r.skill.reason || sk.reason;
  }
  sk.configMtime = Date.now();     // 后端刚写过 config.json，等同"刚改过"
  refreshSkillCardNode(sk);
  // 抽屉重取值：密文字段回到掩码态、枚举/JSON 重新对齐后端，"有未保存修改"随之清掉
  skillDrawer.skill = sk;
  skillDrawer.fields = buildSkillFields(sk);
  skillDrawer.draft = {};
  for (const f of skillDrawer.fields) skillDrawer.draft[f.key] = initialDraftValue(f);
  skillDrawer.original = { ...skillDrawer.draft };
  skillDrawer.touched.clear();
  renderDrawerBody();
  updateDrawerHead();
}

function requestCloseSkillDrawer() {
  if (skillDrawerDirty() && !confirm('设置还没保存，确定放弃修改并关闭？')) return;
  closeSkillDrawer();
}

function closeSkillDrawer() {
  document.removeEventListener('keydown', onDrawerKeydown);
  document.body.classList.remove('skill-drawer-open');
  drawerRoot()?.remove();
  skillDrawer.id = null;
  skillDrawer.skill = null;
  skillDrawer.fields = [];
  skillDrawer.draft = {};
  skillDrawer.original = {};
  skillDrawer.touched.clear();
  skillDrawer.errors = {};
  skillDrawer.collapsed.clear();
  skillDrawer.fieldQuery = '';
  skillDrawer.saving = false;
  // 抽屉期间被推迟的卡片重画，现在补上（重画会重建搜索框，值取自 skillQuery 不丢）
  if (skillsRenderDeferred) {
    skillsRenderDeferred = false;
    if (skillsData) renderSkillsPage(skillsData, skillsToolsData);
  }
}

function onDrawerClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) {
    // 点遮罩空白 = 关闭；有未保存修改时同样走二次确认
    if (ev.target.classList?.contains('skill-drawer-overlay')) requestCloseSkillDrawer();
    return;
  }
  const act = btn.dataset.act;
  if (act === 'drawer-close') return requestCloseSkillDrawer();
  if (act === 'group-toggle') return toggleGroup(btn.closest('.skill-group'));
  if (act === 'desc-toggle') return toggleDescription(btn);
  if (act === 'toggle-secret') return toggleSecret(btn.dataset.key);
  if (act === 'field-reset') return resetFieldToDefault(btn.dataset.key);
  if (act === 'reset-all') return resetAllToDefaults();
  if (act === 'discard') return discardChanges();
  if (act === 'save-settings') return saveSkillSettings();
}

// Ctrl/Cmd+S 保存、Esc 关闭（有改动先确认）。
// 直接挂在 document 上而不是面板上：面板里焦点可能在任意控件，冒泡到 document 最稳。
function onDrawerKeydown(ev) {
  if (!skillDrawer.id) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    requestCloseSkillDrawer();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
    ev.preventDefault();
    saveSkillSettings();
    return;
  }
  // 分组头用 role=button，补上键盘可达性
  if (ev.key === 'Enter' && ev.target?.classList?.contains('skill-group-head')) {
    ev.preventDefault();
    ev.target.click();
  }
}

function openSkillDrawer(id) {
  const sk = (skillsData?.skills || []).find((s) => s.id === id);
  if (!sk) return;
  if (skillDrawer.id) closeSkillDrawer();
  skillDrawer.id = sk.id;
  skillDrawer.skill = sk;
  skillDrawer.fields = buildSkillFields(sk);
  skillDrawer.draft = {};
  for (const f of skillDrawer.fields) skillDrawer.draft[f.key] = initialDraftValue(f);
  skillDrawer.original = { ...skillDrawer.draft };
  skillDrawer.touched.clear();
  skillDrawer.errors = {};
  skillDrawer.collapsed.clear();
  skillDrawer.fieldQuery = '';

  const overlay = document.createElement('div');
  overlay.className = 'skill-drawer-overlay';
  overlay.id = 'skill-drawer';
  overlay.innerHTML = `
    <aside class="skill-drawer" role="dialog" aria-modal="true" aria-label="扩展设置">
      <header class="skill-drawer-head">
        <div class="skill-drawer-title-box">
          <div class="skill-drawer-title">
            <b>${esc(sk.name || sk.id)}</b>
            <span class="skill-kind">${skillKindLabel(sk)}</span>
            <span class="skill-ver">v${esc(sk.version || '')}</span>
            <span id="skill-drawer-state">${drawerStatePill(sk)}</span>
          </div>
          <div class="skill-drawer-sub" id="skill-drawer-sub">${drawerSubHtml(sk)}</div>
          ${sk.loadError ? `<div class="skill-drawer-loaderr">${esc(sk.loadError)}</div>` : ''}
          ${sk.description ? `<div class="skill-drawer-desc">${esc(sk.description)}</div>` : ''}
        </div>
        <button type="button" class="skill-drawer-close" data-act="drawer-close" title="关闭（Esc）">✕</button>
      </header>
      <div class="skill-drawer-toolbar">
        <input id="skill-field-search" class="skill-field-search" placeholder="筛选字段（名称 / key / 说明）" autocomplete="off">
        <span class="muted skill-drawer-toolbar-hint">改完按 Ctrl+S 保存</span>
      </div>
      <div class="skill-drawer-body" id="skill-drawer-body"></div>
      <div class="skill-drawer-nohit" id="skill-field-nohit" hidden>没有匹配的字段</div>
      <div class="skill-drawer-errorbar" id="skill-drawer-errorbar" hidden></div>
      <footer class="skill-drawer-foot">
        <span class="skill-dirty" id="skill-dirty-hint" hidden>● 有未保存修改</span>
        <div class="skill-drawer-foot-right">
          <button type="button" class="btn-mini" data-act="reset-all" title="把所有字段填回清单默认值（点「保存」才生效）">恢复默认</button>
          <button type="button" class="btn-mini" data-act="discard" title="丢弃本次修改，回到打开面板时的值">撤销修改</button>
          <button type="button" class="btn btn-small btn-primary" data-act="save-settings" title="保存（Ctrl/Cmd + S）">保存</button>
        </div>
      </footer>
    </aside>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', onDrawerClick);
  overlay.addEventListener('input', onDrawerInput);
  overlay.addEventListener('change', onDrawerInput);
  document.addEventListener('keydown', onDrawerKeydown);
  // 锁定背景滚动：抽屉内部自己滚，背景别跟着动
  document.body.classList.add('skill-drawer-open');
  renderDrawerBody();
  enhanceDescriptions(overlay);
  overlay.querySelector('.skill-drawer-close')?.focus();
}

// ── 工具清单渲染（客户端过滤，不重新请求）──
let toolSearch = '';
let toolOnlyUnavailable = false;

function toolRowMarkup(t) {
  const a = t.availability || {};
  const checked = t.override !== false;
  const status = !a.enabled
    ? `<span class="cap-warn" title="${esc(a.reason || '')}">不可用</span><div class="tool-reason">${esc(a.reason || '')}</div>`
    : (t.masterOnly
      ? '<span class="cap-off">仅主人</span>'
      : (t.tutorOnly ? '<span class="cap-off">仅学习模式</span>' : '<span class="cap-ok">可用</span>'));
  // 卸载：工具本身是扩展注册的，单个删不掉 —— 只能把提供它的扩展卸掉（其余工具一起消失）
  const uninstall = t.builtin || !t.skillId
    ? '<span class="tool-remove muted" title="内置工具，随核心一起，不能单独卸载">—</span>'
    : `<button class="btn-mini tool-remove" data-act="tool-uninstall" data-skill="${esc(t.skillId)}" data-tool="${esc(t.id)}"
        title="卸载提供这个工具的扩展「${esc(t.skillId)}」（它注册的其它工具会一起消失）">卸载</button>`;
  return `<div class="tool-row">
    <div class="tool-main"><code>${esc(t.id)}</code><div class="tool-desc muted">${esc(t.description || '')}</div></div>
    <div class="tool-src">${t.builtin ? '内置' : '扩展 ' + esc(t.skillId || '')}</div>
    <div class="tool-cat">${esc(t.category || '')}</div>
    <div class="tool-state">${status}</div>
    <label class="tool-toggle"><input type="checkbox" data-act="tool-toggle" data-id="${esc(t.id)}" ${checked ? 'checked' : ''}></label>
    ${uninstall}
  </div>`;
}

function renderToolRows() {
  const box = $('#tool-rows');
  if (!box) return;
  const q = toolSearch.trim().toLowerCase();
  const rows = (state.tools || []).filter((t) => {
    if (toolOnlyUnavailable && t.availability?.enabled) return false;
    if (!q) return true;
    return (t.id + ' ' + (t.description || '') + ' ' + (t.category || '')).toLowerCase().includes(q);
  }).map(toolRowMarkup).join('');
  box.innerHTML = `<div class="tool-row tool-head"><div>工具</div><div>来源</div><div>分类</div><div>状态</div><div>启用</div><div>卸载</div></div>`
    + (rows || '<div class="empty-hint">没有匹配的工具</div>');
}

async function onSkillsChange(ev) {
  const card = ev.target.closest('.skill-card');
  // 安装包选择：读成 base64 交给后端校验+解压
  if (ev.target.id === 'skill-zip') {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      const r = await api('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, dataBase64: b64 })
      });
      if (!r.ok) {
        alert('安装失败：' + (r.error || '未知错误'));
        return;
      }
      // 说人话：装的是哪个扩展、是不是覆盖了旧的。
      // 以前这里弹的是"加载：<全量 id 列表>"，看着像成功，其实根本对不上新装的那个。
      const verb = (r.replaced || []).length ? '已覆盖安装' : '已安装';
      showToast(`${verb} ${r.name || r.id}${r.version ? ' v' + r.version : ''}`, 'ok');
      if (r.loadError) {
        alert(`已安装到 ${r.dir}，但加载失败：\n${r.loadError}`);
      }
      await loadSkillsPage();
      highlightSkillCard(r.id);
    } catch (e) {
      alert('安装失败：' + e.message);
    } finally {
      ev.target.value = '';
    }
    return;
  }
  // 卡片搜索：过滤扩展名/描述/字段名，纯客户端，不重新请求
  if (ev.target.id === 'skill-search') {
    skillQuery = ev.target.value || '';
    renderSkillCards();
    return;
  }
  // 工具清单：搜索 / 只看不可用 / 单项开关
  if (ev.target.id === 'tool-search') { toolSearch = ev.target.value || ''; renderToolRows(); return; }
  if (ev.target.id === 'tool-only-unavailable') { toolOnlyUnavailable = !!ev.target.checked; renderToolRows(); return; }
  if (ev.target.dataset.act === 'tool-toggle') {
    if (ev.type !== 'change') return;           // checkbox 同时触发 input+change，只处理一次
    const toolId = ev.target.dataset.id;
    try {
      await api('/api/tools/toggle', {
        method: 'POST',
        body: JSON.stringify({ id: toolId, enabled: ev.target.checked })
      });
      await loadSkillsPage();
    } catch (e) {
      alert('切换工具失败：' + e.message);
      await loadSkillsPage();
    }
    return;
  }
  if (!card) return;
  if (ev.target.dataset.act !== 'toggle') return;
  const id = card.dataset.id;
  try {
    await api('/api/skills/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, enabled: ev.target.checked })
    });
    await loadSkillsPage();
  } catch (e) {
    alert('切换失败：' + e.message);
    await loadSkillsPage();
  }
}

async function onSkillsClick(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const card = btn.closest('.skill-card');
  const id = card?.dataset.id;
  try {
    if (act === 'reload') {
      await api('/api/skills/reload', { method: 'POST' });
      await loadSkillsPage();
      return;
    }
    if (act === 'install') {
      const input = $('#skill-zip');
      if (input) input.click();
      return;
    }
    if (act === 'tool-uninstall') {
      const skillId = btn.dataset.skill;
      const toolId = btn.dataset.tool || '';
      if (!skillId) return;
      if (!confirm(`卸载扩展「${skillId}」？\n\n它注册的所有工具（包括「${toolId}」）都会一起消失，目录也会被删除。`)) return;
      await api('/api/skills/uninstall', { method: 'POST', body: JSON.stringify({ id: skillId }) });
      await loadSkillsPage();
      showToast(`已卸载 ${skillId}`, 'info');
      return;
    }
    if (act === 'dedupe') {
      if (!confirm('清理重复副本？\n\n同一个扩展的多份目录只保留当前生效的那一份，其余删除。')) return;
      const r = await api('/api/skills/dedupe', { method: 'POST', body: '{}' });
      await loadSkillsPage();
      showToast(r.removed?.length ? `已清理 ${r.removed.length} 份重复副本` : '没有需要清理的副本', 'info');
      return;
    }
    if (act === 'filter') {
      skillFilter = btn.dataset.filter || 'all';
      updateSkillFilterChips();
      renderSkillCards();
      return;
    }
    if (act === 'filter-reset') {
      skillQuery = '';
      skillFilter = 'all';
      if (skillsData) renderSkillsPage(skillsData, skillsToolsData);
      return;
    }
    if (act === 'settings') {
      openSkillDrawer(id);
      return;
    }
    if (act === 'panel') {
      window.open(`/plugin-ui/${encodeURIComponent(id)}/index.html`, '_blank');
      return;
    }
    if (act === 'uninstall') {
      if (!confirm(`卸载 ${id} 并删除目录？`)) return;
      await api('/api/skills/uninstall', { method: 'POST', body: JSON.stringify({ id }) });
      await loadSkillsPage();
      return;
    }
  } catch (e) {
    alert('操作失败：' + e.message);
  }
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'snowluma') loadSnowlumaPage();
  if (name === 'skills') loadSkillsPage();
  if (name === 'settings') loadSettings();
  if (name.startsWith('panel-')) {
    const firstPlugin = panelTabs.get(name);
    if (firstPlugin) ensurePanelLoaded(firstPlugin);
  }
}

// ── 扩展自带的控制台页签 ─────────────────────────────────────────────
// 扩展在自己目录里放 ui/panel.json（{id,title,entry}），控制台就会多一个页签，
// 内容是 /plugin-ui/<id>/<entry>。以前插件只能去改 ui/index.html 塞 tab，一升级就被覆盖。
const panelFrames = new Map();   // 插件 id -> iframe
const panelTabs = new Map();     // 页签 id -> 第一个插件 id（切页时按需加载它的 iframe）

function ensurePanelLoaded(id) {
  const frame = panelFrames.get(id);
  if (frame && !frame.src) frame.src = frame.dataset.src;
}

async function loadPluginPanels() {
  let panels = [];
  try {
    const r = await api('/api/plugin-panels');
    panels = r.panels || [];
  } catch {
    return;
  }
  const tabs = $('#tabs');
  const layout = $('#layout');
  if (!tabs || !layout) return;
  // 按 group 归并：同一组的插件共用一个页签，页签内再用子页切换
  const groups = new Map();
  for (const p of panels) {
    const key = p.group || `__id__${p.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  for (const [key, list] of groups) {
    const isGroup = !key.startsWith('__id__');
    const tabId = isGroup ? `panel-group-${key}` : `panel-${list[0].id}`;
    if (panelTabs.has(tabId)) continue;

    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.tab = tabId;
    btn.textContent = isGroup ? key : list[0].title;
    const allOff = list.every((x) => x.enabled === false);
    if (allOff) btn.textContent += '·停用';
    tabs.appendChild(btn);

    const section = document.createElement('section');
    section.className = 'view';
    section.id = `view-${tabId}`;

    const makeFrame = (p) => {
      const frame = document.createElement('iframe');
      frame.className = 'plugin-panel-frame';
      frame.dataset.src = `/plugin-ui/${encodeURIComponent(p.id)}/${encodeURIComponent(p.entry)}`;
      frame.title = p.title;
      frame.loading = 'lazy';
      panelFrames.set(p.id, frame);
      return frame;
    };

    if (list.length === 1) {
      section.appendChild(makeFrame(list[0]));
    } else {
      // 多个插件合成一页：顶部子页签
      const bar = document.createElement('div');
      bar.className = 'panel-subtabs';
      const stack = document.createElement('div');
      stack.className = 'panel-stack';
      list.forEach((p, i) => {
        const sub = document.createElement('button');
        sub.className = `panel-subtab${i === 0 ? ' on' : ''}`;
        sub.dataset.panel = p.id;
        sub.textContent = p.enabled === false ? `${p.title}·停用` : p.title;
        bar.appendChild(sub);
        const frame = makeFrame(p);
        frame.classList.toggle('on', i === 0);
        stack.appendChild(frame);
      });
      bar.addEventListener('click', (ev) => {
        const sub = ev.target.closest('.panel-subtab');
        if (!sub) return;
        bar.querySelectorAll('.panel-subtab').forEach((b) => b.classList.toggle('on', b === sub));
        stack.querySelectorAll('iframe').forEach((f) => {
          f.classList.toggle('on', f === panelFrames.get(sub.dataset.panel));
        });
        ensurePanelLoaded(sub.dataset.panel);
      });
      section.appendChild(bar);
      section.appendChild(stack);
    }

    layout.appendChild(section);
    panelTabs.set(tabId, list[0].id);   // 切到这个页签时先加载第一个子页
  }
}

// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    // ⚠️ 关键：WS 连着 ≠ 账号可用。NapCat 的 WS 在账号离线时依然在监听，
    // 只看 connected 会让"掉线"显示成"已连接"（2026-09-14 事故）。
    const acct = s.onebot.account || {};
    const acctOffline = acct.online === false;
    const acctUnknown = acct.online === null || acct.online === undefined;
    if (acctOffline) {
      dot.className = 'dot dot-off';
      const mins = acct.offlineMs ? Math.round(acct.offlineMs / 60000) : 0;
      label.textContent = `⚠ QQ 账号已离线${mins ? `（${mins} 分钟）` : ''} —— 机器人收不到消息，请检查登录`;
    } else if (s.onebot.connected) {
      dot.className = 'dot ' + (acctUnknown ? 'dot-wait' : 'dot-on');
      label.textContent = `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
        + (acctUnknown ? ' · 账号状态未探测' : '');
    } else {
      dot.className = 'dot ' + (s.onebot.everConnected ? 'dot-wait' : 'dot-off');
      label.textContent = 'OneBot 未连接';
    }
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${u.cost ? ` · ¥${u.cost.toFixed(2)}` : ''}`;
    // 显式展示时区（记忆系统 01 第六节：页面时间必须让用户看到北京时间）
    const tzEl = document.getElementById('tz-label');
    if (tzEl) {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const off = -d.getTimezoneOffset() / 60;
      tzEl.textContent = `北京时间 ${p2(d.getHours())}:${p2(d.getMinutes())}（UTC${off >= 0 ? '+' : ''}${off}）`;
    }
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => { loadSessions(); refreshStatus(); });
  es.addEventListener('session-update', (ev) => {
    const id = JSON.parse(ev.data).sessionId;
    if (id === state.currentSessionId) loadSessionDetail(id, { quiet: true });
    const item = state.sessions.find((s) => s.id === id);
    if (item && item.status !== 'done' && item.status !== 'noreply') loadSessions({ quiet: true });
  });
  es.addEventListener('session-end', () => {
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });  es.addEventListener('onebot-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('status', () => refreshStatus());
  // 账号健康事件：掉线/恢复时立即刷新界面，不必等 15 秒轮询
  es.addEventListener('onebot-health', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  // 扩展热重载/开关变化：正在看技能页时立即刷新
  es.addEventListener('skills-changed', () => { if (state.tab === 'skills') loadSkillsPage(); });
  es.addEventListener('snowluma-log', (ev) => {
    const d = JSON.parse(ev.data);
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    const data = await api('/api/sessions?limit=80');
    state.sessions = data.sessions || [];
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const running = state.sessions.find((s) => s.status === 'running');
      if (running) selectSession(running.id);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
setInterval(() => {
  if (state.tab === 'sessions') loadSessions({ quiet: true });
  if (state.tab === 'chats') loadChats({ quiet: true });
  if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
  if (state.tab === 'settings') refreshStatus();
}, 4000);

function renderSessionList() {
  const box = $('#session-items');
  box.innerHTML = state.sessions.map((s) => {
    const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''}" data-id="${s.id}">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          <span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span>
          <span>${s.rounds || 0} 轮</span>
        </div>
      </div>`;
  }).join('');
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.blocked ? 1 : 0}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`
    + (s.blocked ? `<span class="status-badge status-blocked" title="${esc(s.blockReason || '')}">已拦截${s.blockCode ? ' · ' + esc(s.blockCode) : ''}</span>` : '');
  const usage = s.usage || {};

  const html = [];
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}</h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
        ${s.blocked ? `<span class="block-reason">本轮未请求模型：${esc(s.blockReason || s.blockCode || '被扩展拦截')}</span>` : ''}
      </div>
    </div>`);

  if (s.systemPrompt) {
    html.push(`
      <details class="collapsible">
        <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
        <div class="coll-body">${esc(s.systemPrompt)}</div>
      </details>`);
  }
  if (s.userPrompt) {
    html.push(`
      <details class="collapsible" open>
        <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
        <div class="coll-body">${esc(s.userPrompt)}</div>
      </details>`);
  }

  html.push('<div class="msg-flow">');
  for (const item of s.messages || []) {
    if (item.toolCall) {
      html.push(`
        <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
          <div class="tool-head"><span class="tool-name">${esc(item.toolCall.name)}</span></div>
          <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
          <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
        </div>`);
    } else if (item.toolImages) {
      html.push(`
        <div class="tool-card">
          <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
          <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
        </div>`);
    } else if (item.role === 'assistant') {
      const text = typeof item.content === 'string' ? item.content : '';
      if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
      html.push(`
        <div class="bubble bubble-assistant">
          <div class="asr-label">思考（不发送）</div>
          ${esc(text || '（无文本输出，仅调用工具）')}
        </div>`);
    }
  }
  // 发出的消息
  for (const sent of s.sent || []) {
    html.push(`
      <div class="sent-badge">
        <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}</div>
        ${esc(sent.text)}
      </div>`);
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  if (s.status === 'running') {
    // 运行中轮询（仅当前打开的会话详情）
    setTimeout(() => { if (state.currentSessionId === s.id && state.tab === 'sessions') loadSessionDetail(s.id, { quiet: true }); }, 1500);
  }
}

// ── 协议端页签（data-tab="snowluma"，历史命名保留）：防闪烁基础设施 ──
// 本页每 4 秒被全局定时器刷新一次。早期实现每次都 `box.innerHTML = ...` 整块重建卡片，
// 导致二维码 <img> 与日志 <pre> 反复销毁重建、图片重复下载 → 屏幕持续闪烁。
// 现在：骨架只建一次（事件也只绑一次），之后只"按需打补丁"更新变化的文本；
// 二维码仅在 NapCat 换码（qrAt 变化）时才换 src。
const SL = { built: false, bound: false, qrTimer: null, qrAt: '', loggedIn: null, logText: '' };

function slEl(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = slEl(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function setDot(id, on) {
  const el = slEl(id);
  if (!el) return;
  const want = on ? 'dot dot-on' : 'dot dot-off';
  if (el.className !== want) el.className = want;
}

/** 建立卡片骨架 + 绑定事件（只做一次）。 */
function buildSnowlumaSkeleton() {
  const box = slEl('snowluma-page');
  if (!box || SL.built) return;
  box.innerHTML = `
    <div class="snowluma-page-card">
      <div class="snowluma-head">
        <h2>QQ 协议端<span class="muted sl-backend" id="sl-txt-backend"></span></h2>
        <div class="snowluma-qr" id="sl-qr-panel"></div>
      </div>
      <div class="sl-login" id="sl-login-panel"></div>
      <!-- 账号总览与一键切号（2026-09-16 新增，见 renderAccountsPanel） -->
      <div class="sl-accounts" id="sl-accounts-panel"></div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-run"></span>
        <span>协议端：<strong id="sl-txt-run"></strong></span>
        <span class="muted" id="sl-txt-pid"></span>
        <span class="muted" id="sl-txt-mode"></span>
      </div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-ob"></span>
        <span>OneBot：<strong id="sl-txt-ob"></strong></span>
        <span class="muted" id="sl-txt-obws"></span>
      </div>
      <div class="snowluma-state-row muted"><span id="sl-txt-dir"></span></div>
      <div class="snowluma-state-row">
        <span>WebUI：</span>
        <span id="sl-webui-slot"></span>
      </div>
      <div class="snowluma-actions">
        <button class="btn btn-primary" id="sl-start-btn">启动协议端</button>
        <button class="btn btn-danger" id="sl-stop-btn">关闭协议端</button>
        <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
        <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
        <span id="sl-hint" class="muted" style="font-size:12px"></span>
      </div>
      <div>
        <div class="hint" style="margin-bottom:6px">运行日志（实时滚动，仅保留最近 500 行）</div>
        <pre class="snowluma-logs-view" id="sl-logs"></pre>
      </div>
    </div>`;
  SL.built = true;
  bindSnowlumaEvents();
}

function bindSnowlumaEvents() {
  if (SL.bound) return;
  SL.bound = true;

  slEl('sl-start-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-start-btn');
    btn.disabled = true; btn.textContent = '启动中…';
    setText('sl-hint', '');
    try {
      const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
      setText('sl-hint', r.alreadyRunning ? '协议端已经在运行 ✓' : (r.ok ? '已启动，日志见下方。' : ('启动失败：' + r.error)));
    } catch (e) { setText('sl-hint', '启动失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
  });

  slEl('sl-stop-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-stop-btn');
    btn.disabled = true; btn.textContent = '关闭中…';
    setText('sl-hint', '');
    try {
      await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
      setText('sl-hint', '已请求关闭协议端。');
    } catch (e) { setText('sl-hint', '关闭失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
  });

  slEl('sl-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage());
  slEl('sl-open-folder-btn')?.addEventListener('click', async () => {
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { setText('sl-hint', '失败：' + e.message); }
  });
}

// ── 账号密码登录（含人机验证中转）──
// 目的：QQ 风控掉线时，用户可在面板里自助用账密登录，不必找管理员扫码。
// 安全：**密码明文不出浏览器** —— 前端算 MD5 后只把 passwordMd5 发给后端。
// 人机验证走腾讯 TCaptcha（NapCat 返回的 proofWaterUrl 里带 aid/sid），
// 验证通过拿到 ticket/randstr 再回传后端完成登录。
const SLLogin = { uin: '', passwordMd5: '', capSid: '', capAid: '', busy: false, timer: null };

/** 纯 JS MD5（同步，无依赖）。密码只在这里转成 MD5，明文不上行。 */
function md5(str) {
  // 精简实现（RFC 1321），足够登录用
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function au(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function tb(str2) {
    const n = ((str2.length + 8) >> 6) + 1;
    const blk = new Array(n * 16).fill(0);
    for (let i = 0; i < str2.length; i++) blk[i >> 2] |= str2.charCodeAt(i) << ((i % 4) * 8);
    blk[str2.length >> 2] |= 0x80 << ((str2.length % 4) * 8);
    blk[n * 16 - 2] = str2.length * 8;
    return blk;
  }
  function hex(num) { let s2 = ''; for (let i = 0; i < 4; i++) s2 += ('0' + ((num >> (i * 8)) & 0xff).toString(16)).slice(-2); return s2; }
  const utf8 = unescape(encodeURIComponent(str));
  const x = tb(utf8);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function slLoginMsg(text, kind) {
  const el = slEl('sl-login-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'sl-login-msg' + (kind ? ' ' + kind : '');
}

function renderSnowlumaLogin(info) {
  const box = slEl('sl-login-panel');
  if (!box) return;
  if (!info?.available) {
    box.innerHTML = '<div class="muted" style="font-size:12.5px">未找到 NapCat WebUI 配置，无法使用账密登录。</div>';
    return;
  }
  box.innerHTML = `
    <div class="sl-login-title">账号密码登录 <span class="muted">（风控掉线时用，免扫码）</span></div>
    <div class="field-row">
      <div class="field" style="max-width:170px">
        <label>QQ 号</label>
        <input type="text" id="sl-uin" placeholder="如 3831864262" autocomplete="username">
      </div>
      <div class="field">
        <label>QQ 密码 <span class="muted">（仅在本机浏览器算 MD5，明文不上传）</span></label>
        <input type="password" id="sl-pwd" placeholder="密码" autocomplete="current-password">
      </div>
    </div>
    <div class="snowluma-actions">
      <button class="btn btn-primary btn-small" id="sl-do-login">登录</button>
      <button class="btn btn-small" id="sl-quick-login">快速登录（已登录过的号）</button>
      <span class="muted" id="sl-quick-list" style="font-size:12px"></span>
    </div>
    <div class="sl-login-msg" id="sl-login-msg"></div>
    <div id="sl-captcha-slot"></div>`;

  slEl('sl-do-login')?.addEventListener('click', doPasswordLogin);
  slEl('sl-quick-login')?.addEventListener('click', doQuickLogin);
  loadQuickList();
}

async function loadQuickList() {
  try {
    const r = await api('/api/snowluma/login/status');
    const list = r.quickList || [];
    const el = slEl('sl-quick-list');
    if (el) el.textContent = list.length ? ('可用：' + list.join('、')) : '（暂无快速登录记录）';
    const uinEl = slEl('sl-uin');
    if (uinEl && !uinEl.value && list.length === 1) uinEl.value = list[0];
  } catch { /* ignore */ }
}

async function doQuickLogin() {
  const uin = (slEl('sl-uin')?.value || '').trim();
  if (!uin) return slLoginMsg('请先填 QQ 号', 'err');
  slLoginMsg('正在快速登录 ' + uin + ' …');
  try {
    const r = await api('/api/snowluma/login/set-quick', { method: 'POST', body: JSON.stringify({ uin }) });
    if (!r.ok) return slLoginMsg('快速登录失败：' + r.error, 'err');
    slLoginMsg('已请求快速登录，请稍候观察状态…', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

async function doPasswordLogin() {
  const uin = (slEl('sl-uin')?.value || '').trim();
  const pwd = slEl('sl-pwd')?.value || '';
  if (!uin || !pwd) return slLoginMsg('请填 QQ 号与密码', 'err');
  if (!/^\d{5,12}$/.test(uin)) return slLoginMsg('QQ 号格式不对', 'err');
  SLLogin.uin = uin;
  SLLogin.passwordMd5 = md5(pwd);          // 明文到此为止，不上行
  if (slEl('sl-pwd')) slEl('sl-pwd').value = '';
  slLoginMsg('正在登录…');
  try {
    const r = await api('/api/snowluma/login/password', {
      method: 'POST',
      body: JSON.stringify({ uin, passwordMd5: SLLogin.passwordMd5 })
    });
    if (!r.ok) return slLoginMsg('登录失败：' + r.error, 'err');
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    if (r.needCaptcha) {
      slLoginMsg('需要人机验证，请在下方完成', 'warn');
      return showCaptcha(r.proofWaterUrl);
    }
    slLoginMsg('登录请求已发送，稍候观察状态', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}


/* ───────────────────────── 账号总览与一键切号（2026-09-16 新增）─────────────────────────
 *
 * 背景：用户点了原来的「快速登录（已登录过的号）」按钮，提示「已请求快速登录，请稍候观察状态…」
 *       然后**永远没反应**。查明真凶：该按钮调的是 NapCat 的 SetQuickLoginQQ，
 *       它**只是设定『下次快速登录用哪个号』，完全不触发登录动作** —— 状态自然不会变。
 *
 * 用户诉求：「直接展示后台在线账号，然后切换过去」。
 * 本区块因此：
 *   ① 列出每个 QQ 实例**当前真实登录的账号**（UIN + 昵称 + 端点）；
 *   ② 列出已缓存可快速登录的号；
 *   ③ 提供「切到此号」按钮 → 先设定、再询问是否重启生效（两步，避免误操作掉线）。
 *
 * 数据来自外部桌面应用的 /api/qq/accounts（面板后端已透传，令牌不下发浏览器）。
 */
async function renderAccountsPanel() {
  const box = slEl('sl-accounts-panel');
  if (!box) return;
  let d;
  try {
    const r = await api('/api/accounts/overview');
    if (!r.ok) { box.innerHTML = '<div class="muted" style="font-size:12px">账号总览不可用：' + (r.error || '') + '</div>'; return; }
    d = r.data;
  } catch (e) {
    box.innerHTML = '<div class="muted" style="font-size:12px">账号总览读取失败：' + e.message + '</div>';
    return;
  }

  const rows = (d.instances || []).map((i) => `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${i.online ? 'on' : 'off'}">${i.online ? '在线' : '离线'}</span>
      <span class="sl-acct-label">${esc(i.label)}</span>
      <span class="sl-acct-uin">${i.online ? esc(i.uin + (i.nick ? '　' + i.nick : '')) : '—'}</span>
      <span class="muted" style="font-size:11px">${i.oneBotPort ? ':' + i.oneBotPort : ''}</span>
    </div>`).join('');

  const cached = (d.quickList || []).length
    ? d.quickList.map((q) => esc(q)).join('、')
    : '（无）';

  const switches = (d.switchable || []).map((s) => {
    const isCurrent = s.online && s.from === 'bot';
    return `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${s.online ? 'on' : 'off'}">${s.online ? '在线' : '已缓存'}</span>
      <span class="sl-acct-uin">${esc(s.uin)}${s.nick ? '　' + esc(s.nick) : ''}</span>
      <span class="muted" style="font-size:11px">${esc(s.fromLabel)}</span>
      <span style="flex:1"></span>
      ${isCurrent
        ? '<span class="sl-acct-cur">✓ 当前使用中</span>'
        : `<button class="btn btn-small" data-switch-uin="${esc(s.uin)}" data-switch-nick="${esc(s.nick || '')}">切到此号</button>`}
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="sl-accounts-title">后台在线账号 <span class="muted" style="font-size:11.5px">${esc(d.note || '')}</span></div>
    <div class="sl-accounts-card">
      ${rows || '<div class="muted" style="font-size:12px">未发现实例</div>'}
      <div class="muted" style="font-size:11.5px;margin-top:8px">已缓存可快速登录：${cached}</div>
    </div>
    <div class="sl-accounts-title" style="margin-top:12px">切换机器人登录账号</div>
    <div class="sl-accounts-card">
      ${switches || '<div class="muted" style="font-size:12px">暂无可切换账号</div>'}
      <div class="muted" style="font-size:11px;margin-top:8px;line-height:1.7">
        点「切到此号」= 先把它设为机器人的快速登录账号，再询问是否重启 NapCat 生效。<br>
        ⚠️ 重启期间机器人会短暂离线（30–60 秒）；同一 QQ 号不能在两处同时在线（会互踢）。
      </div>
    </div>`;

  // 绑定切号按钮
  box.querySelectorAll('[data-switch-uin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uin = btn.getAttribute('data-switch-uin');
      const nick = btn.getAttribute('data-switch-nick') || '';
      const ok = window.confirm(
        '将把 QQ 机器人的快速登录账号设为 ' + uin + (nick ? '（' + nick + '）' : '') + '。\n\n' +
        '⚠️ 这一步只是「设定」；需要重启 NapCat 才会真正用它登录，\n' +
        '   期间机器人会短暂离线（约 30–60 秒）。\n\n' +
        '另外：同一个 QQ 号不能在两处同时在线，否则会互踢。\n\n' +
        '确定继续吗？'
      );
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = '设定中…';
      try {
        const r1 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-quick-login', uin })
        });
        if (!r1.ok) { alert('设定失败：' + (r1.error || '')); btn.disabled = false; btn.textContent = '切到此号'; return; }
        btn.textContent = '重启中…';
        const r2 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-restart' })
        });
        alert(r2.ok ? ('已设定并重启机器人。\n\n' + (r2.message || '') + '\n\n约 30–60 秒后完成登录，可稍后刷新查看。')
                    : ('设定成功，但重启失败：' + (r2.error || r2.message || '')));
      } catch (e) {
        alert('操作失败：' + e.message);
      }
      btn.disabled = false;
      btn.textContent = '切到此号';
      setTimeout(renderAccountsPanel, 1500);
    });
  });
}

// 注：HTML 转义复用文件顶部已有的 esc()（第 50 行），不重复定义。

/** 登录面板只渲染一次（否则 4 秒定时刷新会把用户输入冲掉）。 */
function renderSnowlumaLoginOnce() {
  const box = slEl('sl-login-panel');
  if (!box) return;
  if (box.dataset.ready === '1') return;      // 已建，保留用户输入
  box.dataset.ready = '1';
  api('/api/snowluma/login/info')
    .then((info) => renderSnowlumaLogin(info))
    .catch(() => { box.dataset.ready = ''; });
}

// ── 新设备扫码验证 ──
// QQ 检测到"新设备登录"时会要求用**手机 QQ 扫码**确认（不是登录二维码，是设备验证）。
// 流程：GetNewDeviceQRCode 取 str_url → 渲染二维码 → 每 2.5s 轮询 PollNewDeviceQR
//       → 手机确认后拿 str_nt_succ_token → NewDeviceLogin 完成登录。
const SLDev = { uin: '', passwordMd5: '', bytesToken: '', timer: null };

function stopDevPoll() {
  if (SLDev.timer) { clearInterval(SLDev.timer); SLDev.timer = null; }
}

async function startNewDeviceVerify(jumpUrl, sig) {
  stopDevPoll();
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  SLDev.uin = SLLogin.uin;
  SLDev.passwordMd5 = SLLogin.passwordMd5;
  slLoginMsg('检测到新设备：请用**手机 QQ** 扫码确认（不是登录码）', 'warn');
  slot.innerHTML = '<div class="sl-captcha-box"><div class="muted">正在获取验证二维码…</div></div>';

  try {
    const r = await api('/api/snowluma/login/new-device-qr', {
      method: 'POST',
      body: JSON.stringify({ uin: SLDev.uin, jumpUrl })
    });
    if (!r.ok) { slot.innerHTML = ''; return slLoginMsg('获取验证二维码失败：' + r.error, 'err'); }
    const qr = r.qr || {};
    SLDev.bytesToken = qr.bytes_token || '';
    if (!qr.str_url) { slot.innerHTML = ''; return slLoginMsg('NapCat 未返回验证二维码', 'err'); }

    const imgTag = r.qrImage
      ? '<img class="sl-devqr-img" src="' + r.qrImage + '" alt="新设备验证二维码">'
      : '<div class="muted">（服务端未生成图片，请点下方链接）</div>';
    slot.innerHTML = '<div class="sl-captcha-box">'
      + '<div class="sl-login-title">用手机 QQ 扫码完成设备验证</div>'
      + imgTag
      + '<div class="sl-devqr-hint" id="sl-devqr-hint">等待扫码…</div>'
      + '<div class="muted" style="font-size:12px;word-break:break-all">扫码不了可复制：'
      + '<a href="' + esc(qr.str_url) + '" target="_blank" rel="noopener">验证链接</a></div>'
      + '</div>';

    startDevPoll();
  } catch (e) {
    slot.innerHTML = '';
    slLoginMsg('失败：' + e.message, 'err');
  }
}

function startDevPoll() {
  stopDevPoll();
  SLDev.timer = setInterval(async () => {
    try {
      const r = await api('/api/snowluma/login/new-device-poll', {
        method: 'POST',
        body: JSON.stringify({ uin: SLDev.uin, bytesToken: SLDev.bytesToken })
      });
      if (!r.ok) return;
      const p = r.poll || {};
      const st = p.uint32_guarantee_status;
      if (st === 3) {
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '已扫描，请在手机上确认…';
      } else if (st === 1) {
        stopDevPoll();
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '验证成功，正在登录…';
        // 用返回的 token 完成登录
        await finishNewDeviceLogin(p.str_nt_succ_token || SLDev.bytesToken);
      }
    } catch { /* 轮询失败继续 */ }
  }, 2500);
}

async function finishNewDeviceLogin(sig) {
  try {
    const r = await api('/api/snowluma/login/new-device', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLDev.uin, passwordMd5: SLDev.passwordMd5, newDevicePullQrCodeSig: sig
      })
    });
    if (!r.ok) return slLoginMsg('设备验证后登录失败：' + r.error, 'err');
    slLoginMsg('登录成功 ✧ 稍候即可收发消息', 'ok');
    const slot = slEl('sl-captcha-slot');
    if (slot) slot.innerHTML = '';
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

/** 渲染腾讯 TCaptcha：解析 proofWaterUrl 里的 aid/sid，动态加载 TCaptcha.js。 */
function showCaptcha(proofWaterUrl) {
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  let aid = '', sid = '';
  try {
    const q = proofWaterUrl.includes('?') ? proofWaterUrl.split('?')[1].split('#')[0] : '';
    for (const kv of q.split('&')) {
      const [k, v] = kv.split('=');
      if (k === 'aid') aid = decodeURIComponent(v || '');
      if (k === 'sid') sid = decodeURIComponent(v || '');
    }
  } catch { /* ignore */ }
  SLLogin.capAid = aid || '2081081773';
  SLLogin.capSid = sid;
  slot.innerHTML = '<div class="sl-captcha-box"><div id="sl-captcha-target"></div>'
    + '<div class="muted" style="font-size:12px">若验证码未出现，点此手动打开：'
    + '<a href="' + esc(proofWaterUrl) + '" target="_blank" rel="noopener">验证链接</a></div></div>';

  const load = (src) => new Promise((resolve, reject) => {
    if (window.TencentCaptcha) return resolve();
    const sc = document.createElement('script');
    sc.src = src; sc.onload = () => resolve(); sc.onerror = () => reject(new Error('load fail'));
    document.head.appendChild(sc);
  });
  load('https://captcha.gtimg.com/TCaptcha.js')
    .catch(() => load('https://ssl.captcha.qq.com/TCaptcha.js'))
    .then(() => {
      const cap = new window.TencentCaptcha(SLLogin.capAid, (res) => {
        if (res.ret === 0 && res.ticket) return submitCaptcha(res.ticket, res.randstr);
        slLoginMsg('验证未通过或已取消', 'err');
      }, { type: 'popup', showHeader: false, uin: SLLogin.uin, sid: SLLogin.capSid });
      cap.show();
    })
    .catch(() => slLoginMsg('验证码脚本加载失败，请点上面的验证链接手动完成', 'err'));
}

async function submitCaptcha(ticket, randstr) {
  slLoginMsg('验证通过，正在提交…');
  try {
    const r = await api('/api/snowluma/login/captcha', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLLogin.uin, passwordMd5: SLLogin.passwordMd5,
        ticket, randstr, sid: SLLogin.capSid
      })
    });
    if (!r.ok) return slLoginMsg('验证码登录失败：' + r.error, 'err');
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    slLoginMsg('登录成功，稍候即可收发消息 ✧', 'ok');
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

// ── 卡片右上角的登录二维码 ──
async function renderSnowlumaQr(connectedHint, selfHint) {
  const box = slEl('sl-qr-panel');
  if (!box) return;

  const showLoggedIn = (nick, uid) => {
    if (SL.loggedIn === true) return;
    SL.loggedIn = true;
    box.innerHTML = '<div class="sl-qr-done">✅ 已登录'
      + (nick ? '<br><strong>' + esc(nick) + '</strong>' : '')
      + (uid ? '<br><span class="muted">' + esc(String(uid)) + '</span>' : '')
      + '</div>';
    stopSnowlumaQrTimer();
  };

  if (connectedHint === true) return showLoggedIn(selfHint?.nickname, selfHint?.userId);

  try {
    const r = await api('/api/snowluma/qr');
    if (r.loggedIn) return showLoggedIn(r.self?.nickname, r.self?.userId);
    SL.loggedIn = false;

    if (!r.exists) {
      if (box.querySelector('.sl-qr-img') || !box.querySelector('.sl-qr-empty')) {
        box.innerHTML = '<div class="sl-qr-empty">等待 NapCat 生成二维码…<br>'
          + '<span class="muted">若长时间无二维码，请检查下方日志</span></div>';
      }
      return;
    }

    const age = Math.round((r.ageMs || 0) / 1000);
    const stale = age > 150;   // NapCat 约 2 分钟换一次
    const hint = stale ? '⏳ 二维码可能已过期，等待刷新…' : ('用手机 QQ 扫码 · ' + age + 's 前刷新');

    const img = box.querySelector('.sl-qr-img');
    if (!img) {
      box.innerHTML = '<div class="sl-qr-title">扫码登录 QQ</div>'
        + '<img class="sl-qr-img" src="/api/snowluma/qr.png?t=' + Date.now() + '" alt="登录二维码">'
        + '<div class="sl-qr-hint" id="sl-qr-hint"></div>';
      SL.qrAt = r.qrAt;
    } else if (r.qrAt && r.qrAt !== SL.qrAt) {
      SL.qrAt = r.qrAt;                    // 仅在 NapCat 换码时换图，避免闪烁
      img.src = '/api/snowluma/qr.png?t=' + Date.now();
    }
    setText('sl-qr-hint', hint);
    startSnowlumaQrTimer();
  } catch (e) {
    if (!box.querySelector('.sl-qr-empty')) {
      box.innerHTML = '<div class="sl-qr-empty">二维码加载失败<br><span class="muted">' + esc(e.message) + '</span></div>';
    }
  }
}

function startSnowlumaQrTimer() {
  if (SL.qrTimer) return;
  SL.qrTimer = setInterval(() => {
    if (state.tab !== 'snowluma') return;
    if (SL.loggedIn === true) { stopSnowlumaQrTimer(); return; }
    renderSnowlumaQr(false, null);
  }, 5000);
}
function stopSnowlumaQrTimer() {
  if (SL.qrTimer) { clearInterval(SL.qrTimer); SL.qrTimer = null; }
}

// ── 协议端页签：二维码 / 登录 / 账号总览 / 日志 ──
// 内部 id 仍叫 snowluma（配置段、接口路径、CSS 前缀都是它），只有文案改成了「协议端」。
async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs')
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';

    buildSnowlumaSkeleton();
    {
      const _s = s;
      const _running = !!( _s.snowluma?.running );
      const _obOk = !!_s.onebot?.connected;
      const _pid = _s.snowluma?.pid ?? null;
      const _embedded = !!_s.snowluma?.embedded;
      const _webui = _s.snowluma?.webuiUrl || '';

      // 页头写实际的协议端名字（本机是 NapCat）。历史命名一律叫 SnowLuma，
      // 但配置里的 snowluma.dir 早就指向 NapCat 目录了，界面上不该再显示旧名字。
      const _launchable = !!_s.snowluma?.launchable;
      // 后端名由服务端识别后给（napcat / snowluma / onebot），界面不再自己猜
      const _backendLabel = _s.snowluma?.backendLabel
        ? (_s.snowluma.backendLabel + '（OneBot v11）')
        : '';
      setText('sl-txt-backend', _backendLabel ? ' · ' + _backendLabel : '');

      setDot('sl-dot-run', _running);
      setText('sl-txt-run', _running ? '运行中' : '未运行');
      setText('sl-txt-pid', _pid ? ('pid ' + _pid) : '');
      setText('sl-txt-mode', _embedded
        ? '内置模式（随 QQ Agent 退出）'
        : (_running ? (_launchable ? '独立模式' : '由系统服务管理（只读）') : ''));

      setDot('sl-dot-ob', _obOk);
      const _acct = _s.onebot?.account || {};
      const _acctOff = _acct.online === false;
      if (_acctOff) {
        const _m = _acct.offlineMs ? Math.round(_acct.offlineMs / 60000) : 0;
        setText('sl-txt-ob', '⚠ 账号已离线' + (_m ? ('（' + _m + ' 分钟）') : ''));
        setDot('sl-dot-ob', false);
      } else {
        setText('sl-txt-ob', _obOk ? ('已连接' + (_s.onebot.self ? ('（' + _s.onebot.self.nickname + '）') : '')) : '未连接');
        setDot('sl-dot-ob', _obOk);
      }
      setText('sl-txt-obws', _acctOff
        ? ('账号离线 —— 扫码或检查登录' + (_acct.lastError ? ('（' + _acct.lastError + '）') : ''))
        : (_s.onebot?.error ? ('WS ：' + _s.onebot.error) : ''));
      setText('sl-txt-dir', '目录：' + (dir || '（未找到协议端目录）'));

      const webSlot = slEl('sl-webui-slot');
      if (webSlot) {
        const want = _webui
          ? ('<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开协议端控制台（NapCat WebUI）">' + esc(_webui) + '</button>')
          : '<span class="muted">等待协议端启动后自动识别…</span>';
        if (webSlot.innerHTML !== want) {
          webSlot.innerHTML = want;
          const b = slEl('sl-open-webui-btn');
          if (b) b.addEventListener('click', async () => {
            try {
              const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
              if (!r.ok) setText('sl-hint', r.error);
            } catch (e) { setText('sl-hint', '打开失败：' + e.message); }
          });
        }
      }

      // 只有"本进程能拉起的发行版"（自带 node.exe/index.mjs 或 launcher.bat）才给按钮。
      // NapCat 由 systemd 单独托管，这里的启动/关闭只会报错，不如直接藏掉。
      const startBtn = slEl('sl-start-btn');
      if (startBtn) {
        startBtn.hidden = !_launchable;
        const label = _running ? '已运行' : '启动协议端';
        if (startBtn.textContent !== label) startBtn.textContent = label;
        if (startBtn.disabled !== (_running || !_launchable)) startBtn.disabled = _running || !_launchable;
      }
      const stopBtn = slEl('sl-stop-btn');
      if (stopBtn) {
        stopBtn.hidden = !_launchable;
        const want = !_running || !_launchable;
        if (stopBtn.disabled !== want) stopBtn.disabled = want;
      }

      // 日志：内容变化才写，并保持贴底滚动
      const pre = slEl('sl-logs');
      if (pre && logText !== SL.logText) {
        SL.logText = logText;
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
        pre.textContent = logText;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }

      // ⚠️ 必须传「账号是否真的在线」，不能传 _obOk（= WS 是否连着）。
      //    NapCat 的 WS 在账号离线时依然在监听，传 _obOk 会让面板误显示
      //    「✅ 已登录」，于是**不显示二维码**，用户想重登都没码可扫。
      //    （2026-09-16 事故：掉线后二维码消失，用户无法自助恢复）
      renderSnowlumaQr(_acctOff === false, _s.onebot?.self || null);
    renderSnowlumaLoginOnce();
    // 账号总览与一键切号：每轮刷新都重渲染（数据实时变化，且没有用户输入需要保留）
    renderAccountsPanel().catch(() => {});
    }

  } catch (e) {
    if (!quiet) console.error(e);
  }
}

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息
      loadChatMessages(state.currentChatKey);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  box.innerHTML = state.chats.map((c) => {
    const name = c.key.replace('group:', '群 ').replace('private:', '私聊 ');
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

async function loadChatMessages(key) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=200`);
    state.chatMessages = data.messages || [];
    renderChatMessages();
  } catch (e) {
    $('#chat-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const name = key.replace('group:', '群 ').replace('private:', '私聊 ');
  const meta = state.chats.find((c) => c.key === key) || {};
  const detail = $('#chat-detail');
  const rows = state.chatMessages.map((m) => `
    <tr class="${m.read ? '' : 'unread'}">
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`).join('');
  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span>共 ${meta.total || 0} 条 · 存储于 data/messages/</span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息（不走模型）" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <table class="archive-table"><tbody>${rows}</tbody></table>`;
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    loadChatMessages(key);
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    const btn = $('#chat-testsend-btn');
    btn.textContent = '发送中…';
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, { method: 'POST', body: JSON.stringify({ text }) });
      btn.textContent = '已发出 ✓';
      input.value = '';
      loadChatMessages(key);
    } catch (e) {
      btn.textContent = `失败：${e.message}`.slice(0, 40);
    }
    setTimeout(() => { btn.textContent = '发送'; }, 2500);
  });
}

// ── 设置视图 ──
async function loadSettings() {
  const [cfg, tplData, provData, visionData, capData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/capabilities').catch(() => null)
  ]);
  state.config = cfg;
  state.capabilities = capData;
  loadSearchKeys().catch(() => {});
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  renderSettings();
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往「协议端」页签</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '【官方资料】' : (r?.source === 'probe' ? '【在线探测】' : '');
  const t = (cls, text) => `<span class="vbadge ${cls}" title="${esc(src + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片');
  if (r.verdict === 'no-vision') return t('no', '无图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  if (!provs.length) return '<div class="muted" style="padding:10px;font-size:12px">目录为空——点"从 DSH 导入"。</div>';
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新从 DSH 导入。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey && p.apiKey) {
    $('#cfg-apikey').value = p.apiKey;
    notes.push(`密钥已填充（${p.apiKeyFrom === 'manual' ? '手动保存' : `来自环境变量 ${p.apiKeyFrom}`}）`);
  } else {
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  if (p.anthropicOrigin) notes.push('（DSH 中为 Anthropic 协议，已按 OpenAI 兼容模式调用，若报错请换用其他模型）');
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['capabilities', '能力总览'],
    ['api', '模型 API'],
    ['search', '联网搜索'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['chat', '聊天设置'],
    ['desktop', '桌面端'],
    ['onebot', 'OneBot（协议端）']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${(s?.onebot?.account?.online === false) ? 'dot-off' : (s?.onebot?.connected ? 'dot-on' : 'dot-off')}"></span><span>${(s?.onebot?.account?.online === false) ? '⚠ 账号已离线' : (s?.onebot?.connected ? '运行中' : '未就绪')}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}</button>`).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    capabilities: () => renderCapabilitiesSection(c),
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>
    ${render()}`;
}

/** 单个提供商行：改 Key / 改地址 / 测试 / 删除 都在这里。 */
function providerRowHtml(p, c) {
  const active = p.id === c.api.provider;
  const models = Array.isArray(p.models) ? p.models : [];
  return `<div class="provider-row ${active ? 'active' : ''}" data-pid="${esc(p.id)}">
    <div class="provider-main">
      <span class="provider-name">${esc(p.displayName || p.id)}</span>
      ${active ? '<span class="provider-badge">当前使用</span>' : ''}
      ${p.hasKey ? '<span class="provider-badge ok">有 Key</span>' : '<span class="provider-badge warn">无 Key</span>'}
      <div class="provider-meta muted">${esc(p.baseURL || '')} · ${models.length} 个模型${active && c.api.model ? ` · 当前 ${esc(c.api.model)}` : ''}</div>
      <div class="provider-test-line muted" data-test-line="${esc(p.id)}"></div>
    </div>
    <div class="provider-actions">
      <button class="btn btn-small" data-act="provider-models" data-pid="${esc(p.id)}">模型</button>
      <button class="btn btn-small" data-act="provider-set-key" data-pid="${esc(p.id)}">改 Key</button>
      <button class="btn btn-small" data-act="provider-edit-url" data-pid="${esc(p.id)}">改地址</button>
      <button class="btn btn-small" data-act="provider-test" data-pid="${esc(p.id)}">测试</button>
      <button class="btn btn-small btn-danger" data-act="provider-delete" data-pid="${esc(p.id)}">删除</button>
    </div>
  </div>`;
}

/**
 * 模型 API 板块。
 *
 * 以前这一屏同时塞了：当前模型、Base URL、明文 Key 输入框、搜索设置、添加提供商表单、模型行编辑……
 * 又长又看不出"我现在到底在用哪家、Key 有效没"。现在分区：
 *   ① 当前使用（卡片 + 切换/测试）
 *   ② 提供商（每行 改Key/改地址/测试/删除；添加表单收进折叠）
 *   ③ 高级（温度/轮数/图片输入，默认收起）
 * 联网搜索挪到侧栏独立一项。
 */
function renderApiSection(c) {
  const providers = state.providers || [];
  const cur = providers.find((p) => p.id === c.api.provider);
  const modelLabel = (cur?.modelNames || {})[c.api.model] || c.api.model || '';
  const hasKey = !!String(c.api.apiKey || '').trim();
  const modelMissing = c.api.model && cur && !(cur.models || []).includes(c.api.model);
  return `
    <h3 id="settings-api">模型 API</h3>

    <div class="api-current ${hasKey && cur ? '' : 'warn'}">
      <div class="api-current-main">
        <div class="api-current-model">${modelLabel ? esc(modelLabel) : '<span class="muted">尚未选择模型</span>'}</div>
        <div class="api-current-meta muted">${cur
          ? `${esc(cur.displayName || cur.id)} · ${esc(c.api.baseUrl || cur.baseURL || '')}`
          : '还没有选定提供商 —— 点右侧「切换模型」选一个'}</div>
        <div class="api-current-badges">
          <span class="provider-badge ${hasKey ? 'ok' : 'warn'}">${hasKey ? 'Key 已配置' : '缺少 API Key'}</span>
          <span class="provider-badge">图片输入 ${c.api.vision !== false ? '开' : '关'}</span>
          <span class="provider-badge">温度 ${esc(c.api.temperature)}</span>
          ${modelMissing ? '<span class="provider-badge warn">该模型不在目录里</span>' : ''}
        </div>
      </div>
      <div class="api-current-actions">
        <button class="btn btn-primary btn-small" id="pick-model-btn">切换模型</button>
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
      </div>
    </div>
    <div class="hint" id="provider-test-result" style="min-height:18px"></div>

    <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
    <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    <input type="hidden" id="cfg-baseurl" value="${esc(c.api.baseUrl || '')}" />
    <input type="hidden" id="cfg-apikey" value="${esc(c.api.apiKey || '')}" />

    <h3>提供商</h3>
    <div class="hint" style="margin-bottom:8px">每个提供商可单独改 Key / 改地址 / 测试 / 删除。删掉的若是正在使用的那家，会自动切到剩下的第一家。</div>
    <div id="provider-list" class="provider-list">
      ${providers.length ? providers.map((p) => providerRowHtml(p, c)).join('') : '<div class="hint">还没有提供商，展开下面的「＋ 添加提供商」。</div>'}
    </div>

    <details class="api-fold" ${providers.length ? '' : 'open'}>
      <summary>＋ 添加提供商</summary>
      <div class="api-fold-body">
        <div class="field"><label>Base URL</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="new-baseurl" placeholder="https://api.example.com/v1" style="flex:1" />
            <button class="btn btn-small" id="fetch-models-btn">获取列表</button>
          </div>
          <div class="hint">「获取列表」用这个地址 + Key 拉模型目录，弹窗里勾选加入。</div></div>
        <div class="field"><label>API Key</label><input type="text" id="new-apikey" placeholder="sk-..." autocomplete="off" /></div>
        <div class="field"><label>模型（左：模型 ID；右：显示名；可多行）</label>
          <div id="model-rows"></div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
            <button class="btn btn-primary btn-small" id="confirm-add-provider-btn">确认添加</button>
          </div></div>
        <div class="hint" id="provider-action-hint"></div>
      </div>
    </details>

    <details class="api-fold">
      <summary>高级设置（温度 / 工具轮数 / 图片输入）</summary>
      <div class="api-fold-body">
        <div class="field-row">
          <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
          <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
        </div>
        <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
          <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只看到 [图片] 占位符）</label>
          <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>

      </div>
    </details>`;
}

/** 联网搜索：从「模型 API」里拆出来，单独一屏。 */
function renderSearchSection(c) {
  return `
    <h3 id="settings-search">联网搜索</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">启用联网搜索：给模型挂上 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索引擎</label>
      <select id="cfg-searchprovider">
        <option value="auto" ${(c.webSearch?.provider || 'auto') === 'auto' ? 'selected' : ''}>自动（优先 AnySearch，失败回退 Bing）— 推荐</option>
        <option value="anysearch" ${c.webSearch?.provider === 'anysearch' ? 'selected' : ''}>AnySearch（需 API key，结果更全）</option>
        <option value="bing" ${c.webSearch?.provider === 'bing' ? 'selected' : ''}>Bing 网页抓取（免 key）</option>
      </select>
      <div class="hint" style="margin-top:4px">不填 key 时，自动模式会回退到 Bing 网页抓取。</div></div>
    <div class="field"><label>AnySearch API Key（可多个轮换）</label>
      <div id="search-key-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <button class="btn btn-small" type="button" id="add-search-key-btn">+ 添加一个 Key</button>
        <button class="btn btn-small btn-primary" type="button" id="save-search-keys-btn">保存 Key</button>
        <span id="search-key-result" class="muted"></span>
      </div>
      <div class="hint" style="margin-top:4px">已保存的 Key 只显示首尾，重新填写才会覆盖；环境变量注入的 Key 优先。</div></div>
    <div class="field"><label>搜索地址（高级：可换成兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>`;
}

function renderPersonaSection(c) {
  return `
    <h3>人设</h3>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div id="persona-backup-bar" style="display:flex;gap:8px;align-items:center;min-height:20px"></div>
    <div class="field"><label>角色设定（每轮注入，群友不可修改）</label>
      <div class="hint" style="margin-bottom:6px">选模板不会直接覆盖：会先问「覆盖还是追加」，覆盖前自动备份、可一键还原。</div>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    ${renderPersonaSaveBar()}`;
}


// ── 能力面板：展示机器人当前具备的工具与功能（数据来自 /api/capabilities）──
function renderCapabilitiesSection(c) {
  const cap = state.capabilities;
  if (!cap) {
    return `
      <h3 id="settings-caps">能力总览</h3>
      <div class="hint">正在加载能力清单…</div>`;
  }
  const tools = cap.tools || [];
  const f = cap.features || {};

  // 按分组聚合
  const groups = {};
  for (const t of tools) {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push(t);
  }
  const ORDER = ['消息与互动', '信息获取', '学习/知识库', '课表', '记忆', '主人专属', '其它'];
  const orderedNames = ORDER.filter((g) => groups[g]).concat(Object.keys(groups).filter((g) => !ORDER.includes(g)));
  const GROUP_ICON = {
    '消息与互动': '💬', '信息获取': '🔎', '学习/知识库': '📚', '课表': '📅',
    '记忆': '🧠', '主人专属': '👑', '其它': '🔧'
  };

  const toolCards = orderedNames.map((g) => {
    const list = groups[g];
    return `
      <div class="cap-group">
        <div class="cap-group-title">${GROUP_ICON[g] || '🔧'} ${esc(g)}
          <span class="cap-count">（${list.length}）</span></div>
        <div class="cap-tools">
          ${list.map((t) => `
            <div class="cap-tool">
              <div class="cap-tool-name">
                <code>${esc(t.name)}</code>
                ${t.masterOnly ? '<span class="cap-badge">主人专属</span>' : ''}
                ${t.tutorOnly ? '<span class="cap-badge">学习模式</span>' : ''}
                ${t.enabled === false ? `<span class="cap-badge cap-badge-off" title="${esc(t.reason || '')}">不可用</span>` : ''}
              </div>
              <div class="cap-tool-desc">${esc(String(t.description || '').slice(0, 110))}${(t.description || '').length > 110 ? '…' : ''}</div>
              ${t.params && t.params.length ? `<div class="cap-tool-params">参数：<code>${t.params.map(esc).join('</code>、<code>')}</code></div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');

  // 关键功能状态卡
  const sched = f.schedule || {};
  const sr = f.search || {};
  const sc = f.scheduled || {};
  const notify = f.scheduleNotify || {};
  const modes = f.identityModes || [];
  const modeRows = modes.length
    ? modes.map((m) => `· <b>${esc(m.label)}</b>：说「${(m.enter || []).map(esc).join('」/「')}」进入，说「${(m.exit || []).map(esc).join('」/「')}」退出`).join('<br>')
    : '<span class="cap-off">（未配置身份模式）</span>';

  return `
    <h3 id="settings-caps">能力总览</h3>
    <div class="hint" style="margin-bottom:12px">
      机器人共注册 <b>${cap.registered || tools.length}</b> 个工具，常规可用 <b>${cap.total ?? tools.length}</b> 个
      （其余为「仅主人」「仅学习模式」或当前被关闭）。以下清单由服务端实时生成，与运行中的代码一致。
    </div>

    <div class="cap-grid">
      <div class="cap-card">
        <div class="cap-card-title">📅 课表（原生查询）</div>
        <div class="cap-card-body">
          状态：${sched.ok ? '<span class="cap-ok">✅ 可用</span>' : '<span class="cap-warn">⚠️ 读不到数据</span>'}<br>
          ${sched.range ? `覆盖：${esc(String(sched.range[0]))} ~ ${esc(String(sched.range[1]))}<br>` : ''}
          ${sched.tomorrow ? `明天（${esc(sched.tomorrow)}）：<b>${sched.count || 0}</b> 条记录` : ''}
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">⏰ 每晚课程播报</div>
        <div class="cap-card-body">
          状态：${notify.enabled ? '<span class="cap-ok">✅ 已启用</span>' : '<span class="cap-off">未启用</span>'}<br>
          推送时间：每天 <b>${esc(String(notify.time || '21:00'))}</b><br>
          内容：次日课程（有课报课、没课也知会一声）
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">🎓 学习模式（多身份）</div>
        <div class="cap-card-body">
          已配置 <b>${modes.length}</b> 个模式<br>
          ${modeRows}
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">📚 知识库</div>
        <div class="cap-card-body">
          状态：${f.kb === 'ok' ? '<span class="cap-ok">✅ 已就绪</span>' : '<span class="cap-off">未安装</span>'}<br>
          能力：题库 / 教材检索 / 学习进度 / 学习档案
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">🔎 联网搜索</div>
        <div class="cap-card-body">
          状态：${sr.enabled ? '<span class="cap-ok">✅ 已启用</span>' : '<span class="cap-off">未启用</span>'}<br>
          当前引擎：<b>${esc(String(sr.effective || '未知'))}</b><br>
          AnySearch Key：${sr.anysearchAvailable ? '<span class="cap-ok">已配置</span>' : '<span class="cap-off">未配置</span>'}
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">⏱️ 定时任务</div>
        <div class="cap-card-body">
          待触发：<b>${sc.count || 0}</b> 条${sc.items && sc.items.length ? '<br>' + sc.items.map((x) => '· ' + esc(x)).join('<br>') : (sc.count ? '' : '<br><span class="cap-off">（主人可以在 QQ 里直接下达：X点提醒我…）</span>')}
        </div>
      </div>
    </div>

    <h3 style="margin:20px 0 12px">工具清单</h3>
    ${toolCards}`;
}

// ── AnySearch Key 管理 ──────────────────────────────
function renderSearchKeyRows() {
  const box = $('#search-key-rows');
  if (!box) return;
  const sk = state.searchKeys || {};
  const masked = sk.configKeys || [];
  const envCount = sk.envCount || 0;
  const rows = [];
  if (envCount > 0) {
    rows.push('<div class="muted" style="font-size:12px;margin-bottom:6px">检测到 ' + envCount + ' 个环境变量注入的 Key（优先使用，不在此显示）</div>');
  }
  const n = Math.max(masked.length, 1);
  for (let i = 0; i < n; i++) {
    const v = masked[i] || '';
    rows.push('<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">' +
      '<input type="text" class="search-key-input" data-idx="' + i + '" placeholder="粘贴 AnySearch API Key" value="' + esc(v) + '" style="flex:1" />' +
      '<button class="btn btn-small" type="button" data-del-key="' + i + '" title="删除这一项">✕</button>' +
      '</div>');
  }
  box.innerHTML = rows.join('');
  box.querySelectorAll('[data-del-key]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.delKey);
      const inputs = [...box.querySelectorAll('.search-key-input')];
      if (inputs[idx]) inputs[idx].value = '';
      el.closest('div').style.opacity = '.4';
      el.disabled = true;
    });
  });
}

async function loadSearchKeys() {
  try {
    state.searchKeys = await api('/api/search-keys');
    renderSearchKeyRows();
  } catch (e) { /* 忽略 */ }
}

async function saveSearchKeys() {
  const box = $('#search-key-rows');
  const out = $('#search-key-result');
  if (!box) return;
  const inputs = [...box.querySelectorAll('.search-key-input')];
  const keys = inputs.map((el) => el.value.trim()).filter(Boolean);
  // 只提交新填的（含 **** 的是遮影值，不提交）
  try {
    const r = await fetch('/api/search-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys })
    });
    const j = await r.json();
    if (j.ok) {
      if (out) out.textContent = '已保存 ' + j.saved + ' 个 Key';
      await loadSearchKeys();
    } else if (out) out.textContent = '保存失败：' + (j.error || '');
  } catch (e) {
    if (out) out.textContent = '保存失败：' + e.message;
  }
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选（不用查群号）</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>`;
}

function renderChatSection(c) {
  return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>防抖聚批窗口（毫秒）—— 等连发消息聚成一批再开运行</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>回复策略（群聊）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-reply-enabled" ${c.replyPolicy?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-reply-enabled">只在被 @ / 叫名字时必回，其余消息按概率偶尔回</label></div>
    <div class="field-row">
      <div class="field"><label>必回关键词（逗号分隔）</label>
        <input type="text" id="cfg-reply-keywords" value="${esc((c.replyPolicy?.keywords || []).join(','))}" />
        <div class="hint">消息里出现这些词（或机器人昵称）就必定回复。</div></div>
      <div class="field"><label>普通消息放行概率 0~1</label>
        <input type="number" id="cfg-reply-prob" step="0.01" min="0" max="1" value="${esc(c.replyPolicy?.otherProbability ?? 0.15)}" />
        <div class="hint">没被 @、没提关键词时，有多大概率还是接一句。0 = 只在叫它时说话。</div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>主人闲聊放行概率 0~1</label>
        <input type="number" id="cfg-reply-master-prob" step="0.01" min="0" max="1" value="${esc(c.replyPolicy?.masterProbability ?? 0.35)}" />
        <div class="hint">主人在群里随便说话时，有多大概率接一句（@ 你 / 引用你 / 叫你名字仍然必回）。
          默认 0.35 ≈ 三句接一句；调成 0 就是"主人闲聊也不接，只回点名"。</div></div>
    </div>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
      <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>

    <h3>表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <h3>发给模型的聊天记录</h3>
    <div class="field-row">
      <div class="field"><label>最多条数</label>
        <input type="number" id="cfg-pastlimit" min="10" max="500" value="${esc(c.store?.pastStateLimit ?? 80)}" />
        <div class="hint">每次运行提示词里"过去状态"最多携带的历史消息条数。</div></div>
      <div class="field"><label>字符预算</label>
        <input type="number" id="cfg-pastchars" min="1000" max="60000" step="500" value="${esc(c.store?.pastStateMaxChars ?? 6000)}" />
        <div class="hint">聊天记录的总字符上限，超出时从最旧的开始丢弃。保存后下次运行立即生效。</div></div>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启（登录 Windows 后自动运行）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘（机器人常驻，从托盘真正退出）</label></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">QQ 协议端（OneBot v11）</h3>
    <div class="hint" style="margin-bottom:10px">协议端的登录二维码 / 账号 / 日志在顶部「协议端」页签；此处只保留连接配置。</div>
    <div class="field"><label>协议端目录（留空 = 自动探测项目内 snowluma/ 或本机 NapCat）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起协议端（仅内置 SnowLuma 发行版可自启动）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；NapCat 通常与 WS 相同）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

function bindSettingsEvents(c) {
  // AnySearch Key 的添加/保存按钮
  const addKeyBtn = $('#add-search-key-btn');
  if (addKeyBtn) addKeyBtn.addEventListener('click', () => {
    const box = $('#search-key-rows');
    if (!box) return;
    const inputs = box.querySelectorAll('.search-key-input');
    const idx = inputs.length;
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
    div.innerHTML = '<input type="text" class="search-key-input" data-idx="' + idx + '" placeholder="粘贴 AnySearch API Key" style="flex:1" />' +
      '<button class="btn btn-small" type="button" title="清空">✕</button>';
    div.querySelector('button').addEventListener('click', () => { div.remove(); });
    box.appendChild(div);
  });
  const saveKeyBtn = $('#save-search-keys-btn');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveSearchKeys);

  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#cfg-save-result').textContent = '已保存 ✓';
      refreshStatus();
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  // ── 模型 API 区块事件 ──
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const pickModelBtn = $('#pick-model-btn');
  if (pickModelBtn) pickModelBtn.addEventListener('click', () => openModelPicker());
  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', async () => {
    const btn = testProviderBtn;
    const out = $('#provider-test-result');
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const providerId = $('#cfg-provider')?.value.trim() || '';
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const apiKey = $('#cfg-apikey')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      // 走 test-one：既验 /models 也真发一次 chat —— 「能列模型」不等于「能生成」
      const r = await api('/api/providers/test-one', {
        method: 'POST',
        body: JSON.stringify({ providerId, baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = `${res.ok ? '✓' : '✗'} ${res.note || '未知结果'}`;
      if (out) out.className = `hint ${res.ok ? 'ok-text' : 'warn-text'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.textContent = '测试连通性';
  });

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    const key = $('#cfg-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  const providerList = $('#provider-list');
  if (providerList) providerList.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const pid = btn.dataset.pid;
    const prov = (state.providers || []).find((x) => x.id === pid);
    if (!prov) return;
    if (btn.dataset.act === 'provider-models') { openProviderModelsModal(prov.id); return; }
    if (btn.dataset.act === 'provider-set-key') { openProviderKeyModal(prov); return; }
    if (btn.dataset.act === 'provider-edit-url') { openProviderUrlModal(prov); return; }
    if (btn.dataset.act === 'provider-test') {
      const line = document.querySelector(`[data-test-line="${pid}"]`);
      if (line) line.textContent = '测试中…';
      btn.disabled = true;
      try {
        const r = await api('/api/providers/test-one', { method: 'POST', body: JSON.stringify({ providerId: pid }) });
        const res = r.result || {};
        if (line) line.textContent = (res.ok ? '✓ ' : '✗ ') + (res.note || '失败');
        if (line) line.className = `provider-test-line ${res.ok ? 'ok-text' : 'warn-text'}`;
      } catch (e) {
        if (line) line.textContent = `✗ ${e.message}`;
      }
      btn.disabled = false;
      return;
    }
    if (btn.dataset.act === 'provider-delete') {
      const active = state.config?.api?.provider === pid;
      if (!confirm(`删除提供商「${prov.displayName || prov.id}」？\n\n${active ? '它正在被使用：删除后会自动切到剩下的第一个提供商。' : '它下面的模型会一起从目录里移除（不影响已保存的配置项）。'}`)) return;
      try {
        btn.disabled = true;
        const r = await api(`/api/providers?id=${encodeURIComponent(pid)}`, { method: 'DELETE' });
        await loadSettings();
        showToast(r.switchedTo ? `已删除；当前切到 ${r.switchedTo.displayName}` : '已删除', 'info');
      } catch (e) {
        btn.disabled = false;
        alert('删除失败：' + e.message);
      }
    }
  });

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    if (!box) return;
    const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
    if (r && r.verdict === 'no-vision') {
      box.checked = false;
      box.disabled = true;
      hint.textContent = '此模型无图片输入';
    } else {
      box.disabled = false;
      box.checked = state.config.api.vision !== false;
      hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // ── 人设区块事件 ──
  renderPersonaBackupBar();
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设（小鲸鱼）' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });
}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `
      <div class="model-modal-right" id="persona-list" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${(state.personaTemplates[id]?.text === ($('#cfg-roletext')?.value ?? '')) ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      closeModelModal(overlay);
      if (tpl) applyPersonaTemplate(tpl);
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// 应用人设模板。**不再无条件整体覆盖**（2026-09-17 改）：
//   旧行为 = 点模板直接把 roleText 换掉、还把 customRules 清空，且无提示不可撤销，
//   用户自己写的人设会瞬间丢失。
//   新行为 = 先弹确认框，让用户选「覆盖」还是「追加」，并在覆盖前自动备份旧人设。
function applyPersonaTemplate(tpl) {
  const roleEl = $('#cfg-roletext');
  const rulesEl = $('#cfg-customrules');
  if (!roleEl) return;

  const oldText = roleEl.value || '';
  const oldRules = rulesEl?.value || '';
  const newText = tpl.text || '';
  const newRules = tpl.customRules || '';

  // 无内容可覆盖 → 直接套用，不打扰
  if (!oldText.trim()) {
    roleEl.value = newText;
    if (rulesEl && newRules) rulesEl.value = newRules;
    const input = $('#cfg-persona-pick');
    if (input) input.value = tpl.name;
    syncPersonaButtons();
    return;
  }

  // 已有内容 → 询问覆盖还是追加（追加 = 保留旧人设，把模板接在后面）
  const keepRules = oldRules.trim()
    ? '\n\n（你原有的「附加规则」会保留，不会被模板清掉。）'
    : '';
  const useOverwrite = window.confirm(
    `要把当前人设替换为「${tpl.name}」吗？\n\n`
    + `当前人设：${oldText.length} 字\n`
    + `新模板：${newText.length} 字\n\n`
    + `【确定】= 覆盖（旧人设会先自动备份，可还原）\n`
    + `【取消】= 改为「追加」（保留旧人设，模板内容接在后面）`
    + keepRules
  );

  if (useOverwrite) {
    // 覆盖前备份旧人设，防误操作
    state.personaBackup = { text: oldText, rules: oldRules, at: Date.now() };
    roleEl.value = newText;
    if (rulesEl) rulesEl.value = newRules;   // 覆盖时才替换附加规则
  } else {
    roleEl.value = oldText.trimEnd() + '\n\n---\n\n' + newText;
    // 追加模式保留原有附加规则；若原本为空，则带入模板自带的
    if (rulesEl && !oldRules.trim() && newRules) rulesEl.value = newRules;
  }

  const input = $('#cfg-persona-pick');
  if (input) input.value = tpl.name;
  syncPersonaButtons();
  renderPersonaBackupBar();
}

// 覆盖后可一键还原（仅在本次页面会话内有效，刷新即失效）
function renderPersonaBackupBar() {
  const bar = $('#persona-backup-bar');
  if (!bar) return;
  const b = state.personaBackup;
  if (!b) { bar.innerHTML = ''; return; }
  const t = new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false });
  bar.innerHTML = `<span class="muted" style="font-size:12px">已备份覆盖前的人设（${b.text.length} 字，${t}）</span>
    <button class="btn btn-small" id="persona-restore-btn">还原</button>`;
  const btn = $('#persona-restore-btn');
  if (btn) btn.addEventListener('click', () => {
    const roleEl = $('#cfg-roletext');
    if (roleEl) roleEl.value = b.text;
    const rulesEl = $('#cfg-customrules');
    if (rulesEl) rulesEl.value = b.rules;
    state.personaBackup = null;
    renderPersonaBackupBar();
    syncPersonaButtons();
  });
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本（每轮注入，群友不可修改）"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules })
      });
      closeModelModal(overlay);
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点「保存人设修改」使当前填写生效。`;
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/** 改某个提供商的 API Key（不用删了重加 —— 这也是之前"改不了 Key"的原因）。 */
function openProviderKeyModal(prov) {
  const overlay = modelModalShell({
    head: `修改 API Key · ${esc(prov.displayName || prov.id)}`,
    body: `
      <div class="field"><label>Base URL</label>
        <input type="text" value="${esc(prov.baseURL || '')}" readonly /></div>
      <div class="field"><label>新的 API Key</label>
        <input type="text" id="prov-key-input" placeholder="sk-..." autocomplete="off" />
        <div class="hint">当前${prov.hasKey ? '已保存一个 Key（不回显）' : '还没有 Key'}；保存后会同时更新"当前 API Key"，改完立即生效。</div></div>
      <div class="hint" id="prov-key-result"></div>`,
    foot: `<button class="btn" id="prov-key-cancel">取消</button>
           <button class="btn btn-primary" id="prov-key-save">保存</button>`
  });
  const input = overlay.querySelector('#prov-key-input');
  const hint = overlay.querySelector('#prov-key-result');
  input?.focus();
  overlay.querySelector('#prov-key-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#prov-key-save')?.addEventListener('click', async () => {
    const key = String(input?.value || '').trim();
    if (!key) { hint.textContent = 'Key 不能为空'; return; }
    try {
      await api('/api/providers/set-key', { method: 'POST', body: JSON.stringify({ providerId: prov.id, apiKey: key }) });
      closeModelModal(overlay);
      await loadSettings();
      showToast('API Key 已更新', 'ok');
    } catch (e) {
      hint.textContent = '保存失败：' + e.message;
    }
  });
}

/** 重新拉一次提供商目录到前端状态（模型增删后刷新用）。 */
async function refreshProviders() {
  try {
    const d = await api('/api/providers');
    state.providers = d.providers || [];
  } catch { /* 拉不到就沿用旧状态 */ }
}

/**
 * 某个提供商的模型管理：看列表、从服务商拉取、手动添加、删除、设为当前。
 * 以前"获取列表"只在添加提供商表单里，删除模型是另一个全局弹窗 —— 想给已有的
 * 提供商加个模型，得把地址和 Key 再填一遍。现在收敛到这一处。
 */
function openProviderModelsModal(providerId) {
  let remote = null;      // 拉取到的模型 id 列表
  let busy = false;
  // 状态文字要跨重渲染保留：每次操作后 render() 会重建 DOM，不存下来就一闪而空
  let statusText = '';
  let statusCls = 'muted';
  const overlay = modelModalShell({
    head: '管理模型',
    body: `<div id="pm-body"><div class="muted" style="padding:10px">加载中…</div></div>`,
    foot: `<button class="btn" id="pm-close">关闭</button>`
  });
  const body = overlay.querySelector('#pm-body');
  const prov = () => (state.providers || []).find((x) => x.id === providerId) || null;

  function modelRowsHtml(p) {
    const names = p.modelNames || {};
    const models = Array.isArray(p.models) ? p.models : [];
    const isCurrentProv = state.config?.api?.provider === p.id;
    if (!models.length) return '<div class="muted" style="padding:8px 2px">还没有模型：点上面的「从服务商拉取」或「手动添加」。</div>';
    return models.map((m) => {
      const active = isCurrentProv && state.config?.api?.model === m;
      return `<div class="pm-model ${active ? 'active' : ''}">
        <div class="pm-model-main">
          <span class="pm-model-name">${esc(names[m] || m)}</span>
          ${active ? '<span class="provider-badge">当前使用</span>' : ''}
          <div class="pm-model-id muted">${esc(m)}</div>
        </div>
        <div class="provider-actions">
          ${active ? '' : `<button class="btn btn-small" data-pm="use" data-model="${esc(m)}">设为当前</button>`}
          <button class="btn btn-small btn-danger" data-pm="del" data-model="${esc(m)}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  function remoteHtml(p) {
    if (!remote) return '';
    const have = new Set(p.models || []);
    if (!remote.length) return '<div class="muted" style="padding:8px 2px">服务商没有返回任何模型。</div>';
    return `<div class="pm-remote">
      <div class="pm-remote-head">
        <span>服务商有 ${remote.length} 个模型（已添加的不可重复勾选）</span>
        <button class="btn btn-small btn-primary" id="pm-add-picked">加入选中</button>
      </div>
      <div class="pm-remote-list">
        ${remote.map((m) => `<label class="pm-remote-item ${have.has(m) ? 'have' : ''}">
          <input type="checkbox" value="${esc(m)}" ${have.has(m) ? 'disabled' : ''} />
          <span>${esc(m)}</span>
          ${have.has(m) ? '<span class="muted">已在目录</span>' : ''}
        </label>`).join('')}
      </div>
    </div>`;
  }

  function render() {
    const p = prov();
    if (!p) { body.innerHTML = '<div class="muted" style="padding:10px">该提供商已不存在。</div>'; return; }
    body.innerHTML = `
      <div class="pm-head">
        <div class="pm-head-name">${esc(p.displayName || p.id)}</div>
        <div class="pm-head-url muted">${esc(p.baseURL || '')}${p.hasKey ? '' : ' · <span class="warn-text">未配置 Key，拉取会失败</span>'}</div>
      </div>
      <div class="pm-toolbar">
        <button class="btn btn-small" id="pm-fetch">从服务商拉取模型</button>
        <button class="btn btn-small" id="pm-manual">手动添加</button>
        <span class="${statusCls}" id="pm-status">${esc(statusText)}</span>
      </div>
      <div id="pm-manual-box" style="display:none">
        <div class="field-row">
          <div class="field"><label>模型 ID</label><input type="text" id="pm-manual-id" placeholder="例如 gpt-4o-mini" /></div>
          <div class="field"><label>显示名（可空）</label><input type="text" id="pm-manual-name" placeholder="随便起个名" /></div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button class="btn btn-small btn-primary" id="pm-manual-save">加入</button>
          <button class="btn btn-small" id="pm-manual-cancel">取消</button>
        </div>
      </div>
      <div class="pm-section-title">目录里的模型（${(p.models || []).length}）</div>
      <div class="pm-models">${modelRowsHtml(p)}</div>
      ${remoteHtml(p)}`;
    bind();
  }

  function setStatus(text, cls = 'muted') {
    statusText = String(text || '');
    statusCls = cls;
    const el = body.querySelector('#pm-status');
    if (el) { el.textContent = statusText; el.className = cls; }
  }

  function bind() {
    const p = prov();
    body.querySelector('#pm-close')?.addEventListener('click', () => closeModelModal(overlay));
    body.querySelector('#pm-fetch')?.addEventListener('click', async (ev) => {
      if (busy) return;
      busy = true;
      const btn = ev.currentTarget;
      btn.disabled = true;
      setStatus('拉取中…');
      try {
        const r = await api('/api/providers/fetch-models', { method: 'POST', body: JSON.stringify({ providerId: p.id }) });
        remote = r.models || [];
        setStatus(`拉到 ${remote.length} 个模型`, 'muted');
      } catch (e) {
        setStatus(`拉取失败：${e.message}`, 'warn-text');
      }
      busy = false;
      btn.disabled = false;
      render();
    });
    body.querySelector('#pm-manual')?.addEventListener('click', () => {
      const box = body.querySelector('#pm-manual-box');
      if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
      body.querySelector('#pm-manual-id')?.focus();
    });
    body.querySelector('#pm-manual-cancel')?.addEventListener('click', () => {
      const box = body.querySelector('#pm-manual-box');
      if (box) box.style.display = 'none';
    });
    body.querySelector('#pm-manual-save')?.addEventListener('click', async () => {
      const id = String(body.querySelector('#pm-manual-id')?.value || '').trim();
      const name = String(body.querySelector('#pm-manual-name')?.value || '').trim();
      if (!id) { setStatus('模型 ID 不能为空', 'warn-text'); return; }
      await addModels(p, [{ id, name: name || id }]);
    });
    body.querySelector('#pm-add-picked')?.addEventListener('click', async () => {
      const picked = [...body.querySelectorAll('.pm-remote-item input:checked')].map((el) => el.value);
      if (!picked.length) { setStatus('先勾选要加入的模型', 'warn-text'); return; }
      await addModels(p, picked.map((m) => ({ id: m, name: m })));
      remote = remote.filter((m) => !picked.includes(m));
    });
    body.querySelectorAll('[data-pm]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const model = btn.dataset.model;
        if (btn.dataset.pm === 'use') {
          try {
            await api('/api/config', {
              method: 'POST',
              body: JSON.stringify({ api: { provider: p.id, model, baseUrl: p.baseURL || '', apiKey: p.apiKey || '' } })
            });
            await refreshProviders();
            await loadSettings();
            setStatus(`已切换到 ${model}`, 'ok-text');
          } catch (e) { setStatus(`切换失败：${e.message}`, 'warn-text'); }
          render();
          return;
        }
        if (btn.dataset.pm === 'del') {
          if (!confirm(`从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
          try {
            await api('/api/providers/models', { method: 'DELETE', body: JSON.stringify({ providerId: p.id, modelId: model }) });
            await refreshProviders();
            await loadSettings();
            setStatus(`已删除 ${model}`, 'muted');
          } catch (e) { setStatus(`删除失败：${e.message}`, 'warn-text'); }
          render();
        }
      });
    });
  }

  async function addModels(p, models) {
    try {
      await api('/api/providers/models', { method: 'POST', body: JSON.stringify({ providerId: p.id, models }) });
      await refreshProviders();
      await loadSettings();
      setStatus(`已加入 ${models.length} 个模型`, 'ok-text');
    } catch (e) {
      setStatus(`加入失败：${e.message}`, 'warn-text');
    }
    render();
  }

  overlay.querySelector('#pm-close')?.addEventListener('click', () => closeModelModal(overlay));
  render();
}

/** 改提供商的 Base URL / 显示名（中转站换域名，不用删了重加）。 */
function openProviderUrlModal(prov) {
  const overlay = modelModalShell({
    head: `修改地址 · ${esc(prov.displayName || prov.id)}`,
    body: `
      <div class="field"><label>显示名</label><input type="text" id="prov-name-input" value="${esc(prov.displayName || '')}" /></div>
      <div class="field"><label>Base URL</label><input type="text" id="prov-url-input" value="${esc(prov.baseURL || '')}" placeholder="https://api.example.com/v1" />
        <div class="hint">以 /v1 结尾最常见；保存后如果这是当前使用的提供商，请求会立刻改发到新地址。</div></div>
      <div class="hint" id="prov-url-result"></div>`,
    foot: `<button class="btn" id="prov-url-cancel">取消</button>
           <button class="btn btn-primary" id="prov-url-save">保存</button>`
  });
  const hint = overlay.querySelector('#prov-url-result');
  overlay.querySelector('#prov-url-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#prov-url-save')?.addEventListener('click', async () => {
    const baseURL = String(overlay.querySelector('#prov-url-input')?.value || '').trim();
    const displayName = String(overlay.querySelector('#prov-name-input')?.value || '').trim();
    if (!baseURL) { hint.textContent = 'Base URL 不能为空'; return; }
    try {
      await api('/api/providers/update', { method: 'POST', body: JSON.stringify({ id: prov.id, baseURL, displayName }) });
      closeModelModal(overlay);
      await loadSettings();
      showToast('地址已更新', 'ok');
    } catch (e) {
      hint.textContent = '保存失败：' + e.message;
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL, apiKey: p.apiKey || '' } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="model-modal-right" id="ma-list" style="flex:1">
        ${remoteModels.map((m) => `
          <label class="mm-model">
            <input type="checkbox" class="ma-check" value="${esc(m)}" ${existingIds.has(m) ? 'checked disabled' : ''} />
            <span>${esc(m)}</span>
            ${existingIds.has(m) ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
          </label>`).join('') || '<div class="muted" style="padding:10px">没有拉到模型</div>'}
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });
  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!confirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查协议端）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'api') {
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12
    };
  }

  if (sec === 'search') {
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'auto'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search'
    };
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || '')
    };
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    patch.deny = { groups: [], private: [] };
    patch.allowAllWhenEmpty = false;
  }

  if (sec === 'chat') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 2000;
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 8
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25
    };
    patch.replyPolicy = {
      ...(c.replyPolicy || {}),
      enabled: chk('#cfg-reply-enabled', c.replyPolicy?.enabled !== false),
      keywords: parseList(val('#cfg-reply-keywords', (c.replyPolicy?.keywords || []).join(','))),
      otherProbability: Math.min(1, Math.max(0, Number(val('#cfg-reply-prob', c.replyPolicy?.otherProbability ?? 0.15)))),
      masterProbability: Math.min(1, Math.max(0, Number(val('#cfg-reply-master-prob', c.replyPolicy?.masterProbability ?? 0.35))))
    };
    patch.sticker = { ...c.sticker, enabled: chk('#cfg-sticker', c.sticker?.enabled !== false) };
    patch.store = {
      pastStateLimit: Math.min(500, Math.max(10, Number(val('#cfg-pastlimit', c.store?.pastStateLimit)) || 80)),
      pastStateMaxChars: Math.min(60000, Math.max(1000, Number(val('#cfg-pastchars', c.store?.pastStateMaxChars)) || 6000))
    };
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
  }

  if (sec === 'onebot') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}

// ── 标签页切换（事件委托：扩展动态加的页签也能用）──
document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (!tab || !tab.dataset.tab) return;
  switchTab(tab.dataset.tab);
});

// ── 启动 ──
(async function init() {
  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  loadPluginPanels();   // 扩展自带页签（金币商店、签到榜…）
  loadSessions();
})();
