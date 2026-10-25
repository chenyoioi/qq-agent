// 被拍多了会哈气（确定性型 / plugins/）
//
// QQ 的「拍一拍」会被 QQ Agent 记成一条普通消息：
//   { isPoke: true, self: false, text: '[拍一拍] 某人 拍了拍 我', ts: ... }
// 所以这里只做一件事：按时间窗口数「拍了拍我」的次数，达到阈值就炸毛发一句。
//
// 计数规则：
//   · 只数 isPoke=true、不是自己发的、文案里确实是「拍了拍 我」的记录；
//   · 只看 ts > sinceTs 的（sinceTs 是上一次哈气之后的时间点，触发后就重新计数）；
//   · 距上次哈气不足 cooldownSec 就先憋着。
// 全程本地运算，不经过模型，0 token。
//
// 同 repeat-breaker：短间隔定时器扫 data/messages/group_*.json；
// before-context 钩子只做保活 + 把当前群的快扫挪出同步栈（钩子里不发消息）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';

const DEFAULTS = {
  enabled: true,
  groups: '',
  windowSec: 300,
  threshold: 3,
  cooldownSec: 60,
  checkIntervalSec: 3,
  hissTexts: ''
};

const DEFAULT_HISS = [
  '嘶——！',
  '哈——！',
  '再拍试试看',
  '手不想要了就直说',
  '你想被咬吗',
  '信不信我咬你',
  '拍够没，最后一遍',
  '警告已经给过了',
  '再来我可不客气',
  '别逼我动手',
  '拍上瘾了是吧',
  '嘶——胆是真大'
];

/** 「拍了拍我」才算数（拍了拍自己 / 拍别人都不算） */
const POKE_ME_RE = /拍了拍\s*我/u;
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const STATE_FILE = path.join(DATA_DIR, 'poke-hiss-state.json');
const RECENT_TEXT_KEEP = 3;

let api = null;
let timer = null;
let ticking = false;
const warnedGroups = new Set();

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadState() {
  const s = readJson(STATE_FILE, null);
  const base = s && typeof s === 'object' ? s : {};
  return {
    groups: {},
    totalHiss: 0,
    lastHissAt: 0,
    sinceTs: 0,
    recentTexts: [],
    ...base,
    groups: base.groups && typeof base.groups === 'object' ? base.groups : {},
    recentTexts: Array.isArray(base.recentTexts) ? base.recentTexts.slice(-RECENT_TEXT_KEEP) : []
  };
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    api?.warn?.('状态写入失败：', error?.message ?? error);
  }
}

// ── 拍一拍计数 ──────────────────────────────────────────────────────────────

/** 一条记录是不是「别人拍了机器人」 */
export function isPokeMe(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.self) return false;
  if (msg.isPoke !== true) return false;
  return POKE_ME_RE.test(String(msg.text || ''));
}

/**
 * 数一下窗口内的拍一拍。
 * @param {Array} messages 该会话的全部消息（旧的在前）
 * @param {{windowSec:number, sinceTs:number}} opt
 * @returns {{count:number, latestId:number, latestTs:number, bySender:Record<string,number>}}
 */
export function countPokes(messages, opt = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const now = Date.now();
  const windowMs = Math.max(10, Number(opt.windowSec) || 300) * 1000;
  const sinceTs = Math.max(Number(opt.sinceTs) || 0, now - windowMs);

  let count = 0;
  let latestId = 0;
  let latestTs = 0;
  const bySender = {};

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const ts = Number(m?.ts) || 0;
    if (ts && ts < sinceTs) break;      // 再往前都超窗口了
    if (!isPokeMe(m)) continue;
    count += 1;
    const sid = String(m.senderId || '');
    if (sid) bySender[sid] = (bySender[sid] || 0) + 1;
    const id = Number(m.id) || 0;
    if (id > latestId) { latestId = id; latestTs = ts; }
  }
  return { count, latestId, latestTs, bySender };
}

function hissPool() {
  const raw = String(settings().hissTexts || '').trim();
  if (!raw) return DEFAULT_HISS;
  let parts = raw.split(/[\r\n,、;；|]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].length > 30) {
    parts = parts[0].split(/\s+/).map((s) => s.trim()).filter(Boolean);
  }
  return parts.length ? parts : DEFAULT_HISS;
}

/** 随机抽一句，避开最近几次用过的 */
export function pickHiss(state, s = settings()) {
  const pool = hissPool();
  const recent = new Set((state?.recentTexts || []).slice(-RECENT_TEXT_KEEP));
  let candidates = pool.filter((t) => !recent.has(t));
  if (!candidates.length) candidates = pool;
  const picked = candidates[Math.floor(Math.random() * candidates.length)] || '嘶——';
  if (state) state.recentTexts = [...(state.recentTexts || []), picked].slice(-RECENT_TEXT_KEEP);
  return picked;
}

// ── 发送 ────────────────────────────────────────────────────────────────────

function onebotEndpoint() {
  let cfg = null;
  try { cfg = getConfig(); } catch { /* 配置未就绪用默认口 */ }
  const httpUrl = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg?.snowluma?.httpAccessToken || cfg?.snowluma?.accessToken || '');
  return { httpUrl, token };
}

/** 优先走宿主发送队列；定时器里拿不到 sender 时才直发 OneBot（仅兜底） */
async function sendText(chatKey, text, senderOverride = null) {
  if (senderOverride && typeof senderOverride.sendTextBatch === 'function') {
    return senderOverride.sendTextBatch(chatKey, [text]);
  }
  const groupId = String(chatKey).startsWith('group:') ? String(chatKey).slice('group:'.length) : '';
  if (!groupId) throw new Error(`不支持的会话：${chatKey}`);
  const { httpUrl, token } = onebotEndpoint();
  const res = await fetch(`${httpUrl}/send_group_msg`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ group_id: Number(groupId), message: [{ type: 'text', data: { text } }] }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`send_group_msg HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'ok' && body.retcode !== 0) {
    throw new Error(`send_group_msg 失败：retcode=${body.retcode ?? body.status}`);
  }
  return body.data;
}

// ── 目标群与检查 ────────────────────────────────────────────────────────────

function targetGroups() {
  const s = settings();
  let allow = [];
  try { allow = (getConfig()?.allow?.groups || []).map(String); } catch { /* 未就绪 */ }
  const want = String(s.groups || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  if (!want.length) return allow;

  const allowSet = new Set(allow);
  const out = [];
  for (const g of want) {
    if (allowSet.has(g)) out.push(g);
    else if (!warnedGroups.has(g)) {
      warnedGroups.add(g);
      api?.warn?.(`群 ${g} 不在发送白名单里，已忽略（白名单：${allow.join(', ') || '空'}）`);
    }
  }
  return out;
}

function readGroupMessages(groupId) {
  const data = readJson(path.join(MESSAGES_DIR, `group_${groupId}.json`), null);
  return Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []);
}

async function checkGroup(groupId, state, now, s) {
  const msgs = readGroupMessages(groupId);
  if (!msgs.length) return false;

  const gs = state.groups[groupId] || (state.groups[groupId] = {});
  const sinceTs = Math.max(Number(gs.sinceTs) || 0, Number(state.sinceTs) || 0);
  const { count, latestId, latestTs } = countPokes(msgs, { windowSec: s.windowSec, sinceTs });
  gs.pokeCount = count;
  if (latestId) gs.latestPokeId = latestId;

  const threshold = Math.max(2, Math.min(50, Number(s.threshold) || 3));
  if (count < threshold) return false;

  const cooldownMs = Math.max(0, Number(s.cooldownSec) || 0) * 1000;
  const lastHiss = Math.max(Number(gs.lastHissAt) || 0, Number(state.lastHissAt) || 0);
  if (cooldownMs > 0 && now - lastHiss < cooldownMs) return false;

  const text = pickHiss(state, s);
  try {
    await sendText(`group:${groupId}`, text);
    gs.lastHissAt = now;
    // 触发后从这一条之后重新计数，避免窗口里同样的拍又被算一轮
    const resetTs = latestTs ? latestTs + 1 : now;
    gs.sinceTs = resetTs;
    state.lastHissAt = now;
    state.sinceTs = resetTs;
    state.totalHiss = (Number(state.totalHiss) || 0) + 1;
    api?.log?.(`群 ${groupId}：窗口内被拍 ${count} 次 → 哈气「${text}」`);
    return true;
  } catch (error) {
    api?.warn?.(`群 ${groupId} 哈气发送失败：`, error?.message ?? error);
    return false;
  }
}

async function tick(onlyGroupId = null) {
  if (ticking && !onlyGroupId) return;
  if (!onlyGroupId) ticking = true;
  try {
    const s = settings();
    if (s.enabled === false) return;
    const now = Date.now();
    const state = loadState();
    const groups = onlyGroupId
      ? (targetGroups().includes(String(onlyGroupId)) ? [String(onlyGroupId)] : [])
      : targetGroups();
    if (!groups.length) return;
    for (const g of groups) {
      try {
        await checkGroup(g, state, now, s);
      } catch (error) {
        api?.warn?.(`群 ${g} 检查出错（跳过）：`, error?.message ?? error);
      }
    }
    saveState(state);
  } catch (error) {
    api?.warn?.('哈气检查出错：', error?.message ?? error);
  } finally {
    if (!onlyGroupId) ticking = false;
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

function startLoop() {
  const s = settings();
  if (s.enabled === false) return;
  if (timer) return;
  const everySec = Math.max(1, Math.min(60, Number(s.checkIntervalSec) || 3));
  timer = setInterval(() => { tick().catch(() => {}); }, everySec * 1000);
  timer.unref?.();
  api?.log?.(
    `哈气已启用：窗口 ${Math.max(10, Number(s.windowSec) || 300)}s · 阈值 ${Math.max(2, Number(s.threshold) || 3)} 次`
    + ` · 冷却 ${Number(s.cooldownSec) || 60}s · 扫描 ${everySec}s`
  );
}

function stopLoop() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function setup(a) { api = a; }

export function activate() {
  if (settings().enabled === false) {
    api?.log?.('哈气：设置里是关闭状态，不启动定时器');
    return;
  }
  startLoop();
  tick().catch(() => {});
}

export function deactivate() { stopLoop(); }
export function dispose() { stopLoop(); }

export function available() {
  if (settings().enabled === false) return { ok: false, reason: '设置里已关闭「启用哈气」' };
  return true;
}

export const hooks = {
  // 钩子里不发消息、不做网络请求
  'before-context'(ctx = {}) {
    startLoop();
    const chatKey = String(ctx.chatKey || '');
    if (!chatKey.startsWith('group:')) return;
    const groupId = chatKey.slice('group:'.length);
    if (!groupId) return;
    setTimeout(() => { tick(groupId).catch(() => {}); }, 0);
  }
};

export const providers = {
  'status.poke-hiss': () => {
    const s = settings();
    const state = loadState();
    const groups = targetGroups();
    // 顺手算一下当前窗口内的拍数，给状态卡看
    let current = 0;
    try {
      if (groups.length) {
        const msgs = readGroupMessages(groups[0]);
        current = countPokes(msgs, { windowSec: s.windowSec, sinceTs: state.sinceTs }).count;
      }
    } catch { /* 读不到就算了 */ }

    return {
      icon: '🐈',
      title: '被拍多了会哈气',
      priority: 46,
      lines: [
        ['状态', s.enabled === false ? '已关闭' : (timer ? '运行中' : '未启动定时器')],
        ['目标群', groups.length ? `${groups.length} 个` : '无（白名单为空或未配置）'],
        ['窗口/阈值', `${Math.max(10, Number(s.windowSec) || 300)}s 内被拍 ${Math.max(2, Number(s.threshold) || 3)} 次`],
        ['冷却', `${Number(s.cooldownSec) || 60} 秒`],
        ['当前窗口计数', String(current)],
        ['累计哈气', String(Number(state.totalHiss) || 0)],
        ['上次哈气', state.lastHissAt
          ? new Date(state.lastHissAt).toLocaleString('zh-CN', { hour12: false })
          : '还没有']
      ]
    };
  }
};
