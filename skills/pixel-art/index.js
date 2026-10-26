// 像素画板（pixel-art）—— 16~64 像素的像素画，画完等比放大直接发到聊天里。
//
// ── 为什么 PNG 是手写编码的 ──────────────────────────────────────────────
// 这个装好的 App（resources/app/node_modules）里**没有** canvas / sharp / jimp /
// pngjs / pureimage 任何一个图形库（已逐个确认）。为了不引入需要联网安装、还要
// 重启的依赖，这里用 node:zlib 的 deflateSync + 自算 CRC32 手写了一个最小 PNG
// 编码器：16~64 像素的图极小，几十行就够，零依赖、无副作用、不会被沙箱拦。
//
// ── 三种画法，共用一套「逻辑像素 → 设备像素」管线 ────────────────────────
//   ① 模型手绘  draw_pixel_art 的 art 参数：字符网格
//        `.` 背景 / `0` 最暗 `1` 中间 `2` 最亮 / `k` `w` `r` `o` `y` `g` `c` `b` `p` `m` `e` `s`
//        语义化字符的好处：模型写 `rrrr` 就是红色，不用知道某套配色里红是第几号。
//   ② 程序化随机  random_pixel_art：对称精灵 / 万花筒花纹 / 宝石徽章 / 风景，四种风格
//       带 seed，同一颗种子画出同一张图，可以复现。
//   ③ 放大一律**最近邻整数倍**（不做双线性插值）——像素画一插值就糊，这是硬要求。
//
// ── 发送 ────────────────────────────────────────────────────────────────
//   一律走 ctx.sender.sendImage（队列 / 限频 / 去重 / 留档都在里面，见 skill-development.md §5.1），
//   绝不直连 onebot 的 send_* 接口。图片同时落盘到 <数据目录>/pixel-art/，
//   只留最近 keepFiles 张；本地路径发送失败时 sender 会自动回退 base64。
//
// ── 文档里的坑，这里逐条避开了 ──────────────────────────────────────────
//   · settings 里每个键都在 configSchema 里有声明（否则 UI 永远改不了）
//   · configSchema 的 enum 用 `values`（这个版本的 UI 渲染的是 d.values，
//     skill-reference.md §6 写的 options:[{value,label}] 在本版本不会渲染）
//   · 配置在执行时用 cfg() 现读，不在 setup 时快照
//   · 参数先校验，失败返回 {content, isError:true} 而不是抛错
//   · 工具 id 只用 [a-zA-Z0-9_-]，注册后由加载器加 `pixel-art__` 前缀
//   · 图片只发一次：既调用 sendImage 又返回 image_url parts 会发两张，这里只走前者
//   · 不导出 available()：没有外部依赖，永远可用

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** 构建标记：加载时打进日志，用来判断「改动到底生效没有」。 */
const BUILD_TAG = 'v1.0.0-handwritten-png';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// ─────────────────────────────────────────────────────────────────────────
// 一、PNG 编码器（零依赖）
// ─────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个 PNG 数据块：长度(4) + 类型(4) + 数据 + CRC(4)，CRC 覆盖「类型+数据」。 */
function pngChunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * RGBA 画布 → PNG buffer。
 * 每行从 None / Sub / Up 三种滤波器里挑「绝对值和最小」的那个（标准启发式）：
 * 像素画放大后存在大量连续相同的行与字节，这一步能把体积压掉一个数量级。
 */
function encodePng(canvas) {
  const { w, h, data } = canvas;
  const bpp = 4;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < h; y++) {
    const line = Buffer.from(data.buffer, data.byteOffset + y * stride, stride);

    const none = Buffer.from(line);
    const sub = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) sub[i] = (line[i] - (i >= bpp ? line[i - bpp] : 0)) & 0xff;
    const up = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) up[i] = (line[i] - prev[i]) & 0xff;

    let bestType = 0;
    let bestBuf = none;
    let bestScore = Infinity;
    for (const [type, buf] of [[0, none], [1, sub], [2, up]]) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const v = buf[i];
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        bestBuf = buf;
      }
    }

    const off = y * (stride + 1);
    raw[off] = bestType;
    bestBuf.copy(raw, off + 1);
    prev = line;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // 位深 8
  ihdr[9] = 6;  // 颜色类型 6 = 真彩 + alpha（RGBA）
  ihdr[10] = 0; // 压缩方法（只有 0）
  ihdr[11] = 0; // 滤波方法（只有 0）
  ihdr[12] = 0; // 不隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 魔数
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// 二、颜色与画布
// ─────────────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  // ⚠️ 必须严格校验：以前写成 parseInt(s.slice(...)) || 0，配色里少写一个键时
  // String(undefined) === 'undefined'，parseInt('de', 16) 会解析出 222，
  // 于是静默画出一个鬼颜色（实测出现过 #00de0f）。缺色一律给黑。
  const s = String(hex ?? '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [0, 0, 0];
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16)
  ];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}
const lighten = (rgb, t) => mix(rgb, [255, 255, 255], t);
const darken = (rgb, t) => mix(rgb, [0, 0, 0], t);

function makeCanvas(w, h) {
  // 全 0 = 透明。生成/手绘阶段允许留透明，发送前一律由 flattenBackground 落成实底。
  return { w, h, data: new Uint8Array(w * h * 4) };
}

function putPx(cv, x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  cv.data[i] = rgb[0];
  cv.data[i + 1] = rgb[1];
  cv.data[i + 2] = rgb[2];
  cv.data[i + 3] = a;
}

const luminance = (rgb) => rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;

/** 已绘制像素的平均亮度（透明像素不参与）。 */
function contentLuminance(cv) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < cv.data.length; i += 4) {
    if (cv.data[i + 3] === 0) continue;
    sum += cv.data[i] * 0.299 + cv.data[i + 1] * 0.587 + cv.data[i + 2] * 0.114;
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * 透明底已禁用：把所有透明像素换成不透明背景色，返回实际用的背景色。
 *
 * auto 的挑法分两步，保证「既好看又看得清」：
 *   ① 每套配色有自己写死的首选底色（PALETTES[x].bg）——多数配色用浅底，
 *      暗夜霓虹用暗底，gameboy 用经典亮绿屏。这是配色的设计意图，不该被亮度算出来。
 *   ② 只有当画面本身和首选底色太接近（亮度差 < MIN_GAP，会出现"白画白底"看不见）
 *      时，才翻到另一档。例如在糖果配色上画一个纯白方块 → 自动换成深底。
 */
function flattenBackground(cv, palName, mode) {
  const pal = paletteOf(palName);
  let bg;
  if (mode === 'white') {
    bg = hexToRgb('#ffffff');
  } else if (mode === 'black') {
    bg = hexToRgb('#000000');
  } else {
    // 太接近才算"看不清"：55 太严 —— gameboy 这类单色系配色的画面本来就跨整个明度范围，
    // 会被误判成"和亮底撞色"而翻成暗底，反而让深色描边糊进背景。
    const MIN_GAP = 28;
    const light = hexToRgb(pal['2']);
    const dark = hexToRgb(pal['0']);
    const preferDark = pal.bg === '0';
    const preferred = preferDark ? dark : light;
    const fallback = preferDark ? light : dark;
    bg = Math.abs(contentLuminance(cv) - luminance(preferred)) >= MIN_GAP ? preferred : fallback;
  }
  for (let i = 0; i < cv.data.length; i += 4) {
    if (cv.data[i + 3] !== 0) continue;
    cv.data[i] = bg[0];
    cv.data[i + 1] = bg[1];
    cv.data[i + 2] = bg[2];
    cv.data[i + 3] = 255;
  }
  return bg;
}

/** 最近邻整数倍放大——像素画唯一的正确放大方式。 */
function upscale(src, k) {
  if (k <= 1) return src;
  const out = makeCanvas(src.w * k, src.h * k);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      for (let dy = 0; dy < k; dy++) {
        const rowOff = (y * k + dy) * out.w;
        for (let dx = 0; dx < k; dx++) {
          const j = (rowOff + x * k + dx) * 4;
          out.data[j] = src.data[i];
          out.data[j + 1] = src.data[i + 1];
          out.data[j + 2] = src.data[i + 2];
          out.data[j + 3] = src.data[i + 3];
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 三、配色方案
//   每个方案都提供同一套 15 个语义字符，所以模型写 `r` 永远是「这套配色里的红」。
//   0/1/2 是这套配色的暗 / 中 / 亮三档中性色，用来画描边和明暗。
// ─────────────────────────────────────────────────────────────────────────

const PALETTES = {
  cute: {
    label: '糖果',
    bg: '2',
    '0': '#4a3f5c', '1': '#9a8fb0', '2': '#ece7f5',
    k: '#3b2f4a', w: '#fffdf7', r: '#ff6b81', o: '#ffa45b', y: '#ffe066', g: '#7bd88f',
    c: '#5ed3e8', b: '#6c8cff', p: '#b48cff', m: '#ff8cc8', e: '#ffd9b3', s: '#c9c2d6'
  },
  retro: {
    label: '红白机',
    bg: '2',
    '0': '#181818', '1': '#7c7c7c', '2': '#d8d8d8',
    k: '#000000', w: '#fcfcfc', r: '#d82800', o: '#e45c10', y: '#f8b800', g: '#00a800',
    c: '#3cbcfc', b: '#0058f8', p: '#6844fc', m: '#f878f8', e: '#fcb088', s: '#bcbcbc'
  },
  gameboy: {
    label: '四色绿',
    bg: '2',   // 经典 Game Boy 是亮绿屏配深绿图像；用暗底会让描边糊进背景
    '0': '#0f380f', '1': '#306230', '2': '#9bbc0f',
    k: '#0f380f', w: '#9bbc0f', r: '#306230', o: '#306230', y: '#8bac0f', g: '#306230',
    c: '#8bac0f', b: '#306230', p: '#306230', m: '#8bac0f', e: '#8bac0f', s: '#306230'
  },
  pastel: {
    label: '柔和',
    bg: '2',
    '0': '#6b6a7a', '1': '#b6b4c4', '2': '#f2f0f7',
    k: '#4d4a5a', w: '#ffffff', r: '#f2a0a8', o: '#f5c396', y: '#f5e2a0', g: '#a8d8b0',
    c: '#a8d8e0', b: '#a8bce8', p: '#c8b0e8', m: '#f0b0d8', e: '#f5d8c0', s: '#cfcbd8'
  },
  vivid: {
    label: '高饱和',
    bg: '2',
    '0': '#241b3a', '1': '#6b5a99', '2': '#d9d2f0',
    k: '#101018', w: '#ffffff', r: '#ff2d55', o: '#ff8c00', y: '#ffd400', g: '#22c55e',
    c: '#06b6d4', b: '#2563eb', p: '#8b5cf6', m: '#ec4899', e: '#f0b27a', s: '#94a3b8'
  },
  night: {
    label: '暗夜霓虹',
    bg: '0',   // 霓虹配色天生是暗底亮画
    '0': '#0b0f1e', '1': '#2a3557', '2': '#7f8fc4',
    k: '#05070f', w: '#eaf2ff', r: '#ff4d6d', o: '#ff9f45', y: '#ffe066', g: '#3ddc84',
    c: '#35d6f0', b: '#4d7cff', p: '#a26bff', m: '#ff6ec7', e: '#e0a878', s: '#6b7a99'
  }
};

const PALETTE_NAMES = Object.keys(PALETTES);
const ACCENTS = ['r', 'o', 'y', 'g', 'c', 'b', 'p', 'm'];
const ART_CHARS = ['0', '1', '2', 'k', 'w', 'r', 'o', 'y', 'g', 'c', 'b', 'p', 'm', 'e', 's'];
const CHAR_HELP = '. 背景 / 0 最暗 / 1 中间 / 2 最亮 / k 黑 / w 白 / r 红 / o 橙 / y 黄 / g 绿 / c 青 / b 蓝 / p 紫 / m 粉 / e 肤色 / s 灰';

const ART_MIN = 16;
const ART_MAX = 64;
const BG_MODES = ['auto', 'white', 'black'];

function paletteOf(name) {
  return PALETTES[name] ?? PALETTES.cute;
}
function paletteLabel(name) {
  return paletteOf(name).label;
}

// ─────────────────────────────────────────────────────────────────────────
// 四、随机数：让「同一颗种子 = 同一张图」
// ─────────────────────────────────────────────────────────────────────────

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 五、程序化生成器（都画在 n×n 的逻辑画布上，未填部分留透明、发送前统一落成实底）
// ─────────────────────────────────────────────────────────────────────────

/** 左右镜像的对称小生物：几个椭圆叠出剪影，再补描边和明暗，最后点两只眼睛。 */
function genSprite(n, rng, pal) {
  const cv = makeCanvas(n, n);
  const body = hexToRgb(pal[ACCENTS[Math.floor(rng() * ACCENTS.length)]]);
  const outline = darken(body, 0.62);
  const bodyLight = lighten(body, 0.3);
  const bodyDark = darken(body, 0.28);
  const eyeColor = darken(body, 0.78);

  const half = Math.ceil(n / 2);
  const mask = new Uint8Array(n * n);

  const blobs = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < blobs; i++) {
    const cx = half * (0.4 + rng() * 0.55);
    const cy = n * (0.28 + rng() * 0.44);
    const rx = Math.max(2, n * (0.15 + rng() * 0.15));
    const ry = Math.max(2, n * (0.17 + rng() * 0.18));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < half; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const q = dx * dx + dy * dy;
        if (q <= 1 && (1 - q > 0.15 || rng() < 0.8)) mask[y * n + x] = 1;
      }
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < half; x++) mask[y * n + (n - 1 - x)] = mask[y * n + x];
  }

  let any = false;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { any = true; break; }
  if (!any) {
    // 兜底：绝不返回一张空白图
    const lo = Math.floor(n * 0.3);
    const hi = Math.ceil(n * 0.7);
    for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) mask[y * n + x] = 1;
  }

  let top = n;
  let bot = -1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (mask[y * n + x]) {
        if (y < top) top = y;
        if (y > bot) bot = y;
      }
    }
  }
  const band = Math.max(1, bot - top);

  const border = new Uint8Array(n * n);
  // 纵向明暗分 4 档（而不是 3 档）：像素画本来就靠有限色阶表现体积，
  // 档数太少会看出生硬的色带边界，太多又会糊成不是像素画。
  const LEVELS = 4;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!mask[y * n + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n || !mask[ny * n + nx]) {
          border[y * n + x] = 1;
          break;
        }
      }
      let rgb;
      if (border[y * n + x]) {
        rgb = outline;
      } else {
        const t = (y - top) / band;
        const level = Math.max(0, Math.min(LEVELS - 1, Math.floor(t * LEVELS)));
        rgb = mix(bodyLight, bodyDark, level / (LEVELS - 1));
      }
      putPx(cv, x, y, rgb, 255);
    }
  }

  // 两只眼睛：左右对称、必须落在实心内部（不是描边像素），大小随画布放大
  const eyeSize = Math.max(1, Math.min(3, Math.round(n / 16)));
  const eyeY = Math.min(n - 1 - eyeSize, Math.round(top + band * 0.35));
  const off = Math.max(1, Math.round(n * 0.14));
  const eyeXs = [Math.floor(n / 2) - off, n - 1 - (Math.floor(n / 2) - off)];
  for (const ex of eyeXs) {
    for (let dy = 0; dy < eyeSize; dy++) {
      for (let dx = 0; dx < eyeSize; dx++) {
        const x = ex + dx;
        const y = eyeY + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (!mask[y * n + x] || border[y * n + x]) continue;
        putPx(cv, x, y, eyeColor, 255);
      }
    }
  }
  return cv;
}

/** 万花筒花纹：四分之一区域随机上色后镜像到四个角，中心再压一枚徽记。 */
function genPattern(n, rng, pal) {
  const cv = makeCanvas(n, n);
  const accents = ACCENTS.map((ch) => hexToRgb(pal[ch]));
  const q = Math.ceil(n / 2);
  const c = (n - 1) / 2;
  const medal = accents[Math.floor(rng() * accents.length)];
  const md = n * 0.22;

  for (let y = 0; y < q; y++) {
    for (let x = 0; x < q; x++) {
      const d = Math.abs(x - c) + Math.abs(y - c);
      let rgb = null;
      if (d <= md) {
        const t = d / Math.max(1, md);
        rgb = t < 0.4 ? lighten(medal, 0.4) : t < 0.75 ? medal : darken(medal, 0.35);
      } else if (rng() < 0.42) {
        rgb = accents[Math.floor(rng() * accents.length)];
        if (rng() < 0.25) rgb = darken(rgb, 0.28);
      } else if (rng() < 0.12) {
        rgb = hexToRgb(pal['1']);
      }
      if (!rgb) continue;
      putPx(cv, x, y, rgb, 255);
      putPx(cv, n - 1 - x, y, rgb, 255);
      putPx(cv, x, n - 1 - y, rgb, 255);
      putPx(cv, n - 1 - x, n - 1 - y, rgb, 255);
    }
  }
  return cv;
}

/** 宝石徽章：中心亮、边缘暗的同心环，左上补高光、右下压阴影，最外圈描边。 */
function genBadge(n, rng, pal) {
  const cv = makeCanvas(n, n);
  const base = hexToRgb(pal[ACCENTS[Math.floor(rng() * ACCENTS.length)]]);
  const ramp = [darken(base, 0.5), darken(base, 0.28), base, lighten(base, 0.22), lighten(base, 0.45)];
  const outline = darken(base, 0.66);
  const c = (n - 1) / 2;
  const R = n * 0.44;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = Math.abs(x - c);
      const dy = Math.abs(y - c);
      const d = Math.max(dx, dy) * 0.68 + (dx + dy) * 0.32;
      if (d > R + 1.1) continue;
      if (d > R) {
        putPx(cv, x, y, outline, 255);
        continue;
      }
      const t = d / R;
      let idx = Math.round((1 - t) * (ramp.length - 1));
      if (x < c && y < c && (c - x) + (c - y) < R * 0.6) idx += 1;
      if (x > c && y > c && (x - c) + (y - c) < R * 0.6) idx -= 1;
      putPx(cv, x, y, ramp[Math.max(0, Math.min(ramp.length - 1, idx))], 255);
    }
  }
  return cv;
}

/** 风景：天空渐变 + 太阳或月亮和星星 + 一条随机起伏的山脊线。 */
function genLandscape(n, rng, pal) {
  const cv = makeCanvas(n, n);
  const sky = hexToRgb(pal.b);
  const skyTop = darken(sky, 0.4);
  const skyBottom = lighten(sky, 0.5);
  const horizon = Math.max(3, Math.floor(n * (0.6 + rng() * 0.1)));

  for (let y = 0; y < horizon; y++) {
    const t = horizon <= 1 ? 1 : y / (horizon - 1);
    const rgb = mix(skyTop, skyBottom, t);
    for (let x = 0; x < n; x++) putPx(cv, x, y, rgb, 255);
  }

  const isNight = rng() < 0.35;
  const cx = Math.round(n * (0.25 + rng() * 0.5));
  const cy = Math.round(horizon * (0.25 + rng() * 0.25));
  const R = Math.max(1.5, n * 0.11);
  const orb = isNight ? hexToRgb(pal.w) : hexToRgb(pal.y);
  for (let y = 0; y < horizon; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= R) putPx(cv, x, y, orb, 255);
      else if (d <= R + 2.2) putPx(cv, x, y, lighten(orb, 0.55), 255);
    }
  }
  if (isNight) {
    const stars = 3 + Math.floor(rng() * 6);
    for (let i = 0; i < stars; i++) {
      putPx(cv, Math.floor(rng() * n), Math.floor(rng() * Math.max(1, horizon - 1)), hexToRgb(pal.w), 255);
    }
  }

  const ground = darken(hexToRgb(pal.g), 0.45);
  let level = horizon - Math.round(n * (0.12 + rng() * 0.15));
  const minLevel = Math.max(1, Math.round(horizon * 0.25));
  const maxLevel = Math.max(minLevel + 1, horizon - 1);
  for (let x = 0; x < n; x++) {
    level += Math.round((rng() - 0.5) * Math.max(1, n * 0.12));
    level = Math.max(minLevel, Math.min(maxLevel, level));
    for (let y = level; y < n; y++) {
      let rgb = ground;
      if (y === level) rgb = lighten(ground, 0.32);
      else if (y < level + 2) rgb = lighten(ground, 0.12);
      else if (y > n * 0.86) rgb = darken(ground, 0.32);
      putPx(cv, x, y, rgb, 255);
    }
  }
  return cv;
}

const STYLES = ['sprite', 'pattern', 'badge', 'landscape'];

function randomLogical(size, style, paletteName, rng) {
  const palName = paletteName === 'auto' ? PALETTE_NAMES[Math.floor(rng() * PALETTE_NAMES.length)] : paletteName;
  const pal = paletteOf(palName);
  const st = !style || style === 'random' ? STYLES[Math.floor(rng() * STYLES.length)] : style;
  let canvas;
  if (st === 'pattern') canvas = genPattern(size, rng, pal);
  else if (st === 'badge') canvas = genBadge(size, rng, pal);
  else if (st === 'landscape') canvas = genLandscape(size, rng, pal);
  else canvas = genSprite(size, rng, pal);
  return { canvas, palette: palName, style: st };
}

// ─────────────────────────────────────────────────────────────────────────
// 六、手绘字符网格 → 画布
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把模型给的 art 归一成字符串数组。
 * 宽容处理：接受字符串数组，也接受用换行或 `/` 分隔的单个字符串；
 * 去掉空行和行内空白（空着的格子请写 `.`，不要写空格；`.` 会被填成不透明背景色）。
 * 返回 null 表示没给画稿（改走随机生成）。
 */
function normalizeArt(raw) {
  if (raw == null) return null;
  let rows;
  if (Array.isArray(raw)) {
    rows = raw.map((r) => String(r ?? '').replace(/\s+/g, ''));
  } else if (typeof raw === 'string') {
    rows = raw.replace(/\r/g, '').split(/[\n|/]+/).map((r) => r.replace(/\s+/g, ''));
  } else {
    throw new Error(`art 必须是字符串数组（每个字符串是一行像素），收到的是 ${typeof raw}`);
  }
  while (rows.length && rows[0] === '') rows.shift();
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  if (!rows.length) return null;
  return rows;
}

function validateArt(rows) {
  const h = rows.length;
  const w = rows[0].length;
  if (h < ART_MIN || h > ART_MAX) {
    throw new Error(`art 有 ${h} 行，必须在 ${ART_MIN}~${ART_MAX} 行之间`);
  }
  if (w < ART_MIN || w > ART_MAX) {
    throw new Error(`art 每行 ${w} 个字符，每行长度必须在 ${ART_MIN}~${ART_MAX} 之间`);
  }
  const badRow = rows.findIndex((r) => r.length !== w);
  if (badRow >= 0) {
    // 正常情况下 alignRowWidths 已经把宽度对齐了，走到这里说明调用顺序错了
    throw new Error(`art 第 ${badRow + 1} 行有 ${rows[badRow].length} 个字符，和第一行的 ${w} 个不一致——每一行长度必须相同`);
  }
  // 非法字符一次性报全（最多 6 处）：只报第一个的话，模型改完这处又会在下一处再失败一轮
  const bad = [];
  for (let y = 0; y < h && bad.length < 6; y++) {
    for (let x = 0; x < w && bad.length < 6; x++) {
      const ch = rows[y][x];
      if (ch === '.' || ART_CHARS.includes(ch)) continue;
      bad.push(`第 ${y + 1} 行第 ${x + 1} 个「${ch}」`);
    }
  }
  if (bad.length) {
    throw new Error(`art 里有不认识的字符：${bad.join('、')}${bad.length >= 6 ? ' 等' : ''}。可用字符：${CHAR_HELP}`);
  }
}

/**
 * 把每行的字符数对齐到「多数行的宽度」。
 *
 * 为什么需要这一步 —— 这是真实发生过的故障，不是假想：
 *   模型排一个菱形时会顺手把中间几行多写一个字符（想把形状撑宽），
 *   于是出现 16/17/18 混排。原先直接报错让它重试，实测连续两次都没修好
 *   （第一次第 5 行 17 个、第二次第 10 行 15 个），用户看到的就是「失败了」，
 *   而且报错一次只指出一行，改完这行又错另一行。
 *
 * 现在改成自动对齐：能救的就别失败，同时把「改了什么」写进返回文本让模型知道。
 *   · 目标宽度 = 出现次数最多的行宽（并列时取第一行的宽度，即模型声明的意图）
 *   · 偏短的行：右侧补 `.`（背景）
 *   · 偏长的行：从「填充字符更多」的那一侧裁掉，尽量让图案保持居中
 */
function alignRowWidths(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.length, (counts.get(r.length) || 0) + 1);
  // 初始取第一行的宽度；只在「严格更多」时才换 —— 并列自然保住第一行的宽度
  let width = rows[0].length;
  let best = counts.get(width) || 0;
  for (const [w, n] of counts) {
    if (n > best) {
      best = n;
      width = w;
    }
  }

  const repairs = [];
  const fixed = rows.map((r, i) => {
    if (r.length === width) return r;
    const from = r.length;
    if (r.length < width) {
      repairs.push({ row: i + 1, from, to: width, how: '补背景' });
      return r + '.'.repeat(width - r.length);
    }
    let s = r;
    while (s.length > width) {
      const leftPad = (s.match(/^\.*/) || [''])[0].length;
      const rightPad = (s.match(/\.*$/) || [''])[0].length;
      s = rightPad >= leftPad ? s.slice(0, -1) : s.slice(1);
    }
    repairs.push({ row: i + 1, from, to: width, how: '裁掉多余' });
    return s;
  });
  return { rows: fixed, width, repairs };
}

/** 把自动对齐的结果写成一句人话（连续且同源宽度的行合并成区间）。 */
function describeRepairs(repairs, width) {
  const parts = [];
  let i = 0;
  while (i < repairs.length) {
    let j = i;
    while (
      j + 1 < repairs.length
      && repairs[j + 1].row === repairs[j].row + 1
      && repairs[j + 1].from === repairs[i].from
      && repairs[j + 1].to === repairs[i].to
    ) j++;
    const a = repairs[i];
    const b = repairs[j];
    const range = a.row === b.row ? `第 ${a.row} 行` : `第 ${a.row}~${b.row} 行`;
    parts.push(`${range} ${a.from}→${a.to} 个字符`);
    i = j + 1;
  }
  return `各行字符数不一致，已自动按多数行的宽度 ${width} 对齐（${parts.join('，')}）`;
}

function artToCanvas(rows, paletteName) {
  const pal = paletteOf(paletteName);
  const h = rows.length;
  const w = rows[0].length;
  const cv = makeCanvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      if (ch === '.') continue;
      putPx(cv, x, y, hexToRgb(pal[ch]), 255);
    }
  }
  return cv;
}

// ─────────────────────────────────────────────────────────────────────────
// 七、落盘（本地留档）＋ 发送
// ─────────────────────────────────────────────────────────────────────────

let artDirPromise = null;

/** 数据目录可能是 安装目录/data、项目/data、data-2（多开）或 QQ_AGENT_DATA_DIR ——
 *  自己拼路径必然漏掉某一种，所以问本体模块要（和 skills/image-delegate 同一套做法）。 */
function artDir() {
  if (!artDirPromise) {
    artDirPromise = (async () => {
      try {
        const mod = await import('../../src/config.js');
        if (mod?.DATA_DIR) return path.join(mod.DATA_DIR, 'pixel-art');
      } catch (error) {
        warn(`取数据目录失败，改用系统临时目录：${error?.message ?? error}`);
      }
      return path.join(os.tmpdir(), 'qq-agent-pixel-art');
    })();
  }
  return artDirPromise;
}

function pruneOldFiles(dir, keep) {
  if (!(keep > 0)) return;
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(f.full); } catch { /* 删不掉就算了，不影响画图 */ }
    }
  } catch { /* 目录不可读时静默跳过 */ }
}

async function savePng(png, keepFiles) {
  const dir = await artDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rnd = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const file = path.join(dir, `pixel-${stamp}-${rnd}.png`);
  fs.writeFileSync(file, png);
  pruneOldFiles(dir, keepFiles);
  return file;
}

/** 逻辑画布 → 等比放大 → PNG → 落盘 → 用 ctx.sender 发出去（只发一次）。 */
async function renderAndSend(ctx, logical, meta) {
  const c = cfg();
  const target = clampInt(c.displayPixels, 64, 1024, 384);
  const maxK = clampInt(c.maxUpscale, 1, 64, 32);
  const k = clampInt(Math.round(target / Math.max(logical.w, logical.h)), 1, maxK);
  // 透明底已禁用：放大之前先把透明像素落成不透明背景（像素少，更快），
  // 放大的是已经"合层"的结果，所以输出绝不会有透明像素。
  const bg = flattenBackground(logical, meta.palette, resolveBgMode(c.background));
  const device = upscale(logical, k);
  const png = encodePng(device);
  const bgHex = `#${[bg[0], bg[1], bg[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  if (!ctx?.sender?.sendImage) {
    return { content: '当前上下文没有发送器（ctx.sender），无法把图片发出去。', isError: true };
  }
  if (!ctx?.chatKey) {
    return { content: '当前上下文缺少 chatKey，无法确定发到哪个会话。', isError: true };
  }

  let file = '';
  try {
    file = await savePng(png, clampInt(c.keepFiles, 0, 9999, 30));
  } catch (error) {
    warn(`图片落盘失败（不影响发送）：${error?.message ?? error}`);
  }

  // file 走本地路径（协议端自己读盘，body 只有几十字节）；dataUrl 作为回退，
  // sender 内部在 file:// 失败时会自动改用 base64 重试一次。
  const img = { dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  if (file) img.file = file;

  const caption = String(meta.subject || '像素画').slice(0, 40);
  try {
    await ctx.sender.sendImage(ctx.chatKey, img, { note: caption });
  } catch (error) {
    const where = file ? `图片已经画好并存在本地：${file}` : '图片已经画好但没能在本地留档';
    return { content: `像素画生成成功，但发送失败：${error?.message ?? error}。${where}`, isError: true };
  }

  if (c.announce) {
    try {
      await ctx.sender.sendTextBatch(ctx.chatKey, [
        `🖼️ 像素画 ${logical.w}×${logical.h} · ${paletteLabel(meta.palette)}配色 · 放大 ${k} 倍 · 背景 ${bgHex}`
      ]);
    } catch (error) {
      warn(`尺寸说明发送失败：${error?.message ?? error}`);
    }
  }

  const how = meta.mode === 'hand'
    ? '你排的像素'
    : `随机生成的${styleLabel(meta.style)}`;
  return {
    content:
      `像素画已经画好并直接发到聊天里了：${logical.w}×${logical.h} 逻辑像素（${how}，${paletteLabel(meta.palette)}配色），`
      + `按 ${k} 倍最近邻等比放大成 ${device.w}×${device.h} 的 PNG。`
      + `背景是不透明的 ${bgHex}（透明底已全局禁用），画面里没有透明像素。`
      // 自动对齐过的必须明说：一是让模型知道自己这轮写错了，
      // 二是万一形状被裁歪了，它能据此决定要不要重画一张。
      + (meta.repairNote ? `⚠️ ${meta.repairNote}，图已按对齐结果画出。下次排像素请保证每一行字符数完全相同（排完逐行数一遍）。` : '')
      + `图片由工具发出，不要再重复发一遍，也不要复述尺寸和配色——想说什么就着画面聊一句。`
  };
}

function styleLabel(style) {
  return { sprite: '对称精灵', pattern: '万花筒花纹', badge: '宝石徽章', landscape: '风景' }[style] || style || '';
}

// ─────────────────────────────────────────────────────────────────────────
// 八、小工具
// ─────────────────────────────────────────────────────────────────────────

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function resolvePalette(requested, fallbackSetting) {
  const want = String(requested ?? '').trim().toLowerCase();
  if (want && want !== 'auto' && PALETTES[want]) return want;
  if (want === 'auto') return 'auto';
  const setting = String(fallbackSetting ?? '').trim().toLowerCase();
  if (setting === 'auto') return 'auto';
  return PALETTES[setting] ? setting : 'auto';
}

/** 背景模式：自动 / 纯白 / 纯黑。配置里写了别的值一律回退到 auto。 */
function resolveBgMode(v) {
  const want = String(v ?? '').trim().toLowerCase();
  return BG_MODES.includes(want) ? want : 'auto';
}

// ─────────────────────────────────────────────────────────────────────────
// 九、工具注册
// ─────────────────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  log(`像素画板已加载（${BUILD_TAG}）：手写 PNG 编码器，零外部依赖`);

  // 加载时自检：每套配色必须 15 个语义字符齐全。
  // 少一个键不会报错，只会把那格画成黑色（hexToRgb 的兜底），属于典型静默失效 ——
  // 所以在加载阶段就把它喊出来，而不是等用户发现图上有黑块。
  for (const [name, pal] of Object.entries(PALETTES)) {
    const bad = ART_CHARS.filter((ch) => !/^#[0-9a-fA-F]{6}$/.test(String(pal[ch] ?? '')));
    if (bad.length) warn(`配色 ${name} 缺字符「${bad.join('')}」（会画成黑色），请检查 PALETTES 定义`);
    if (pal.bg !== '0' && pal.bg !== '2') warn(`配色 ${name} 的首选底色 bg 非法（${pal.bg}），按浅底处理`);
  }

  // 每个工具都用一份全新的 schema 对象，避免共用同一个引用被上游改写
  const paletteParam = () => ({
    type: 'string',
    enum: ['auto', ...PALETTE_NAMES],
    description: '配色方案，不填用设置里的默认值。auto=默认（手绘时用糖果配色保证颜色忠实；随机生成时每次换一套）；cute 糖果；retro 红白机；gameboy 四色绿；pastel 柔和；vivid 高饱和；night 暗夜霓虹。'
  });

  // ── 工具 1：描述式绘制（模型自己排像素） ──────────────────────────────
  api.registerTool({
    id: 'draw_pixel_art',
    name: '画像素画',
    description:
      '把一张 16~64 像素的像素画渲染成 PNG 并发到当前会话。当群友说「画个像素画」「来个像素爱心/笑脸/星星/小房子」时使用。'
      + '用法：把画面拆成字符网格填进 art —— 每个字符串是一行像素（从上到下），'
      + `每个字符是一格：${CHAR_HELP}。`
      + `例如 16×16 的红色爱心就是 16 个长度 16 的字符串，红的地方写 r，其余写 . 。`
      + `art 最少 ${ART_MIN} 行、最多 ${ART_MAX} 行。`
      + '⚠️ 每一行的字符数必须完全相同——这是最容易翻车的地方（16 行的图就每行都必须正好 16 个字符，'
      + '排完请逐行数一遍再提交）。万一不一致，工具会按多数行的宽度自动补齐/裁掉并告诉你改了哪些行，'
      + '不会直接失败，但裁过的形状可能歪一格。'
      + '输出的 PNG 一律是不透明底（没有透明像素），`.` 会被填成背景色。'
      + '不想自己排像素、或只是要一张随机像素图时，改用 random_pixel_art。'
      + '图片会由工具直接发出去。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: '画的是什么，用来当配图说明，如「红色爱心」「微笑的小猫」。'
        },
        art: {
          type: 'array',
          items: { type: 'string' },
          description:
            '像素画本身：字符串数组，每个字符串是一行（从上到下），每个字符是一格。'
            + `${CHAR_HELP}。最少 ${ART_MIN} 行、最多 ${ART_MAX} 行。`
            + '⚠️ 每一行的字符数必须**完全相同**（这是最容易出错的地方，排完请逐行数一遍）；'
            + '万一不一致，工具会按多数行的宽度自动补齐/裁掉，并在返回里告诉你改了哪些行。'
            + '空着的格子写 `.`，它会被填成不透明背景色（输出没有透明像素）。不想自己排就留空，工具会改成随机生成。'
        },
        size: {
          type: 'integer',
          description: `只有在你没填 art（走随机生成）时才起作用：画布边长，${ART_MIN}~${ART_MAX}。不确定就别填，用默认值。`
        },
        palette: paletteParam()
      },
      required: ['subject']
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const subject = String(args?.subject ?? '').trim() || '像素画';
        let palette = resolvePalette(args?.palette, c.defaultPalette);
        const rows = normalizeArt(args?.art);

        let logical;
        let mode;
        let style = '';
        let repairNote = '';
        if (rows) {
          // 先把各行字符数对齐（模型排像素最常犯的错），再校验剩下的硬约束
          const aligned = alignRowWidths(rows);
          validateArt(aligned.rows);
          if (aligned.repairs.length) {
            repairNote = describeRepairs(aligned.repairs, aligned.width);
            log(`像素画：${repairNote}`);
          }
          // 手绘是「有意图」的画：说要红爱心就该是红的。
          // 所以手绘时 auto 固定用糖果配色（各色相都忠实），
          // 不能按 subject 哈希随机 —— 那样「红色爱心」有 1/6 概率变成四色绿。
          // 换配色的乐趣留给 random_pixel_art（那里 auto 才是每次随机挑一套）。
          if (palette === 'auto') palette = 'cute';
          logical = artToCanvas(aligned.rows, palette);
          // 全是 `.` 的画不可能是本意，明确报错而不是发一张纯色底图
          let drawn = 0;
          for (let i = 3; i < logical.data.length; i += 4) if (logical.data[i] !== 0) drawn++;
          if (!drawn) {
            return { content: `art 里全是「.」，等于什么都没画。请至少填一些颜色字符：${CHAR_HELP}`, isError: true };
          }
          mode = 'hand';
        } else {
          const size = clampInt(args?.size, ART_MIN, ART_MAX, clampInt(c.defaultSize, ART_MIN, ART_MAX, 32));
          const seed = (hashSeed(subject) ^ (Date.now() & 0xffffffff)) >>> 0;
          const gen = randomLogical(size, 'random', palette, mulberry32(seed));
          logical = gen.canvas;
          palette = gen.palette;
          style = gen.style;
          mode = 'random';
        }

        return await renderAndSend(ctx, logical, { subject, palette, mode, style, repairNote });
      } catch (error) {
        return { content: `像素画没画成：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 2：随机生成（说不出画什么时的兜底） ──────────────────────────
  api.registerTool({
    id: 'random_pixel_art',
    name: '随机像素画',
    description:
      '随机生成一张对称的像素画（对称精灵 / 万花筒花纹 / 宝石徽章 / 风景）并发到当前会话。'
      + '当群友说「随机来张像素画」「随便画个像素头像」「来张像素图」但没说要画什么时使用；'
      + '也可以用来给 draw_pixel_art 兜底。同一颗 seed 能画出完全一样的一张图。'
      + '输出的 PNG 一律是不透明底（没有透明像素）。'
      + '图片会由工具直接发出去。',
    category: 'media',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          enum: ['random', ...STYLES],
          description: '风格：random 随机挑一种（默认）；sprite 左右对称的小生物；pattern 万花筒花纹；badge 宝石徽章；landscape 风景。'
        },
        size: {
          type: 'integer',
          description: `画布边长（逻辑像素），${ART_MIN}~${ART_MAX}。不填用设置里的默认值；不确定就让用户自己说大小。`
        },
        palette: paletteParam(),
        subject: {
          type: 'string',
          description: '可选。给这张图的说明文字，如「像素小猫」。'
        },
        seed: {
          type: 'integer',
          description: '可选。同一颗种子永远画出同一张图；想让群友「再来一张一样的」时用上次返回的种子。不填则每次都不一样。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const subject = String(args?.subject ?? '').trim() || '随机像素画';
        const size = clampInt(args?.size, ART_MIN, ART_MAX, clampInt(c.defaultSize, ART_MIN, ART_MAX, 32));
        const palette = resolvePalette(args?.palette, c.defaultPalette);
        const askedSeed = Number(args?.seed);
        const seed = Number.isFinite(askedSeed) && askedSeed !== 0
          ? (Math.abs(Math.trunc(askedSeed)) >>> 0)
          : ((hashSeed(subject) ^ (Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
        const wanted = String(args?.style ?? 'random').trim().toLowerCase();
        const style = STYLES.includes(wanted) ? wanted : 'random';

        const gen = randomLogical(size, style, palette, mulberry32(seed));
        const result = await renderAndSend(ctx, gen.canvas, {
          subject,
          palette: gen.palette,
          mode: 'random',
          style: gen.style
        });
        if (result.isError) return result;
        return {
          content: `${result.content} 这次的风格是「${styleLabel(gen.style)}」，种子 ${seed} —— 群友想再来一张一样的，就把 seed 填 ${seed}。`
        };
      } catch (error) {
        return { content: `像素画没画成：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export function dispose() {
  // 没有定时器 / 监听器 / 长连接，无需清理。
}

// 给自测用：不经过加载器也能直接验证编码器和生成器。
export const __test__ = {
  encodePng,
  makeCanvas,
  putPx,
  upscale,
  hexToRgb,
  PALETTES,
  PALETTE_NAMES,
  STYLES,
  ART_CHARS,
  ART_MIN,
  ART_MAX,
  hashSeed,
  mulberry32,
  normalizeArt,
  validateArt,
  alignRowWidths,
  describeRepairs,
  artToCanvas,
  randomLogical,
  flattenBackground,
  contentLuminance,
  resolveBgMode,
  BG_MODES,
  genSprite,
  genPattern,
  genBadge,
  genLandscape
};
