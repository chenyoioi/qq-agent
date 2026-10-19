#!/usr/bin/env node
// 把梗鲸图库镜像到本地：索引 + 图片，改写成本地 URL，由控制台 /gallery/* 提供。
//
//   node scripts/mirror-gallery.mjs [--concurrency 8] [--limit N]
//
// 产物：
//   data/gallery-mirror/catalog.json   改写后的索引（本地文件存在才改本地 URL，否则保留远端）
//   data/gallery-mirror/orig/<id>.<ext>
//   data/gallery-mirror/preview/<id>.<ext>
//
// 可重复执行：已存在的文件会跳过（断点续传）。
import fs from 'node:fs';
import path from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'data', 'gallery-mirror');
const REMOTE_INDEX = 'https://aigengtu.com/gallery-index.json';
const REMOTE_BASE = 'https://img.aigengtu.com';
const LOCAL_BASE = 'http://127.0.0.1:3210/gallery';

// 这台机器没有可用 IPv6，且连 Cloudflare 慢；固定 IPv4 + 长连接超时。
setGlobalDispatcher(new Agent({ connect: { timeout: 30_000, family: 4 } }));

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) || def : def;
};
const CONCURRENCY = Math.max(1, argOf('--concurrency', 8));
const LIMIT = argOf('--limit', 0);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, { tries = 4, timeout = 60_000, as = 'json' } = {}) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < tries) await sleep(800 * i);
    }
  }
  throw lastErr;
}

function extOf(url) {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url || '');
  return m ? m[1].toLowerCase() : 'webp';
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'orig'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'preview'), { recursive: true });

  log('拉取索引…');
  const raw = await fetchRetry(REMOTE_INDEX, { timeout: 120_000 });
  fs.writeFileSync(path.join(OUT, 'index-raw.json'), JSON.stringify(raw));

  // 展平成条目：{ id, character, name, story, url, preview }
  const items = [];
  for (const [character, node] of Object.entries(raw?.gallery || {})) {
    for (const img of node?.images || []) {
      const url = String(img.url || img.original || '');
      const preview = String(img.preview || '');
      if (!url) continue;
      const id = (/meme\/([^.]+)\./.exec(url) || [])[1] || `${character}-${items.length}`;
      items.push({ id, character, name: String(img.name || ''), story: img.story || null, url, preview });
    }
  }
  log(`索引条目 ${items.length} 个`);

  // 下载去重后的文件
  const tasks = [];
  for (const it of items) {
    tasks.push({ kind: 'orig', id: it.id, url: it.url });
    if (it.preview) tasks.push({ kind: 'preview', id: it.id, url: it.preview });
  }
  const seen = new Set();
  const uniq = tasks.filter((t) => {
    const key = `${t.kind}:${t.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const todo = LIMIT > 0 ? uniq.slice(0, LIMIT) : uniq;
  log(`待下载 ${todo.length} 个文件（并发 ${CONCURRENCY}）`);

  let done = 0;
  let skipped = 0;
  let failed = 0;
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      const file = path.join(OUT, t.kind === 'orig' ? 'orig' : 'preview', `${t.id}.${extOf(t.url)}`);
      if (fs.existsSync(file) && fs.statSync(file).size > 0) { skipped++; continue; }
      try {
        const buf = await fetchRetry(t.url, { as: 'buffer', timeout: 45_000, tries: 3 });
        if (!buf.length) throw new Error('空文件');
        fs.writeFileSync(file, buf);
        done++;
        if (done % 50 === 0) log(`已下载 ${done}/${todo.length}（失败 ${failed}）`);
      } catch (e) {
        failed++;
        if (failed <= 10) log(`失败 ${t.kind}/${t.id}: ${e?.message ?? e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(`下载完成：新增 ${done}，跳过 ${skipped}，失败 ${failed}`);

  // 生成改写后的索引：保持原图库的 { gallery: {...} } 形状（两个插件都按这个解析），
  // 本地文件存在 → 本地 URL；否则保留远端（镜像没下完也能用）。
  const gallery = {};
  let localCount = 0;
  for (const [character, node] of Object.entries(raw?.gallery || {})) {
    const images = (node?.images || []).map((img) => {
      const url = String(img.url || img.original || '');
      const preview = String(img.preview || '');
      const id = (/meme\/([^.]+)\./.exec(url) || [])[1] || '';
      const origFile = path.join(OUT, 'orig', `${id}.${extOf(url)}`);
      const prevFile = preview ? path.join(OUT, 'preview', `${id}.${extOf(preview)}`) : '';
      const hasOrig = id && fs.existsSync(origFile) && fs.statSync(origFile).size > 0;
      const hasPrev = id && prevFile && fs.existsSync(prevFile) && fs.statSync(prevFile).size > 0;
      if (hasOrig) localCount++;
      return {
        ...img,
        url: hasOrig ? `${LOCAL_BASE}/orig/${id}.${extOf(url)}` : url,
        preview: hasPrev ? `${LOCAL_BASE}/preview/${id}.${extOf(preview)}` : preview
      };
    });
    gallery[character] = { ...node, images };
  }
  const out = { gallery };
  fs.writeFileSync(path.join(OUT, 'gallery-index.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(OUT, 'mirror-ready.json'), JSON.stringify({ at: Date.now(), items: items.length, local: localCount }));
  log(`gallery-index.json 已生成：${items.length} 条，其中本地图 ${localCount} 条`);
}

main().catch((e) => { console.error('镜像失败：', e); process.exit(1); });
