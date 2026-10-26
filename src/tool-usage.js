// 工具使用统计 + "用多少给多少"的瘦身开关。
//
// 动机：每次调用都把 48~56 个工具的定义（约 4k token）整包发给模型，
// 其中大半几个月都没被用过 —— 纯纯的固定成本。这里记录真实使用情况，
// leanMode 打开后：N 天没用过的工具不再下发（随时能开回来，不影响已有数据）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'tool-usage.json');
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  if (!cache || typeof cache !== 'object') cache = {};
  if (!cache.tools || typeof cache.tools !== 'object') cache.tools = {};
  return cache;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch { /* 统计失败不影响主流程 */ }
}

/** 记一次工具调用（节流写盘：每 20 次或 60 秒写一次）。 */
let pendingWrites = 0;
let lastWrite = 0;
export function recordToolUse(name) {
  const key = String(name || '').trim();
  if (!key) return;
  const db = load();
  const rec = db.tools[key] || { count: 0, lastAt: 0 };
  rec.count += 1;
  rec.lastAt = Date.now();
  db.tools[key] = rec;
  pendingWrites += 1;
  if (pendingWrites >= 20 || Date.now() - lastWrite > 60000) {
    pendingWrites = 0;
    lastWrite = Date.now();
    save();
  }
}

/**
 * 从历史运行记录里补一份使用数据。
 * 只靠"从现在开始记"会让所有工具看起来都没用过，第一次开瘦身就会把全部工具藏掉。
 */
export function seedFromSessions(sessionsDir, { limit = 5000 } = {}) {
  let files = [];
  try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  files = files.slice(-limit);
  const db = load();
  let seeded = 0;
  for (const f of files) {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    const at = Number(d?.startedAt) || Date.now();
    for (const m of (d?.messages || [])) {
      const name = m?.toolCall?.name;
      if (!name) continue;
      const rec = db.tools[name] || { count: 0, lastAt: 0 };
      rec.count += 1;
      rec.lastAt = Math.max(rec.lastAt, at);
      db.tools[name] = rec;
      seeded += 1;
    }
  }
  if (seeded) save();
  return seeded;
}

export function toolUsage() {
  const db = load();
  const rows = Object.entries(db.tools).map(([name, r]) => ({ name, count: Number(r?.count) || 0, lastAt: Number(r?.lastAt) || 0 }));
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

/** 有过记录的工具名集合（用来区分"没用过"和"没有数据"）。 */
export function recordedNames() {
  return new Set(Object.keys(load().tools));
}

/** 最近 days 天内用过（或永远保留）的工具名集合。 */
export function recentlyUsedNames(days = 30) {
  const since = Date.now() - days * 86400000;
  const db = load();
  return new Set(Object.entries(db.tools).filter(([, r]) => Number(r?.lastAt) >= since).map(([n]) => n));
}
