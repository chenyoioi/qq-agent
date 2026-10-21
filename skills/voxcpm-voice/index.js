// voxcpm-voice —— 用小鲸鱼参考音频做 VoxCPM2 音色克隆，把文字念成语音发到当前会话。
//
// 为什么是「技能」（skills/）而不是「插件」（plugins/）：
//   插件只能提供 capabilities / hooks，而钩子被硬性限制为「5 秒超时、不得有副作用、
//   不得发消息、不得发请求」（skill-reference.md §9.3 / §9.4）。本功能必须「联网合成
//   （3~10 秒，Space 冷启动更久）+ 发送语音消息」，两条都踩在钩子禁令上，
//   所以唯一可行的执行路径是注册工具 —— 也就是 LLM 型技能。
//   参见 plugin-development.md 文首「一个提前判断」与 §2 表格最后一行。
//
// 执行流程（全部在这一个文件里，无项目内部依赖，方便热重载与自测）：
//   1. 把参考音频上传到 Space 的 /gradio_api/upload，拿到服务端路径
//   2. POST /gradio_api/call/generate 提交合成任务，拿到 event_id
//   3. GET  /gradio_api/call/generate/<event_id> 读取 SSE 结果，取出音频 URL
//   4. 下载音频到临时目录
//   5. 用 ctx.sender.sendMedia 以 record 段发出（走队列：串行/限频/去重/留档）
//   6. 5 分钟后删除临时文件（留足时间给协议端上传）
//
// 约定：
//   · 任何失败都返回 { content, isError: true }，绝不抛错 —— 工具抛错会让模型拿不到原因
//   · 配置一律在执行时用 cfg() 读，不在 setup 时快照（否则用户改设置不生效）
//   · 参考音频默认用技能自带的 assets/reference.wav，可在设置里改成任意路径

import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_REF = path.join(SKILL_DIR, 'assets', 'reference.wav');
const DEFAULT_API_BASE = 'https://openbmb-voxcpm-demo.hf.space';
const TEMP_TTL_MS = 5 * 60 * 1000;

let apiRef = {};
let cfg = () => ({});

/** 取 fetch：优先用 api.fetch（清单已声明 web_fetch 权限），退化到全局 fetch。 */
function doFetch(url, options) {
  const f = typeof apiRef.fetch === 'function' ? apiRef.fetch : globalThis.fetch;
  if (typeof f !== 'function') {
    throw new Error('当前运行时没有可用的 fetch（清单需要声明 permissions: ["web_fetch"]）');
  }
  return f(url, options);
}

/** 带超时的 fetch：Unity/Electron 的 fetch 默认不超时，Space 卡住会一直挂着。 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await doFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 解析本技能的运行期配置（每次执行时调用，不住缓存）。 */
function readCfg() {
  const c = (typeof cfg === 'function' ? cfg() : {}) || {};
  return {
    refAudio: typeof c.refAudio === 'string' ? c.refAudio.trim() : '',
    control: typeof c.control === 'string' ? c.control.trim() : '',
    cfgValue: clampNumber(c.cfg, 1, 3, 2),
    maxChars: Math.round(clampNumber(c.maxChars, 10, 500, 200)),
    apiBase: (typeof c.apiBase === 'string' && c.apiBase.trim() ? c.apiBase.trim() : DEFAULT_API_BASE).replace(/\/+$/, ''),
    timeoutMs: Math.round(clampNumber(c.timeoutSec, 15, 600, 120) * 1000)
  };
}

/**
 * 决定这次用哪个参考音频。
 * 设置里填了且存在 → 用它；否则回退到技能自带的 assets/reference.wav。
 * 两者都没有 → 返回 null（available() 会据此在 UI 上显示原因）。
 */
function resolveRefAudio(c) {
  if (c.refAudio && existsSync(c.refAudio)) return { filePath: c.refAudio, from: 'setting' };
  if (existsSync(BUNDLED_REF)) return { filePath: BUNDLED_REF, from: c.refAudio ? 'bundled-fallback' : 'bundled' };
  return null;
}

/** 上传参考音频（手写 multipart，不依赖 FormData/Blob，最稳）。 */
async function uploadReference(c, refPath) {
  const buf = await fsp.readFile(refPath);
  const boundary = `----voxcpmvoice${randomUUID().replace(/-/g, '')}`;
  // 文件名固定用 ASCII：Gradio 对非 ASCII 文件名支持很差（会返回 event: error）
  const head = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Disposition: form-data; name="files"; filename="reference.wav"\r\n'
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  const res = await fetchWithTimeout(`${c.apiBase}/gradio_api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, buf, tail])
  }, c.timeoutMs);

  if (!res.ok) throw new Error(`上传参考音频失败：HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  const serverPath = Array.isArray(json) ? json[0] : (json && Array.isArray(json.files) ? json.files[0] : null);
  if (!serverPath) throw new Error('上传参考音频失败：返回里没有文件路径');
  return String(serverPath);
}

/** 从 SSE 文本里取出音频 URL 或错误信息。 */
function parseSse(sseText) {
  let evt = '';
  let payload = null;
  let errMsg = null;
  for (const raw of String(sseText).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('event:')) {
      evt = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data.startsWith('[')) {
        try { payload = JSON.parse(data); } catch { /* 分片/非 JSON 行忽略 */ }
      } else if (evt === 'error') {
        errMsg = data;
      }
    }
  }
  return { evt, payload, errMsg };
}

/** 提交合成任务并等到音频 URL。 */
async function synthesize(c, { text, control, refServerPath }) {
  // 参数顺序严格照 /gradio_api/info 的 generate 签名：
  // text_input, control_instruction, reference_wav_path_input,
  // use_prompt_text, prompt_text_input, cfg_value_input, do_normalize, denoise
  const body = {
    data: [
      text,
      control,
      { path: refServerPath, meta: { _type: 'gradio.FileData' } },
      false,
      '',
      c.cfgValue,
      false,
      false
    ]
  };

  const submit = await fetchWithTimeout(`${c.apiBase}/gradio_api/call/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, c.timeoutMs);
  if (!submit.ok) throw new Error(`提交合成任务失败：HTTP ${submit.status}`);
  const submitted = await submit.json().catch(() => null);
  const eventId = submitted && submitted.event_id;
  if (!eventId) throw new Error('提交合成任务失败：没有拿到 event_id');

  const sseRes = await fetchWithTimeout(
    `${c.apiBase}/gradio_api/call/generate/${encodeURIComponent(eventId)}`,
    { method: 'GET' },
    c.timeoutMs
  );
  if (!sseRes.ok) throw new Error(`读取合成结果失败：HTTP ${sseRes.status}`);

  const { payload, errMsg } = parseSse(await sseRes.text());
  let url = payload && payload[0] && payload[0].url ? String(payload[0].url) : '';
  if (!url) {
    const detail = errMsg && errMsg !== 'null' ? errMsg : '后端没有返回音频（可能正在排队或后端繁忙）';
    throw new Error(`合成失败：${detail}`);
  }
  if (!/^https?:\/\//i.test(url)) url = c.apiBase + url;
  return url;
}

/** 下载音频到临时文件。 */
async function downloadAudio(c, url) {
  const res = await fetchWithTimeout(url, { method: 'GET' }, c.timeoutMs);
  if (!res.ok) throw new Error(`下载音频失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载音频失败：文件是空的');

  const dir = path.join(os.tmpdir(), 'voxcpm-voice');
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.mp3`);
  await fsp.writeFile(filePath, buf);
  return filePath;
}

/** 超长文本截到最近的句读处，返回 { text, truncated }。 */
function limitText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const m = cut.match(/[\s\S]*[。！？!?…；;，,、\n]/);
  const kept = (m ? m[0] : cut).trim();
  return { text: kept || cut.trim(), truncated: true };
}

export function setup(api = {}) {
  apiRef = api;
  if (typeof api.config === 'function') cfg = api.config;
  api.log?.('鲸鱼语音（VoxCPM）已加载：工具 read_aloud 已注册');

  api.registerTool({
    id: 'read_aloud',
    name: '用小鲸鱼的声音朗读',
    category: 'messaging',
    icon: '🐋',
    description:
      '把一段文字用小鲸鱼的声音念出来，并以 QQ 语音消息发到当前会话（VoxCPM2 音色克隆，参考音频已预先配置）。'
      + '当群友说「读一下XXX」「念一下XXX」「用鲸鱼的声音说XXX」「语音说XXX」，'
      + '或要求把某段文字、某条消息用语音念出来时使用。'
      + 'text 是要念的原文：照抄群友给的内容，不要改写、不要加旁白或解说。'
      + '群友明确指定了语气/情绪（如「用生气的语气读」「温柔一点、慢点」）时，把风格描述放进 control；没有特别要求就不要填 control。'
      + '注意：调用成功就已经把语音发到会话里了，不要再用文字把要念的内容复述一遍。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要念出来的文字原文。直接使用群友给出的内容本身，不要改写、不要添加解说。'
        },
        control: {
          type: 'string',
          description: '语气/情绪/说话风格的描述，例如「生气地大声说」「温柔甜美，语速慢」。群友没有特别指定时不要填。'
        }
      },
      required: ['text']
    },

    async execute(ctx, args) {
      let tempFile = null;
      try {
        const c = readCfg();

        // ── 1. 参数校验 ──────────────────────────────────────────────
        const text = String(args?.text ?? '').trim();
        if (!text) {
          // 不拿 session.triggerText 兜底：那句里带着"读一下"之类的指令词，念出来是错的。
          // 直接报错让模型补上 text 重试，比念错一段话好。
          return {
            content: '缺少要朗读的文本：text 为空。请把群友要求念的内容原文放进 text 再调用一次（不要包含"读一下"这类指令词）。',
            isError: true
          };
        }

        // 超长时截到最近的句读处，spoken 才是真正送去合成的文本
        const limited = limitText(text, c.maxChars);
        const spoken = limited.text;

        const control = String(args?.control ?? '').trim() || c.control;

        // ── 2. 环境校验 ──────────────────────────────────────────────
        if (!ctx || !ctx.chatKey) {
          return { content: '拿不到当前会话标识（ctx.chatKey），无法发送语音。', isError: true };
        }
        if (!ctx.sender || typeof ctx.sender.sendMedia !== 'function') {
          return { content: '发送器不可用（ctx.sender.sendMedia 不存在），无法发送语音。', isError: true };
        }

        const ref = resolveRefAudio(c);
        if (!ref) {
          return {
            content: `找不到参考音频。请在「技能」页的设置里填写一个存在的音频路径，或恢复技能自带的 assets/reference.wav（当前设置：${c.refAudio || '空'}）。`,
            isError: true
          };
        }

        // ── 3. 合成 ──────────────────────────────────────────────────
        const apiLog = typeof apiRef.log === 'function' ? apiRef.log : () => {};
        apiLog(`read_aloud：开始合成（${spoken.length} 字，参考音频=${path.basename(ref.filePath)}，来源=${ref.from}，chatKey=${ctx.chatKey}）`);

        const refServerPath = await uploadReference(c, ref.filePath);
        const audioUrl = await synthesize(c, { text: spoken, control, refServerPath });
        tempFile = await downloadAudio(c, audioUrl);

        const stat = await fsp.stat(tempFile);
        apiLog(`read_aloud：合成完成（${Math.round(stat.size / 1024)} KB），准备发送`);

        // ── 4. 发送（走发送队列：串行 / 限频 / 去重 / 留档）──────────
        await ctx.sender.sendMedia(
          ctx.chatKey,
          [{ type: 'record', data: { file: tempFile } }],
          { label: '[语音]' }
        );

        apiLog(`read_aloud：语音已发送（${path.basename(tempFile)}）`);

        // 延迟删除：给协议端留足读取/转码上传的时间
        const toDelete = tempFile;
        setTimeout(() => { fsp.unlink(toDelete).catch(() => {}); }, TEMP_TTL_MS);
        tempFile = null;   // 交给定时器，不在 finally 里删

        const note = limited.truncated
          ? `（原文超过 ${c.maxChars} 字，已截取到最近的句读处朗读）`
          : '';
        return {
          content: `已经用小鲸鱼的声音把这段内容念出来并发到会话里了${note}。不要再重复发一遍，也不要用文字复述要念的内容。`,
          isError: false
        };
      } catch (error) {
        const msg = error?.name === 'AbortError'
          ? '合成超时（VoxCPM 服务响应太慢，可稍后重试，或在技能设置里调大"合成超时"）。'
          : String(error?.message ?? error);
        try { apiRef?.warn?.(`read_aloud 失败：${msg}`); } catch { /* 日志失败不影响返回 */ }
        return { content: `语音发送失败：${msg}`, isError: true };
      } finally {
        // 合成/发送阶段就失败的话，立即清掉半成品文件
        if (tempFile) {
          fsp.unlink(tempFile).catch(() => {});
        }
      }
    }
  });
}

/**
 * 可用性自检（必须同步）。参考音频两个来源都不存在时，直接在「技能」页显示原因，
 * 而不是等到群里触发了才发现。
 */
export function available() {
  try {
    const c = readCfg();
    if (!resolveRefAudio(c)) {
      return {
        ok: false,
        reason: `找不到参考音频（设置里：${c.refAudio || '空'}，技能自带：assets/reference.wav 也不存在）`
      };
    }
    return true;
  } catch {
    return true;   // 自检本身出错时乐观放行，不要因为自检把功能整个关掉
  }
}

export function dispose() {
  // 临时文件由发送后的定时器回收；这里只做状态复位，避免热重载后串到旧实例
  apiRef = {};
  cfg = () => ({});
}
