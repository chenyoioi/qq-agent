// 插画搜图发群（pixiv-search）—— LLM 型技能，放 skills/。
//
// ── 为什么是技能（skills/）而不是插件（plugins/）────────────────────────────
// 「群友这句话是不是在要图」「要的是哪个角色」「中文名该翻成哪个日文原名」
// 只能靠模型理解人话，写不成死规则。所以注册工具进模型的 function 列表，
// 用不用、什么时候用由模型判断（与 trendy-memes / deai-flavor 同一判定）。
//
// ── 这台机器上"按关键词搜图发群"的真实网络处境（全部实测，决定了实现方式）──
//   ① P 站图床 i.pximg.net：超时（连不上）。
//   ② 所有 P 站取图反代（pixiv.re / pixiv.cat / i.pixiv.re / pixiv.download…）：
//      超时或 404 —— 它们都要回源到 ①，所以网关被墙时**一个都不通**。
//      现象很有迷惑性：pixiv.re 首页能打开（200），但 real 作品的 {pid}.png 只会挂到超时。
//   ③ P 站搜索接口 api.lolicon.app：时通时不通（实测 6 次成功 1 次）。它能给出
//      作品号，但图仍然取不回来 —— 拿到号也没用，所以这条不再作为主路。
//   ④ Bing 图片搜索（cn.bing.com/images）：**可用**，300ms 左右返回，
//      每次给 18~35 条候选图。候选里的图源约五到七成可直接下载（花瓣、堆糖、
//      699pic、新浪图床等国内 CDN 都是几百毫秒），其余（i.pximg.net 系、
//      i.bobopic.com、cdn.ibispaint.com 等）会挂到超时。
// 结论：能真正把图发进群的只有 ④。所以本技能的做法是 **用 Bing 搜索 + 只挑
// 下得回来的图源**：跳过已知不可达的域名（省掉每次 6~10 秒的空等），并且**并发
// 试多张**，谁先下来发谁 —— 单张图源抽风不会拖垮整个请求。
//
// ── 中文关键词要翻成日文原名 ───────────────────────────────────────────────
// 「初音未来」搜出来的图远不如「初音ミク」；模型知道这层对应，本技能负责**记住**：
// 一旦某个中文名配上某个日文名搜到了图，就落盘，下次不用模型再填。内置了一份
// 常见角色/作品的底稿，首次运行自动写进数据目录，可以用记事本直接改（改完立即生效）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
// ⚠️ DATA_DIR 不能按本目录推算：它会被 QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 重定向
// （本机就跑在安装根目录的 data/ 下，而不是 resources/app/data/）。
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');
const STATE_DIR = path.join(DATA_DIR, 'pixiv-search');
const DICT_FILE = path.join(STATE_DIR, 'keywords.json');
const SENT_FILE = path.join(STATE_DIR, 'sent.json');
const BADHOST_FILE = path.join(STATE_DIR, 'slow-hosts.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEARCH_TIMEOUT_MS = 9000;
const IMG_TIMEOUT_MS = 7000;          // 图源要么几百毫秒回来，要么就是墙了 —— 7 秒足够分辨
const CONCURRENCY = 4;                // 并发试几张（别再一张张等 7 秒超时）
const SENT_CAP = 3000;
const BAD_HOST_AFTER = 3;             // 同一个图源连续失败几次就拉黑，直接不再试
const BAD_HOST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULTS = {
  count: 1,
  maxTries: 10,
  maxBytes: 10 * 1024 * 1024,
  saveSentIndex: true
};

/**
 * 已知在本机不可达的图源（P 站图床及其反代）。
 * 不跳过的代价：每次搜索都会挑到它们、然后白等满超时。
 */
const BLOCKED_HOSTS = /(^|\.)(pximg\.net|pixiv\.re|pixiv\.cat|pixiv\.net|pixiv\.me|pixiv\.download|pixiv\.pics)$/i;

/** 内置底稿：常见角色 / 作品的中文 → 日文原名。首次运行写进数据目录后即可自由编辑。 */
const SEED_KEYWORDS = [
  { tag: '初音ミク', zh: ['初音未来', '初音', 'miku'] },
  { tag: '巡音ルカ', zh: ['巡音露卡', '巡音', 'luka'] },
  { tag: '鏡音リン', zh: ['镜音铃', '镜音', 'rin'] },
  { tag: '重音テト', zh: ['重音teto'] },
  { tag: '博麗霊夢', zh: ['博丽灵梦', '灵梦', 'reimu'] },
  { tag: '霧雨魔理沙', zh: ['雾雨魔理沙', '魔理沙', 'marisa'] },
  { tag: '古明地こいし', zh: ['古明地恋', '恋恋', 'koishi'] },
  { tag: '古明地さとり', zh: ['古明地觉', 'satori'] },
  { tag: 'フランドール・スカーレット', zh: ['芙兰朵露', '芙兰', 'flandre'] },
  { tag: 'レミリア・スカーレット', zh: ['蕾米莉亚', 'remilia'] },
  { tag: '十六夜咲夜', zh: ['咲夜', 'sakuya'] },
  { tag: 'チルノ', zh: ['琪露诺', 'cirno'] },
  { tag: '八雲紫', zh: ['八云紫', 'yukari'] },
  { tag: '東風谷早苗', zh: ['东风谷早苗', '早苗', 'sanae'] },
  { tag: '魂魄妖夢', zh: ['魂魄妖梦', '妖梦', 'youmu'] },
  { tag: '西行寺幽々子', zh: ['西行寺幽幽子', '幽幽子', 'yuyuko'] },
  { tag: '天童アリス', zh: ['天童爱丽丝', '爱丽丝'] },
  { tag: '砂狼シロコ', zh: ['砂狼白子', '白子', 'shiroko'] },
  { tag: '小鳥遊ホシノ', zh: ['小鸟游星野', '星野', 'hoshino'] },
  { tag: '空崎ヒナ', zh: ['空崎日奈', '日奈', 'hina'] },
  { tag: '聖園ミカ', zh: ['圣园弥香', '弥香'] },
  { tag: 'ブルーアーカイブ', zh: ['碧蓝档案', '蔚蓝档案', 'bluearchive'] },
  { tag: 'アズールレーン', zh: ['碧蓝航线', 'azurlane'] },
  { tag: '原神', zh: ['原神', 'genshin'] },
  { tag: '崩壊スターレイル', zh: ['崩坏星穹铁道', '星穹铁道', '星铁'] },
  { tag: 'ウマ娘', zh: ['赛马娘', 'umamusume'] },
  { tag: 'ラブライブ', zh: ['lovelive', 'lovelive!'] },
  { tag: 'アイドルマスター', zh: ['偶像大师'] },
  { tag: 'ドラえもん', zh: ['哆啦a梦', '机器猫'] },
  { tag: '名探偵コナン', zh: ['名侦探柯南', '柯南'] },
  { tag: 'ワンピース', zh: ['海贼王', 'onepiece'] },
  { tag: 'ナルト', zh: ['火影忍者', '火影'] },
  { tag: '鬼滅の刃', zh: ['鬼灭之刃', '鬼灭'] },
  { tag: '呪術廻戦', zh: ['咒术回战'] },
  { tag: '進撃の巨人', zh: ['进击的巨人'] },
  { tag: 'セーラームーン', zh: ['美少女战士'] },
  { tag: 'エヴァンゲリオン', zh: ['新世纪福音战士', 'eva'] },
  { tag: '壁紙', zh: ['壁纸', 'wallpaper'] },
  { tag: '風景', zh: ['风景', '景色'] },
  { tag: '猫耳', zh: ['猫耳', '猫娘'] },
  { tag: '制服', zh: ['制服', '校服'] },
  { tag: '水着', zh: ['泳装', '泳衣'] },
  { tag: '和服', zh: ['和服', '浴衣'] },
  { tag: 'ドレス', zh: ['礼服', '裙子'] },
  { tag: 'オリジナル', zh: ['原创'] }
];

let api = null;
const settings = () => ({ ...DEFAULTS, ...(api?.config?.() || {}) });
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { try { api?.log?.(...a); } catch { /* ignore */ } };
const warn = (...a) => { try { api?.warn?.(...a); } catch { /* ignore */ } };

/* ── 落盘小工具（原子写：先写临时文件再改名，避免半个 JSON 文件）──────────── */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ── 关键词词典：中文 → 日文原名 ─────────────────────────────────────────── */

let dictCache = null;
const normKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');

function loadDict() {
  if (dictCache) return dictCache;
  let raw = readJson(DICT_FILE);
  if (!raw || !Array.isArray(raw.entries) || !raw.entries.length) {
    // 首次运行：把底稿写进数据目录；之后以文件为准，不再覆盖用户改动
    try {
      writeJsonAtomic(DICT_FILE, { entries: SEED_KEYWORDS });
      log(`首次运行：已把 ${SEED_KEYWORDS.length} 条常见角色的中日对应写进 ${DICT_FILE}`);
    } catch (error) {
      warn('词典底稿写入失败（不影响本次搜索）：', error?.message ?? error);
    }
    raw = { entries: SEED_KEYWORDS };
  }
  const map = new Map();
  for (const e of raw.entries) {
    const tag = String(e?.tag ?? '').trim();
    if (!tag) continue;
    for (const zh of [tag, ...(Array.isArray(e?.zh) ? e.zh : [])]) {
      const k = normKey(zh);
      if (k && !map.has(k)) map.set(k, tag);
    }
  }
  dictCache = map;
  return map;
}

/** 中文关键词 → 日文原名；查不到返回空串。组合词按空格/标点切段分别翻。 */
function translate(keyword) {
  const dict = loadDict();
  const whole = dict.get(normKey(keyword));
  if (whole) return whole;
  const parts = String(keyword ?? '').split(/[\s,，、+]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const mapped = parts.map((p) => dict.get(normKey(p)) || p);
  return mapped.some((m, i) => m !== parts[i]) ? mapped.join(' ') : '';
}

/** 记住一条新的中文→日文对应（模型在 tag 参数里给了日文名时调用）。 */
function rememberKeyword(zh, tag) {
  const z = String(zh ?? '').trim();
  const t = String(tag ?? '').trim();
  if (!z || !t || normKey(z) === normKey(t)) return;
  try {
    const raw = readJson(DICT_FILE);
    const entries = Array.isArray(raw?.entries) ? raw.entries : SEED_KEYWORDS;
    const hit = entries.find((e) => normKey(e?.tag) === normKey(t));
    if (hit) hit.zh = [...new Set([...(Array.isArray(hit.zh) ? hit.zh : []), z])];
    else entries.push({ tag: t, zh: [z] });
    writeJsonAtomic(DICT_FILE, { entries });
    dictCache = null;
    log(`记住关键词对应：「${z}」→「${t}」`);
  } catch (error) {
    warn('关键词词典写入失败（不影响本次）：', error?.message ?? error);
  }
}

/* ── 已发过的图（同一个群不要重复发同一张）──────────────────────────────── */

let sentCache = null;

function loadSent() {
  if (sentCache) return sentCache;
  const raw = readJson(SENT_FILE);
  sentCache = (raw && typeof raw.seen === 'object' && raw.seen) ? raw.seen : {};
  return sentCache;
}

const hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const sentKeysIn = (chatKey) => new Set(
  Object.keys(loadSent()).filter((k) => k.startsWith(`${chatKey}::`)).map((k) => k.slice(chatKey.length + 2))
);

function markSent(chatKey, url) {
  if (settings().saveSentIndex === false) return;
  try {
    const seen = loadSent();
    seen[`${chatKey}::${hashOf(url)}`] = Date.now();
    const keys = Object.keys(seen);
    if (keys.length > SENT_CAP) {
      const keep = keys.sort((a, b) => (seen[a] || 0) - (seen[b] || 0)).slice(-SENT_CAP);
      sentCache = Object.fromEntries(keep.map((k) => [k, seen[k]]));
    }
    writeJsonAtomic(SENT_FILE, { seen: sentCache });
  } catch (error) {
    warn('已发索引写入失败（不影响本次）：', error?.message ?? error);
  }
}

/* ── 慢图源黑名单：同一个域名连续超时就别再试（省掉每次 7 秒空等）────────── */

let badCache = null;

function loadBad() {
  if (badCache) return badCache;
  const raw = readJson(BADHOST_FILE);
  badCache = (raw && typeof raw.hosts === 'object' && raw.hosts) ? raw.hosts : {};
  return badCache;
}

function isBadHost(host) {
  const rec = loadBad()[host];
  if (!rec) return false;
  if (Date.now() - (rec.at || 0) > BAD_HOST_TTL_MS) return false;   // 过期放行：网络可能好了
  return (rec.fail || 0) >= BAD_HOST_AFTER;
}

function noteHostResult(host, ok) {
  try {
    const hosts = loadBad();
    if (ok) delete hosts[host];
    else hosts[host] = { fail: (hosts[host]?.fail || 0) + 1, at: Date.now() };
    badCache = hosts;
    writeJsonAtomic(BADHOST_FILE, { hosts });
  } catch { /* 记不住也不影响发送 */ }
}

/* ── 搜索 ─────────────────────────────────────────────────────────────────── */

/**
 * 用 Bing 图片搜索拿到候选图 URL。**只返回图，不返回网页** —— 后续要下载发送。
 * 顺带过滤掉已知不可达的图源域名，以及连续失败过的慢图源。
 */
async function searchImages(query, { timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const url = `https://cn.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  let resp;
  try {
    resp = await api.fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const e = new Error(`图片搜索连不上：${error?.message ?? error}`);
    e.netError = true;
    throw e;
  }
  if (!resp.ok) throw new Error(`图片搜索返回 HTTP ${resp.status}`);
  const html = await resp.text();

  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/murl&quot;:&quot;([^&]+?)&quot;/g)) {
    const u = m[1].replace(/&amp;/g, '&').replace(/\\u002f/gi, '/');
    if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
    let host = '';
    try { host = new URL(u).hostname; } catch { continue; }
    if (BLOCKED_HOSTS.test(host) || isBadHost(host)) continue;
    seen.add(u);
    out.push({ url: u, host, query });
  }
  return out;
}

/** 下载一张图到临时文件；超过体积上限或不是图片都算失败。 */
async function downloadImage(item, timeoutMs, maxBytes) {
  let resp;
  try {
    resp = await api.fetch(item.url, {
      headers: {
        'user-agent': UA,
        referer: 'https://cn.bing.com/',
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    noteHostResult(item.host, false);
    throw error;
  }
  if (!resp.ok) { noteHostResult(item.host, false); throw new Error(`HTTP ${resp.status}`); }
  const mime = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image')) { noteHostResult(item.host, false); throw new Error(`不是图片（${mime || '未知类型'}）`); }
  const declared = Number(resp.headers.get('content-length')) || 0;
  if (declared && declared > maxBytes) { throw new Error(`图太大（${Math.round(declared / 1048576)}MB）`); }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) { noteHostResult(item.host, false); throw new Error('内容为空'); }
  if (buf.length > maxBytes) throw new Error(`图太大（${Math.round(buf.length / 1048576)}MB）`);
  if (buf.length < 4096) { noteHostResult(item.host, false); throw new Error('图太小，疑似占位图'); }
  const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : mime.includes('gif') ? '.gif' : '.jpg';
  const file = path.join(os.tmpdir(), `pixiv-search_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  fs.writeFileSync(file, buf);
  noteHostResult(item.host, true);
  return { file, bytes: buf.length };
}

/**
 * 并发试候选：每批 CONCURRENCY 张同时下载，谁先成功就先用谁（不再一张张等超时）。
 * 返回 { got, tried, errors }。
 */
async function pickImages(candidates, { need, maxTries, timeoutMs, maxBytes, sentKeys }) {
  const fresh = [];
  const repeat = [];
  for (const c of candidates) {
    if (fresh.length + repeat.length >= maxTries) break;
    if (sentKeys.has(hashOf(c.url))) repeat.push(c);
    else fresh.push(c);
  }
  const queue = [...fresh, ...repeat];      // 新的优先；都发过了才允许重复（好过一张都发不出）

  const got = [];
  const errors = [];
  let tried = 0;
  for (let i = 0; i < queue.length && got.length < need; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    tried += batch.length;
    const settled = await Promise.all(batch.map(async (item) => {
      try {
        const r = await downloadImage(item, timeoutMs, maxBytes);
        return { item, ...r };
      } catch (error) {
        errors.push(`${item.host}：${error?.message ?? error}`);
        return null;
      }
    }));
    for (const r of settled) {
      if (!r) continue;
      if (got.length < need) got.push(r);
      else { try { fs.rmSync(r.file, { force: true }); } catch { /* ignore */ } }   // 多余的备选直接删
    }
  }
  return { got, tried, errors };
}

const cleanup = (file) => { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } };

/* ── 工具 ─────────────────────────────────────────────────────────────────── */

export function setup(hostApi) {
  api = hostApi;

  hostApi.registerTool({
    id: 'search_send',
    name: '搜插画并发到当前会话',
    category: 'media',
    icon: '🖼️',
    description: '按关键词搜插画，并把图**直接发到当前会话**。群友说「来张XX的图」「搜一下XX」「有没有XX的图」「发点XX的图」时用它。\n'
      + 'keyword 填群友说的词（中文就行，比如"初音未来"）；你**知道**它的日文原名时顺手填进 tag（例：初音ミク、博麗霊夢、ブルーアーカイブ）—— 日文名搜出来的图明显更好，技能还会记住这个对应关系。\n'
      + '搜索走 Bing 图片（本机可直连），会自动跳过下载不了的图源并并发多试几张，所以偶尔整体失败是正常的网络现象。同一个群不会重复发同一张。\n'
      + '失败时**不要**编造"图已经发了"：如实说一句这次没取到图就行，换个说法可以再试一次。\n'
      + '不要向群友复述图片网址、图源网站、作品号、超时这类内部细节。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，中文就行（如"初音未来"、"博丽灵梦"、"猫耳少女"）' },
        tag: { type: 'string', description: '可选：你已知的日文原名（如"初音ミク"）。填了优先用它搜，并被记住' },
        count: { type: 'integer', description: '要发几张，默认 1，上限 3' }
      },
      required: ['keyword']
    },
    async execute(ctx, args) {
      const s = settings();
      if (s.enabled === false) return { content: '这个功能被关掉了。', isError: true };
      const chatKey = String(ctx?.chatKey ?? '');
      if (!chatKey) return { content: '拿不到当前会话，没发出去。', isError: true };

      const keyword = String(args?.keyword ?? '').trim();
      if (!keyword) return { content: '没有给关键词，不知道该搜什么。', isError: true };
      const hintTag = String(args?.tag ?? '').trim();
      if (hintTag) rememberKeyword(keyword, hintTag);

      const fromDict = translate(keyword);
      const base = hintTag || fromDict || keyword;
      // 有假名 = 已经是日文原名（「初音ミク」是），用它配日文的「イラスト」最准；
      // 中文词（「猫耳少女」）配中文的「插画」；只有汉字的日文名（「原神」）两边都试。
      const hasKana = /[\u3040-\u30ff]/.test(base);
      const suffix = hasKana ? 'イラスト' : '插画';
      const queries = [...new Set([
        `${base} ${suffix}`,
        `${base} ${hasKana ? '插画' : 'イラスト'}`,
        base
      ])].filter(Boolean).slice(0, 2);                    // 两种组合词足够，别把请求数堆上去
      log(`搜索「${keyword}」→ 查询词：${queries.join(' | ')}`);

      // ① 搜索（多个查询词合并候选，去重）
      const candidates = [];
      const seenUrl = new Set();
      const searchErrors = [];
      for (const q of queries) {
        try {
          const found = await searchImages(q);
          for (const c of found) {
            if (seenUrl.has(c.url)) continue;
            seenUrl.add(c.url);
            candidates.push(c);
          }
          log(`「${q}」拿到 ${found.length} 条候选`);
        } catch (error) {
          searchErrors.push(`${q}：${error?.message ?? error}`);
        }
        if (candidates.length >= 24) break;
      }
      if (!candidates.length) {
        return {
          content: `没搜到「${keyword}」的图${searchErrors.length ? `（${searchErrors[0]}）` : ''}。\n`
            + '如实告诉群友这次没搜到就行，不要编造"已经发了"。可以换个更常见的叫法再试一次。',
          isError: true
        };
      }

      // ② 挑下得回来的图（并发试，跳过已发过的）
      const need = clamp(Number(args?.count) || Number(s.count) || 1, 1, 3);
      const picked = await pickImages(candidates, {
        need,
        maxTries: clamp(Number(s.maxTries) || DEFAULTS.maxTries, 2, 20),
        timeoutMs: IMG_TIMEOUT_MS,
        maxBytes: clamp(Number(s.maxBytes) || DEFAULTS.maxBytes, 65536, 32 * 1024 * 1024),
        sentKeys: sentKeysIn(chatKey)
      });

      if (!picked.got.length) {
        return {
          content: `搜到 ${candidates.length} 张「${keyword}」的候选图，但试了 ${picked.tried} 张都没能下载下来`
            + `（${picked.errors.slice(0, 2).join('；')}）。\n`
            + '如实说一句这次没取到图就行（本机有些图源连不上是常事），不要说"已经发了"。',
          isError: true
        };
      }

      // ③ 发送
      const done = [];
      const sendErrors = [];
      for (const item of picked.got) {
        try {
          await ctx.sender.sendImage(chatKey, { file: item.file });
          markSent(chatKey, item.item.url);
          done.push(item);
        } catch (error) {
          sendErrors.push(error?.message ?? error);
        } finally {
          cleanup(item.file);
        }
      }

      if (!done.length) {
        return { content: `图下载到了但没发出去（${sendErrors.slice(0, 2).join('；')}）。如实说一句没发出去就行。`, isError: true };
      }
      log(`已发送 ${done.length} 张（候选 ${candidates.length}，试了 ${picked.tried} 张，图源 ${done.map((d) => d.item.host).join(', ')}）`);
      return {
        content: `已经把 ${done.length} 张「${keyword}」的插画发到当前会话了（图源 ${done.map((d) => d.item.host).join('、')}）。\n`
          + '配一句短话就行：**不要**复述图片网址、图源网站或"已发送"这类内部细节。'
      };
    }
  });

  hostApi.registerTool({
    id: 'send_by_url',
    name: '按图片网址发一张图',
    category: 'media',
    icon: '🔗',
    description: '把一张**指定网址**的图片下载下来并发到当前会话。用在：群友自己贴了一个图片直链，'
      + '或者你已经从别处（比如 web_search 的结果里）拿到一个图片地址。必须是能直接打开的图片地址（以 .jpg/.png/.webp/.gif 结尾，或明确是图片内容）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片直链（http/https）' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      const s = settings();
      const chatKey = String(ctx?.chatKey ?? '');
      if (!chatKey) return { content: '拿不到当前会话，没发出去。', isError: true };
      const url = String(args?.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) return { content: '这不是一个 http/https 图片地址。', isError: true };
      let host = '';
      try { host = new URL(url).hostname; } catch { return { content: '图片地址解析失败。', isError: true }; }
      if (BLOCKED_HOSTS.test(host)) {
        return { content: '这个图源（P 站图床及其反代）在本机连不上，换一张或换个图源再试。', isError: true };
      }
      let got = null;
      try {
        got = await downloadImage({ url, host }, IMG_TIMEOUT_MS, clamp(Number(s.maxBytes) || DEFAULTS.maxBytes, 65536, 32 * 1024 * 1024));
      } catch (error) {
        return { content: `这张图没下载下来（${error?.message ?? error}）。如实说一句就行。`, isError: true };
      }
      try {
        await ctx.sender.sendImage(chatKey, { file: got.file });
        markSent(chatKey, url);
      } catch (error) {
        return { content: `图下到了但没发出去（${error?.message ?? error}）。`, isError: true };
      } finally {
        cleanup(got.file);
      }
      return { content: '已发到当前会话。配一句短话就行，不要复述网址。' };
    }
  });

  log(`插画搜图发群已加载（词典 ${loadDict().size} 个键，并发 ${CONCURRENCY}，慢图源黑名单 ${Object.keys(loadBad()).length} 条）`);
}

export function deactivate() {
  api = null;
  dictCache = null;
  sentCache = null;
  badCache = null;
}

/** 不探测网络：连不上是运行时的事，不能因为一次探测失败就把整个技能标成"依赖未就绪"。 */
export function available() {
  return { ok: true };
}

// 供排查 / 测试使用
export const _internals = {
  translate,
  loadDict,
  loadSent,
  loadBad,
  isBadHost,
  noteHostResult,
  searchImages,
  downloadImage,
  pickImages,
  hashOf,
  DICT_FILE,
  SENT_FILE,
  BADHOST_FILE,
  SEED_KEYWORDS
};
