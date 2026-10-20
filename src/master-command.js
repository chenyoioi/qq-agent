// 主人指令解析：把各种大白话说法归一成 { action: 'on'|'off', query: '点歌' }。
// 放在独立模块里，方便单测覆盖（app.js 里只负责执行）。
//
// 支持的说法（举例）：
//   关闭点歌 / 关掉点歌功能 / 把点歌关了 / 点歌关掉 / 别点歌了 / 禁用点歌插件
//   打开点歌 / 开启点歌 / 点歌打开 / 恢复点歌 / 把点歌开开
// 不匹配就返回 null，交给模型正常聊天。

const OFF = ['关闭', '关掉', '关了', '关', '禁用', '停用', '停掉', '禁用掉'];
const ON = ['开启', '打开', '开了', '启用', '恢复', '启动', '开回来'];
const MODS = ['功能', '插件', '技能', '扩展', '模块', '开关'];
const FILLER = ['帮我', '帮忙', '请', '麻烦', '给我', '能不能', '可不可以'];

const escaped = (arr) => arr.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const VERB = `(?:${escaped(OFF)}|${escaped(ON)})`;
const MOD = `(?:${MODS.join('|')})?`;
const PREFIX = `(?:${escaped(FILLER).replace(/\\\|/g, '|')})?\\s*(?:把|将)?\\s*`;
const TARGET = '([^\\s，。！？,.!?、]{1,16}?)';
const TAIL = '(?:\\s*(?:掉|了|吧|呗|呀|啊|谢谢|行吗|好吗))*\\s*[。.!！?？]*';

const RE_FIRST = new RegExp(`^${PREFIX}(?:${VERB}|${OFF.join('|')}|${ON.join('|')})\\s*${TARGET}${MOD}${TAIL}$`);
const RE_LAST = new RegExp(`^${PREFIX}${TARGET}${MOD}\\s*(?:${VERB})${TAIL}$`);
const RE_DONT = new RegExp(`^${PREFIX}(?:别|不要|不用|不准)\\s*${TARGET}${TAIL}$`);

const OFF_SET = new Set(OFF);
const ON_SET = new Set(ON);
const DONT_PREFIX = /^(?:别|不要|不用|不准)/;

function actionOf(verb) {
  if (!verb) return null;
  if (OFF_SET.has(verb)) return 'off';
  if (ON_SET.has(verb)) return 'on';
  return null;
}

/** 去掉语气词/限定词，得到要匹配的扩展名 */
export function cleanQuery(raw) {
  let q = String(raw ?? '').trim();
  q = q.replace(/^(?:把|将|这个|那个|一下|下)/, '');
  for (const m of MODS) q = q.replace(new RegExp(m + '$'), '');
  q = q.replace(/(?:了|掉|吧|呗|呀|啊|的)+$/g, '');
  q = q.replace(/^["'“”‘’「」]|["'“”‘’「」]$/g, '');
  return q.trim();
}

/** 解析一条消息；返回 { action, query } 或 null */
export function parseMasterCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 40) return null;

  // 「别点歌了」
  let m = RE_DONT.exec(raw);
  if (m && !DONT_PREFIX.test('')) {
    const q = cleanQuery(m[1]);
    if (q) return { action: 'off', query: q };
  }

  // 「关闭点歌」/「打开语音」
  m = RE_FIRST.exec(raw);
  if (m) {
    const verb = [...OFF, ...ON].find((v) => v.length >= 2 && raw.includes(v)) || '';
    const action = actionOf(verb);
    const q = cleanQuery(m[1]);
    if (action && q) return { action, query: q };
  }

  // 「点歌关掉」/「语音打开」
  m = RE_LAST.exec(raw);
  if (m) {
    const q = cleanQuery(m[1]);
    const verb = [...OFF, ...ON].sort((a, b) => b.length - a.length).find((v) => raw.endsWith(v) || raw.includes(v));
    const action = actionOf(verb);
    if (action && q) return { action, query: q };
  }

  return null;
}

/** 大列表里的模糊匹配：精确 → 包含 → 二元组相似度（≥0.5） */
export function matchExtensions(list, query) {
  const q = String(query ?? '').trim();
  const arr = Array.isArray(list) ? list : [];
  if (!q) return [];
  if (/^(?:所有|全部|一切|每个|全)$/.test(q)) return arr.slice();

  const exact = arr.filter((s) => String(s.id) === q || String(s.name) === q);
  if (exact.length) return exact;

  const inc = arr.filter((s) => {
    const name = String(s.name ?? '');
    const id = String(s.id ?? '');
    return name.includes(q) || id.includes(q) || (name && q.includes(name));
  });
  if (inc.length) return inc;

  const bigrams = (str) => {
    const out = new Set();
    for (let i = 0; i < str.length - 1; i++) out.add(str.slice(i, i + 2));
    return out;
  };
  const qb = bigrams(q);
  if (!qb.size) return [];
  return arr
    .map((s) => {
      const nb = bigrams(String(s.name ?? '') + String(s.id ?? ''));
      let hit = 0;
      for (const b of qb) if (nb.has(b)) hit++;
      return { s, score: hit / qb.size };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

/** 闭嘴/张嘴：控制机器人整体是否说话（暂停/恢复），返回 'mute' | 'unmute' | null */
export function matchMuteCommand(text) {
  const t = String(text ?? '').trim().replace(/[。.!！~～\s]+$/g, '');
  if (!t || t.length > 12) return null;
  if (/^(?:闭嘴|闭麦|别说话|别说了|安静|安静点|别回了|停止回复|先别说话|不要说话|少说话)$/.test(t)) return 'mute';
  if (/^(?:张嘴|开麦|说话|可以说话|恢复说话|继续说话|别憋着|说句话|出来说话)$/.test(t)) return 'unmute';
  return null;
}
