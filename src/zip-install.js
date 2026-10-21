// zip 解压安装：把市场下载的安装包安全地落到 skills/ 或 plugins/ 目录。
//
// 独立成模块的原因：这段是"往磁盘写可执行 JS"的入口，安全边界必须集中、可单测。
// 与 server/community_app.py 的 validate_zip 规则对齐（那里上传时校验一次，
// 这里安装前再校验一次 —— 不信任任何传输环节）。
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const BANNED_EXT = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;

/**
 * 结构校验（抛错 = 拒绝安装）：
 *   · zip 中央目录里的每个条目：禁绝对路径/..、禁可执行后缀
 *   · 文件数与解压总量上限（zip 炸弹防护）
 * 返回 [{ name, data }]（仅文件条目，目录跳过）。
 */
export function validateZipStructure(buffer) {
  const entries = parseZip(buffer);
  if (entries.length > MAX_FILES) throw new Error(`文件数量过多（${entries.length} > ${MAX_FILES}）`);
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > MAX_TOTAL) throw new Error('解压后总大小超过 32MB');
  return entries;
}

const MANIFEST_RE = /(^|\/)(skill|plugin)\.json$/i;

/**
 * 读安装包里的清单（取层级最浅的那个），返回清单内容 + 它所在的目录前缀。
 *
 * 为什么要"最浅"：市场包至少有三种打法规格 ——
 *   · `<id>/skill.json`                （服务端标准包）
 *   · `skill.json`                     （直接压目录内容）
 *   · `<包名>/dist/skill.json`          （先 build 再打包；`dist` 不能被当成源码目录剥掉）
 * 只有把"清单所在目录"当作包根，装出来的目录根上才有清单，加载器才认得出这个扩展。
 * 否则会出现"提示安装成功、界面上却看不到"——目录装进去了，但清单在更深一层。
 */
export function readZipManifest(entries) {
  const cands = (entries || [])
    .map((e) => ({ ...e, depth: String(e.name).split('/').length }))
    .filter((e) => MANIFEST_RE.test(String(e.name)))
    .sort((a, b) => a.depth - b.depth);
  for (const c of cands) {
    try {
      const raw = JSON.parse(String(c.data.toString('utf8')).replace(/^\uFEFF/, ''));
      if (raw && typeof raw === 'object') {
        const idx = String(c.name).lastIndexOf('/');
        return { manifest: raw, file: c.name, prefix: idx === -1 ? '' : String(c.name).slice(0, idx + 1) };
      }
    } catch { /* 坏清单就找下一个 */ }
  }
  return null;
}

/**
 * 找出 skills/ 与 plugins/ 下所有"清单 id === id"的目录（含 `_1` `_2` 这种重复副本）。
 *
 * 安装器过去遇到同名目录就递增后缀，于是同一个扩展会攒出好几份副本：
 * 加载器按目录逐个加载、同 id 后者覆盖前者 —— 界面上永远只有一张卡片，
 * 用户看到"安装成功"却找不到新东西，磁盘上还多了一堆没人用的副本。
 */
// CP437 高半区（0x80–0xFF）。历史上有些解压路径把 UTF-8 字节按 CP437 解，
// 于是「安装与使用.txt」变成「σ«ëΦúàΣ╕ÄΣ╜┐τö¿.txt」；要还原就得按这张表反查字节。
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** 把"CP437 误解码"出来的名字还原成 UTF-8；不是这种形态就返回空串。 */
function fixCp437Mojibake(name) {
  const bytes = [];
  for (const ch of String(name)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { bytes.push(code); continue; }
    const idx = CP437_HIGH.indexOf(ch);
    if (idx < 0) return '';
    bytes.push(0x80 + idx);
  }
  try {
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes));
    return /[\u4e00-\u9fff]/.test(fixed) ? fixed : '';
  } catch {
    return '';
  }
}

/**
 * 修历史遗留的乱码文件名（GBK 名被当 UTF-8 解出来的产物，如 `σ«ëΦúàΣ╕ÄΣ╜┐τö¿.txt`）。
 * 只处理扩展目录下一层，幂等：修不了就跳过。
 */
export function repairMojibakeNames(root) {
  const fixed = [];
  for (const type of ['skills', 'plugins']) {
    const base = path.join(root, type);
    let dirs = [];
    try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const dirName of dirs) {
      const dir = path.join(base, dirName);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        const repaired = fixCp437Mojibake(name);
        if (!repaired || repaired === name) continue;
        try {
          fs.renameSync(path.join(dir, name), path.join(dir, repaired));
          fixed.push(`${type}/${dirName}/${name} → ${repaired}`);
        } catch { /* 目标已存在或权限问题，跳过 */ }
      }
    }
  }
  return fixed;
}

export function findModuleDirsById(root, id) {
  const want = String(id ?? '').trim();
  if (!want) return [];
  const out = [];
  for (const type of ['skills', 'plugins']) {
    const baseDir = path.join(root, type);
    let names = [];
    try {
      names = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { continue; }
    for (const name of names) {
      const dir = path.join(baseDir, name);
      let mid = '';
      for (const mf of ['skill.json', 'plugin.json']) {
        try {
          mid = String(JSON.parse(fs.readFileSync(path.join(dir, mf), 'utf8')).id || '');
          if (mid) break;
        } catch { /* 没有这个清单 */ }
      }
      if (mid === want) out.push({ type, name, dir });
    }
  }
  return out;
}

/**
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * 目录名规则（按优先级）：
 *   · 清单里的 id（最稳：与加载器认的 id 一致，重复安装会落到同一目录）
 *   · zip 里统一的根目录名
 *   · preferId（调用方告知的 id）
 *   · 兜底 'module'
 * 清单所在的层级会被剥掉（见 readZipManifest），保证**落地目录根上就是清单**。
 * 目录已存在且属于别的 id → 递增 _1/_2（两个不同扩展恰好同名目录，不能互相覆盖）。
 *
 * @returns {Promise<string>} 实际落地的目录名
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '' }) {
  const entries = validateZipStructure(buffer);
  if (!entries.length) throw new Error('安装包是空的');
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');
  const found = readZipManifest(entries);

  // 剥统一根目录：所有条目共享同一个第一段时去掉它。
  // 允许连续嵌套（常见于 GitHub「Download ZIP」后再打一层包）：
  //   reply-meme/reply-meme/skill.json → 剥两层 → skill.json
  // 遇到源码/资源目录名就停，避免把 lib/、src/ 当成包根。
  const STOP_SEG = new Set(['lib', 'src', 'assets', 'static', 'dist', 'node_modules']);
  const names = entries.map((e) => e.name);
  // ① 有清单：以"清单所在目录"为包根，只取这一层下的文件（覆盖 dist/ 这类布局）
  let cut = 0;                       // 要剥掉多少字符
  let picked = entries;
  if (found?.prefix) {
    cut = found.prefix.length;
    picked = entries.filter((e) => String(e.name).startsWith(found.prefix));
    if (!picked.length) throw new Error('安装包结构异常：清单所在目录为空');
  } else {
    // ② 没有清单：退回"剥统一根目录"，让加载器给出"缺少清单"的明确报错
    const firstSeg = names[0].split('/')[0];
    for (let round = 0; round < 3; round++) {
      const rest = names.map((n) => n.slice(cut));
      const seg = rest[0].split('/')[0];
      const uniform = seg && !STOP_SEG.has(seg.toLowerCase()) && rest.every((n) => n.startsWith(seg + '/'));
      if (!uniform) break;
      cut += seg.length + 1;
    }
  }
  const relNames = picked.map((e) => String(e.name).slice(cut));
  if (relNames.some((n) => !n)) throw new Error('安装包结构异常（剥掉根目录后有条目为空）');

  // 落地目录名：清单 id > zip 根目录名 > preferId > module
  const firstSeg = names[0].split('/')[0];
  const manifestId = String(found?.manifest?.id || '').trim();
  const zipRoot = found?.prefix ? found.prefix.split('/')[0] : (cut > 0 ? firstSeg : '');
  let dirName = manifestId || zipRoot || preferId || 'module';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(dirName)) dirName = preferId || 'module';
  // 冲突递增：走到这里说明磁盘上已有同名目录且不属于同一个 id
  // （同一个扩展的重装由调用方先删旧目录，不会到这里）
  let finalName = dirName;
  for (let n = 1; n <= 100; n++) {
    if (!fs.existsSync(path.join(baseDir, finalName))) break;
    finalName = `${dirName}_${n}`;
  }
  const target = path.join(baseDir, finalName);
  fs.mkdirSync(target, { recursive: true });

  for (let i = 0; i < picked.length; i++) {
    const rel = relNames[i];
    // 二次防线：拼接结果必须仍在 target 内（解析后 path.relative 检查）
    const dest = path.join(target, ...rel.split('/'));
    const relCheck = path.relative(target, dest);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`安装包包含非法路径：${picked[i].name}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, picked[i].data);
  }
  return finalName;
}

/** 极简 zip 读取器：中央目录定位 + 解压全部文件条目。不支持的特性直接抛错。 */
/**
 * 解 zip 条目名。
 *
 * zip 规范：通用标志位 bit 11 = 名字是 UTF-8；没置位时名字是"本地编码"。
 * Windows 上打的包（大量官网插件）用 GBK 写中文文件名 —— 直接按 utf8 解会变成
 * `σ«ëΦúàΣ╕ÄΣ╜┐τö¿.txt` 这种乱码目录，装上去没事但看着像坏包。
 * 这里先按 UTF-8 **严格**解，失败再按 GBK；两者都失败才退回宽松 UTF-8。
 */
function decodeZipName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');   // 明确声明 UTF-8
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
  }
}

function parseZip(buffer) {
  const sig = (off) => buffer.readUInt32LE(off);
  // 定位 EOCD（22 字节，从尾部向前扫，允许有注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (sig(ptr) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOff = buffer.readUInt32LE(ptr + 42);
    const name = decodeZipName(buffer.subarray(ptr + 46, ptr + 46 + nameLen), buffer.readUInt16LE(ptr + 8));

    // 目录条目（以 / 结尾）跳过
    if (!name.endsWith('/')) {
      // 本地头：定位到实际数据
      if (sig(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`不支持的压缩方式（method=${method}）：${name}`);
      out.push({ name: name.replace(/\\/g, '/'), data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  // 安全规则（与后端一致）
  for (const e of out) {
    const parts = e.name.split('/');
    if (e.name.startsWith('/') || parts.includes('..')) throw new Error(`安装包包含非法路径：${e.name}`);
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
  }
  return out;
}
