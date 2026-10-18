// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import path from 'node:path';
import { getConfig, ROOT } from './config.js';
import { registerTool, listTools } from './tool-registry.js';
import { normalizeMessageList, unquoteJsonString } from './util.js';
import { formatStickerList } from './stickers.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import { webSearch, webFetch, anysearchSearch } from './web-search.js';
import * as KB from './knowledge.js';

// 本工具允许读发的本地目录：项目内的 workspace/ 与 dsh-work/，外加系统临时目录。
// 不写死部署路径（历史上是 /root/qq-agent-v2/...），换机器/换目录自动跟着走。
const WORKSPACE_DIR = path.join(ROOT, 'workspace');
const DSH_WORK_DIR = path.join(ROOT, 'dsh-work');
const TEMP_DIRS = ['/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])];
const LOCAL_PATH_PREFIXES = [WORKSPACE_DIR, DSH_WORK_DIR, ...TEMP_DIRS];

// 下载图片并转成 dataURL（供视觉模型读图）。
//
// ⚠️ 为什么要重试（2026-09-15 事故）：用户在私聊发图后，机器人回了"图片还没同步出来"。
//    复盘发现：消息入库到触发运行只隔 **2.9 秒**，此时 QQ 的 CDN（multimedia.nt.qq.com.cn）
//    往往还没把图片准备好，首次 GET 会失败；而当时**没有任何重试**，一次失败就永久放弃，
//    于是模型只能如实说"看不到图"。同一 URL 几分钟后手工再拉是成功的 —— 典型的瞬时失败。
//    现在改为指数退避重试 3 次（0.6s / 1.5s / 3s），足以覆盖 CDN 就绪延迟。
async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const delays = [600, 1500, 3000];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const { buffer, contentType } = await safeFetchBinary(safeUrl);
      if (!buffer || !buffer.length) throw new Error("图片内容为空");
      const mime = detectMime(buffer) || String(contentType || "image/jpeg").split(";")[0];
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } catch (e) {
      lastError = e;
      if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError ?? new Error("图片下载失败");
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 */
function builtinToolDefs() {
  return [...KB_TOOLS,
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          ctx.emit('session-update', ctx.session.id);
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 从 list_stickers 获取。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(unquoteJsonString(args.stickerId));
          if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
          if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          try {
            await validateImageUrl(sticker.url); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
          } catch (error) {
            return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
          const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_image',
      description: '发送一张图片到当前聊天（URL 或本地 workspace/ 下的路径）。图片来自网页搜索/群友要求/本地生成时用。发送前会校验公网地址安全（拒绝内网）。',
      parameters: {
        type: 'object',
        properties: {
          imageUrl: { type: 'string', description: '图片地址：公网 http(s) URL 或本地文件绝对路径（限 workspace/ 或 dsh-work/ 或 /tmp）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['imageUrl']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.imageUrl ?? '').trim();
          if (!raw) return err('imageUrl 不能为空');
          // 本地路径检查（workspace 内）
          const isLocal = raw.startsWith('/');
          if (isLocal) {
            const allowedPrefixes = LOCAL_PATH_PREFIXES;
            const okPath = allowedPrefixes.some((p) => raw.startsWith(p)) && !raw.includes('..');
            if (!okPath) return err('本地图片路径不在允许范围（仅 workspace 或 /tmp）');
            try {
              const fs2 = await import('node:fs');
              if (!fs2.existsSync(raw)) return err(`图片文件不存在: ${raw}`);
            } catch (e) { return err('无法访问本地文件: ' + (e?.message || e)); }
          } else {
            try {
              await validateImageUrl(raw); // 公网 http(s) 校验（拒绝内网）
            } catch (error) {
              return err(`图片地址不合法，已拒绝发送：${error?.message ?? error}`);
            }
          }
          const result = await ctx.sender.sendImage(ctx.chatKey, raw, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push({ type: 'image', text: `[图片:${String(raw).split('/').pop().slice(0, 50)}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'schedule_task',
      description: '【主人专属】设置/查看/取消**定时任务**：到点机器人会主动发消息给主人，或执行提醒。主人说「X点提醒我…」「每天X点告诉我…」「每周X提醒我…」「N分钟后叫我…」时用它。\n时间由你来理解并换算成绝对时间：now 是当前时间，把「明天早上8点」「3小时后」等换算成 at（ISO 本地时间字符串，如 2026-09-14T08:00:00）。\naction=create（默认）新建；list 查看；cancel 取消（配 taskId）；clear 清空当前会话全部。',
      masterOnly: true,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create（默认）| list | cancel | clear' },
          text: { type: 'string', description: '到点要做什么/要说什么（自然语言，如"提醒我交作业"）' },
          at: { type: 'string', description: '触发时间，ISO 本地格式 YYYY-MM-DDTHH:MM:SS（由你把自然语言换算好）' },
          repeat: { type: 'string', description: 'none（默认，一次性）| daily（每天）| weekly（每周）' },
          taskId: { type: 'string', description: 'action=cancel 时的任务 id' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const ST = await import('./scheduled-tasks.js');
          const action = String(args.action || 'create').toLowerCase();
          const now = new Date();

          if (action === 'list') {
            const list = ST.tasksOf(ctx.chatKey);
            if (!list.length) return ok('当前没有待触发的定时任务。');
            return ok('【待触发的定时任务】\n' + list.map((t) => '· ' + ST.describeTask(t) + '（id: ' + t.id + '）').join('\n'));
          }
          if (action === 'cancel') {
            const id = String(args.taskId || '').trim();
            if (!id) return err('取消任务需要 taskId（可先用 action=list 查看）');
            return ST.removeTask(id) ? ok('已取消任务 ' + id) : err('没找到任务 ' + id);
          }
          if (action === 'clear') {
            const n = ST.clearTasks(ctx.chatKey);
            return ok('已清空 ' + n + ' 条定时任务。');
          }

          // create
          const text = String(args.text || '').trim();
          if (!text) return err('需要 text（到点要做什么）');
          const atStr = String(args.at || '').trim();
          if (!atStr) return err('需要 at（触发时间，ISO 格式如 2026-09-14T08:00:00）');
          const at = new Date(atStr).getTime();
          if (!Number.isFinite(at)) return err('at 格式不对，应为 YYYY-MM-DDTHH:MM:SS');
          if (at <= now.getTime()) return err('at 是过去的时间，请给未来的时间');
          const repeat = String(args.repeat || 'none').toLowerCase();
          const t = ST.addTask({ chatKey: ctx.chatKey, text, at, repeat });
          const diffMin = Math.round((at - now.getTime()) / 60000);
          return ok({
            created: true,
            id: t.id,
            when: ST.describeTask(t),
            note: '任务已记下，到点我会主动发消息。可以告诉主人「好，' + diffMin + ' 分钟后提醒你」。'
          });
        } catch (error) {
          return err(`定时任务操作失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'schedule_query',
      description: '【主人专属·秒回】直接查询本地课表（不需要 DSH）。when 取值：today=今天 / tomorrow=明天 / week=未来7天 / date=指定日期（配 date 参数）/ courses=全部课程总览。主人问"明天上什么课/今天有课吗/这周课表/课表里有哪些课"时立即用它，不要派 DSH。',
      parameters: {
        type: 'object',
        properties: {
          when: { type: 'string', description: 'today | tomorrow | week | date | courses（默认 tomorrow）' },
          date: { type: 'string', description: 'when=date 时的日期，格式 YYYY-MM-DD' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const SQ = await import('./schedule-query.js');
          const when = String(args.when || 'tomorrow').toLowerCase();
          const today = SQ.localDate();
          if (when === 'today' || when === 'tomorrow') {
            const d = when === 'today' ? today : SQ.localDate(SQ.shiftDate(1));
            const r = SQ.getDaySchedule(d);
            if (!r.ok) return err(r.error);
            return ok(SQ.renderDay(d, r));
          }
          if (when === 'week') {
            const r = SQ.getRangeSchedule(today, SQ.localDate(SQ.shiftDate(6)));
            if (!r.ok) return err(r.error);
            const lines = ['【未来 7 天课程】'];
            let total = 0;
            for (const d of r.days) {
              if (!d.count) { lines.push(`· ${d.date} ${d.weekday}：无课`); continue; }
              total += d.count;
              lines.push(`· ${d.date} ${d.weekday}：`);
              lines.push(SQ.renderWeekDayItems(d.items));
            }
            if (!total) lines.push('（这 7 天都没有课）');
            return ok(lines.join('\n'));
          }
          if (when === 'date') {
            const d = String(args.date || '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return err('date 需要 YYYY-MM-DD 格式');
            const r = SQ.getDaySchedule(d);
            if (!r.ok) return err(r.error);
            return ok(SQ.renderDay(d, r));
          }
          if (when === 'courses') {
            const r = SQ.getCourseList();
            if (!r.ok) return err(r.error);
            const lines = [`【课程总览】共 ${r.count} 门（覆盖 ${r.range ? r.range.join(' ~ ') : '未知'}）`];
            for (const c of r.courses) {
              lines.push(`· ${c.course}｜${(c.teachers || []).join('/')}｜${(c.weekdays || []).join('')}`);
            }
            if (r.generatedAt) lines.push(`（数据生成于 ${r.generatedAt}）`);
            return ok(lines.join('\n'));
          }
          return err('when 只支持 today/tomorrow/week/date/courses');
        } catch (error) {
          return err(`课表查询失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'receive_file',
      description: '把主人发来的 QQ 文件（[文件：xxx] 占位符的消息）下载到工作目录，得到本地路径后就可以读取/解析/转交 DSH。id 用聊天记录里每条消息前的 #数字（没有 #数字时先用 get_recent_messages 查）。传了 messageId 会列出该消息里所有文件。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' },
          fileIndex: { type: 'number', description: '同一条消息里有多个文件时指定第几个（从 0 开始），默认 0' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const files = (entry.media || []).filter((m) => m.kind === 'file');
          if (!files.length) return err('这条消息里没有文件（可能只有图片或文字）');
          const idx = Math.max(0, Math.min(Number(args.fileIndex) || 0, files.length - 1));
          const f = files[idx];
          if (!f.fileId) return err('这个文件缺少 file_id，无法下载（可能是旧消息或 NapCat 未提供）');

          // 下载目录：工作区固定子目录，方便交给 DSH
          const fsmod = await import('node:fs');
          const pathmod = await import('node:path');
          const cfgmod = await import('./config.js');
          const inbox = pathmod.join(cfgmod.DATA_DIR, 'inbox');
          fsmod.mkdirSync(inbox, { recursive: true });
          const safeName = String(f.name || 'file').replace(/[\/:*?"<>|]/g, '_');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const dest = pathmod.join(inbox, `${stamp}_${safeName}`);

          // NapCat get_file：拿下载地址，再取回文件
          const info = await ctx.onebot.call('get_file', { file_id: f.fileId }, 30000).catch((e) => {
            throw new Error('get_file 失败：' + (e?.message || e));
          });
          const urls = [info?.url, info?.file, info?.data?.url, info?.data?.file].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
          if (!urls.length) return err('NapCat 没有返回可下载地址：' + JSON.stringify(info).slice(0, 200));
          const res = await fetch(urls[0], { signal: AbortSignal.timeout(120000) });
          if (!res.ok) return err('下载失败 HTTP ' + res.status);
          const buf = Buffer.from(await res.arrayBuffer());
          fsmod.writeFileSync(dest, buf);

          return ok({
            saved: dest,
            name: f.name || safeName,
            size: buf.length,
            note: '文件已下载到本地。可以直接读取内容，或用 dsh_task 让 DSH 处理（把上面这个 saved 路径写进任务描述）。'
          });
        } catch (error) {
          return err(`接收文件失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'send_file',
      masterOnly: true,
      description: '【主人专属】把本地文件（DSH 任务产物，位于本项目 dsh-work/ 下）作为文件消息发送到当前聊天。主人任务完成后要文件时用。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '本地文件绝对路径（限 dsh-work/ 或 workspace/ 或 /tmp）' },
          fileName: { type: 'string', description: '可选：发送时显示的文件名' }
        },
        required: ['filePath']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.filePath ?? '').trim();
          if (!raw) return err('filePath 不能为空');
          const allowedPrefixes = [DSH_WORK_DIR, WORKSPACE_DIR, ...TEMP_DIRS];
          const okPath = allowedPrefixes.some((p) => raw.startsWith(p)) && !raw.includes('..');
          if (!okPath) return err('文件路径不在允许范围（仅 dsh-work/workspace/tmp）');
          const fs2 = await import('node:fs');
          if (!fs2.existsSync(raw)) return err(`文件不存在: ${raw}`);
          const stat = fs2.statSync(raw);
          if (!stat.isFile()) return err('目标不是文件');
          if (stat.size > 50 * 1024 * 1024) return err('文件超过 50MB 上限');
          const result = await ctx.sender.sendFile(ctx.chatKey, raw, String(args.fileName || '').trim() || undefined);
          ctx.session.sent.push({ type: 'file', text: `[文件:${String(args.fileName || raw.split('/').pop())}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, fileId: result?.file_id ?? null, note: '文件已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'list_stickers',
      description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id' } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(args.stickerId);
          if (!sticker) return err(`找不到表情 ${args.stickerId}`);
          if (!sticker.url) return err('该表情没有图片地址');
          const dataUrl = await downloadImageAsDataUrl(sticker.url);
          return { content: imageParts(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：`, [dataUrl]) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string' },
          note: { type: 'string', description: '你的理解/含义' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
          if (!entry) return err(`找不到表情 ${args.stickerId}`);
          return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!imageMedia) return err('该消息没有可收藏的图片');
          const saved = ctx.stickers.collect(args.messageId, { url: imageMedia.url, note: String(args.note ?? '') });
          return ok({ collected: true, id: saved.id, note: saved.localNote });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            target = Number(target);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : m.senderName,
            text: m.text
          }))
        });
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : entry.senderName,
          senderId: entry.senderId,
          text: entry.text,
          reply: entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
          if (!urls.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
          const dataUrls = [];
          const failed = [];
          for (const url of urls) {
            try { dataUrls.push(await downloadImageAsDataUrl(url)); } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          if (!dataUrls.length) return err(`图片获取失败：${failed.join('；')}`);
          const note = failed.length ? `（另有 ${failed.length} 张获取失败）` : '';
          return { content: imageParts(`消息 ${args.messageId} 的图片内容${note}：`, dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记一条轻量记忆（下次运行会自动看到）：activeTopic=进行中的话题；pendingThought=想说但还没说的话；memberImpression=对某位群友的印象。偶尔用，别当笔记本。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'] },
          content: { type: 'string', description: '记忆内容' },
          target: { type: 'string', description: 'memberImpression 时的群友名字' }
        },
        required: ['category', 'content']
      },
      async execute(ctx, args) {
        const extra = {};
        if (args.target) extra.target = String(args.target).slice(0, 50);
        const entry = ctx.memory.append(ctx.chatKey, String(args.category), String(args.content ?? ''), extra);
        return ok({ saved: true, entry });
      }
    },
    {
      name: 'memory_query',
      description: '查看当前会话的轻量记忆。',
      parameters: {
        type: 'object',
        properties: { category: { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'], description: '可选：只看某一类' } }
      },
      async execute(ctx, args) {
        return ok(ctx.memory.query(ctx.chatKey, args.category ? String(args.category) : ''));
      }
    },
    {
      name: 'memory_remove',
      description: '删除一条过时/不再重要的记忆。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'] },
          content: { type: 'string', description: '要删除的话题/想法原文（memberImpression 用 target）' },
          target: { type: 'string', description: 'memberImpression 时要删除的群友名字' }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, String(args.category), { content: String(args.content ?? ''), target: String(args.target ?? '') });
        return ok({ removed });
      }
    },
    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'web_search',
      description: '联网搜索，返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const q = String(args.query ?? '');
          const provider = String(getConfig().webSearch?.provider || 'auto').toLowerCase();
          // bing：直接走 Bing 网页抓取
          if (provider === 'bing') {
            const r = await webSearch(q);
            if (!r.results.length) return ok({ query: r.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
            return ok({ ...r, engine: 'bing' });
          }
          // anysearch：只用 AnySearch（失败则如实报错，不回退）
          if (provider === 'anysearch') {
            const any = await anysearchSearch(q, { maxResults: 8 });
            if (any && any.results.length) return ok(any);
            return err('AnySearch 没有返回结果（可能 key 未配置或额度用尽）。可在设置 → 模型 API → 联网搜索里切换搜索引擎。');
          }
          // auto（默认）：有 key 优先 AnySearch，失败自动回退 Bing
          try {
            const any = await anysearchSearch(q, { maxResults: 8 });
            if (any && any.results.length) return ok(any);
          } catch (e) {
            // AnySearch 失败（429/超时等）→ 回退 Bing
          }
          const result = await webSearch(q);
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          return ok(result);
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const result = await webFetch(String(args.url ?? ''));
          const body = String(result.body || '');
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > 20000,
            content: body.slice(0, 20000)
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    },
    {
      name: 'dsh_task',
      masterOnly: true,
      description: '【主人专属】把耗时/复杂 agent 任务（做网页/PPT/文档/画图/批量处理/写代码等）转发给本机 DSH 执行。调用后立即返回任务已提交，然后向 master 说明已开工；DSH 完成后会自动向 master 汇报。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要 DSH 完成的任务描述（尽量具体：做什么、什么格式、放哪）' },
          taskName: { type: 'string', description: '可选：任务名（用于工作目录命名，简短英文/数字）' }
        },
        required: ['task']
      },
      async execute(ctx, args) {
        try {
          const { submitDshTask } = await import('./dsh-task.js');
          const result = await submitDshTask(String(args.task ?? ''), {
            taskName: String(args.taskName || '')
          });
          // 注册待汇报任务（orchestrator watcher 轮询此表）
          const { registerDshTask } = await import('./dsh-task.js');
          // taskText/taskName 记下来：任务完成后唤醒汇报时要用它们说明"当初交待了什么"
          registerDshTask({
            sessionId: result.sessionId,
            workDir: result.workDir,
            chatKey: ctx.chatKey,
            taskText: String(args.task ?? '').slice(0, 400),
            taskName: String(args.taskName || ''),
            submittedAt: Date.now()
          });
          ctx.session.dshTask = { sessionId: result.sessionId, workDir: result.workDir, chatKey: ctx.chatKey, submittedAt: Date.now() };
          return ok({
            submitted: true,
            sessionId: result.sessionId,
            workDir: result.workDir,
            note: '任务已提交 DSH 后台执行。请立即回复 master「收到，已开工，DSH 正在做，完成后本鲸汇报」，然后正常结束本次处理。'
          });
        } catch (error) {
          return err(`任务提交失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'teacher_control',
      description: '【主人专属】控制「副机器人实例」的上下线。action=start：启动副实例并保持在线（账密自动登录，约60-90秒完成）；action=stop：关闭教师下线（避免长时间在线触发风控）；action=status：查询教师状态；action=auto：恢复自动假死模式。主人说「启动teacher/开启教师」用 start；说「关闭teacher/关掉教师」用 stop。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'start=启动并保持在线 / stop=关闭下线 / status=查状态 / auto=恢复自动模式' }
        },
        required: ['action']
      },
      masterOnly: true,
      async execute(ctx, args) {
        try {
          const action = String(args.action || '').toLowerCase();
          const base = 'http://127.0.0.1:3211/api/hibernation';
          const call = async (path) => {
            const res = await fetch(base + path, { method: 'GET', signal: AbortSignal.timeout(120000) });
            return await res.json();
          };
          if (action === 'status') {
            const d = await call('');
            return ok('副实例状态：' + JSON.stringify({ mode: d.mode, state: d.state, online: d.onebotConnected, idleForSec: d.idleForSec }));
          }
          if (action === 'start') {
            const d = await call('/hold');
            return ok('副实例已启动（mode=hold）。协议端正在登录，约60-90秒后可用。注意：若账密自动登录失败，需主人扫码（二维码见项目根目录 新教师扫码.png）。状态：' + JSON.stringify({ mode: d.mode, state: d.state }));
          }
          if (action === 'stop') {
            const d = await call('/close');
            return ok('副实例已关闭下线（避免风控），需要时再启动。状态：' + JSON.stringify({ mode: d.mode, state: d.state }));
          }
          if (action === 'auto') {
            const d = await call('/auto');
            return ok('副实例已恢复自动假死模式（空闲3分钟自动下线）。');
          }
          return err('action 需为 start/stop/status/auto');
        } catch (e) {
          return err('副实例控制失败：' + (e?.message || e) + '（副实例服务可能未运行）');
        }
      }
    }
  ];
}

/** 内置工具的元数据（注册进 tool-registry 时用；Skill 工具由加载器自行声明）。 */
const BUILTIN_META = {
  messaging: ['send_message', 'send_sticker', 'send_image', 'send_poke'],
  file: ['receive_file', 'send_file'],
  schedule: ['schedule_task', 'schedule_query'],
  sticker: ['list_stickers', 'get_sticker_image', 'sticker_note', 'collect_sticker'],
  query: ['get_recent_messages', 'get_active_members', 'get_message_detail', 'get_message_images'],
  memory: ['memory_append', 'memory_query', 'memory_remove', 'report_feedback'],
  web: ['web_search', 'web_fetch'],
  knowledge: ['kb_overview', 'kb_questions', 'kb_textbook', 'kb_progress', 'study_log', 'study_plan'],
  system: ['finish', 'dsh_task', 'teacher_control']
};
const BUILTIN_CATEGORY = (() => {
  const m = new Map();
  for (const [cat, ids] of Object.entries(BUILTIN_META)) for (const id of ids) m.set(id, cat);
  return m;
})();
const VISION_TOOLS = new Set(['get_message_images', 'get_sticker_image']);
const SEARCH_TOOLS = new Set(['web_search', 'web_fetch']);

let builtinsRegistered = false;

/** 把内置工具注册进 registry（幂等）。返回注册后的工具定义数组。 */
function registerBuiltins() {
  if (!builtinsRegistered) {
    builtinsRegistered = true;
    for (const def of builtinToolDefs()) {
      const id = def.name;
      registerTool({
        id,
        name: id,
        description: def.description,
        parameters: def.parameters,
        execute: def.execute,
        category: BUILTIN_CATEGORY.get(id) || 'system',
        requiresVision: VISION_TOOLS.has(id),
        requiresSearch: SEARCH_TOOLS.has(id),
        masterOnly: def.masterOnly === true,
        skillId: null
      });
    }
  }
  return listTools();
}

/**
 * 构建本次运行可用的工具定义。
 *
 * 现在与扩展系统统一口径：内置工具 + Skill 注册的工具都在 tool-registry 里，
 * 这里只负责返回全量，具体"这一轮哪些可用"由 orchestrator 用
 * getToolAvailability() 过滤（唯一口径，避免两处各判一半）。
 */
export function buildToolDefs() {
  return registerBuiltins();
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.id || d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => (d.id || d.name) === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}




// ── 知识库工具（教学身份用；从 qq-agent-tutor 移植并修复）────────────────
// 说明：本数组在 buildToolDefs 的 return 中被展开。因 const 提升限制，
// 定义位置需在 buildToolDefs 之后（函数调用时已初始化）。
const KB_TOOLS = [
  {
    name: 'kb_overview',
    description: '查看证券从业知识库总览（科目、章节、题量、教材）。开始教学或主人问"有什么可学的"时用。',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx, args) {
      try { return ok(KB.listOverview()); } catch (e) { return err(e?.message ?? e); }
    }
  },
  {
    name: 'kb_questions',
    description: '从知识库取题（默认优先真题，也可指定只取真题/练习题，见 zhentiOnly）。出题/刷题/复习/测验都用它。可指定科目、章节、题型、数量；出给主人做时 showAnswer 传 false，判卷/讲解时传 true。返回文本第一行就是【题型】（单选题/多选题/判断题/组合型选择题）——出题时必须把题型一并告诉主人，否则他不知道该选几个。题目文本要展示给主人时记得用 send_message。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '科目：金融市场基础知识 或 证券市场基本法律法规' },
        chapter: { type: 'string', description: '章节名，如 第一章 证券市场基本法律法规（可选，缺省全科目）' },
        type: { type: 'string', description: '题型：单选题/多选题/判断题/组合型选择题（可选）' },
        count: { type: 'number', description: '数量，默认 5，最大 10' },
        showAnswer: { type: 'boolean', description: 'true=连答案解析一起返回（判卷/复习），false=只出题' },
        zhentiOnly: { type: 'boolean', description: 'true=只取历年真题；false（默认）=优先真题，不足时用练习题补足' }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        const count = Math.max(1, Math.min(Number(args.count) || 5, 10));
        const qs = KB.pickQuestions({
          subject: args.subject, chapter: args.chapter, type: args.type, count,
          preferZhenti: args.zhentiOnly !== false
        });
        if (!qs.length) return err('没有符合条件的题，试试放宽筛选');
        return ok(qs.map((q) => KB.formatQuestion(q, !!args.showAnswer)).join('\n\n---\n\n'));
      } catch (e) { return err(e?.message ?? e); }
    }
  },
  {
    name: 'kb_textbook',
    description: '查教材。mode=search：按关键词检索原文（默认）；mode=outline：列出某科某章教材大纲（节+知识点清单，用于"这章讲完没/还有哪些没讲"的覆盖检查）；mode=section：按小节标题取该节正文切片（系统讲解某节时用）。讲概念/讲题/章节覆盖检查都用它。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '科目：金融市场基础知识 或 证券市场基本法律法规' },
        keyword: { type: 'string', description: '关键词（mode=search 时用），如 科创板、注册制、IOSCO' },
        chapter: { type: 'string', description: '章节名（mode=outline 时用），如 第一章、第二章' },
        section: { type: 'string', description: '小节名（mode=section 时用），如 全球金融市场、金融市场概述' },
        mode: { type: 'string', description: 'search=关键词检索（默认）/ outline=章节大纲 / section=小节正文' },
        maxChunks: { type: 'number', description: '返回块数上限（默认 3，最大 6）' }
      },
      required: ['subject']
    },
    async execute(ctx, args) {
      try {
        const subj = args.subject;
        const mode = args.mode || 'search';
        const maxC = Math.min(Number(args.maxChunks) || 3, 6);
        if (mode === 'outline') {
          const o = KB.chapterOutline(subj, args.chapter || '第一章');
          return ok(KB.formatOutline(o));
        }
        if (mode === 'section') {
          const hits = KB.searchTextbookBySection(subj, args.section || '', maxC);
          if (!hits.length) return err('没找到该小节内容，试试其它小节名或改用 outline 看大纲');
          return ok(hits.map((h) => '【教材第' + h.pages + '页】\n' + h.text).join('\n\n=== 下一块 ===\n\n'));
        }
        const hits = KB.searchTextbook(subj, args.keyword, maxC);
        if (!hits.length) return err('教材没搜到相关片段，换个关键词或看看大纲');
        return ok(hits.map((h) => '【教材第' + h.pages + '页】\n' + h.text).join('\n\n=== 下一块 ===\n\n'));
      } catch (e) { return err(e?.message ?? e); }
    }
  },
  {
    name: 'kb_progress',
    description: '查看/更新主人的学习进度与错题本。action=view（默认）看进度；action=done 标记某章学完；action=wrong 手动记一道错题。上课前了解进度、答错题后记录都用它。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'view=查看（默认）/ done=标记章节学完 / wrong=记录错题' },
        subject: { type: 'string', description: '科目（action=done/wrong 时用）' },
        chapter: { type: 'string', description: '章节名（action=done 时用）' }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        const uin = String(ctx.chatId || '');
        const action = args.action || 'view';
        if (action === 'done') {
          if (!args.subject || !args.chapter) return err('标记章节需要 subject 和 chapter');
          const p = KB.markChapterDone(uin, args.subject, args.chapter);
          return ok('已标记学完：' + args.chapter + '\n\n' + KB.formatProgress(p));
        }
        if (action === 'wrong') {
          const p = KB.recordQuiz(uin, { qid: '', subject: args.subject, chapter: args.chapter, correct: false, userAnswer: '' });
          return ok('已记入错题本\n\n' + KB.formatProgress(p));
        }
        const p = KB.loadProgress(uin);
        return ok(KB.formatProgress(p));
      } catch (e) { return err(e?.message ?? e); }
    }
  },
  {
    name: 'study_log',
    description: '学习档案管理。action=view（默认）查看最近的学习记录摘要；action=write 追加一条学习总结（主人说"记录一下/做个总结/写入档案"时用）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'view=查看（默认）/ write=写入总结' },
        content: { type: 'string', description: 'action=write 时的总结内容' }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        if ((args.action || 'view') === 'write') {
          const body = String(args.content || '').trim();
          if (!body) return err('写入档案需要 content');
          KB.appendStudyLog(body);
          return ok('学习记录已追加（' + body.length + ' 字）');
        }
        const t = KB.readStudyLog(3000);
        return ok(t || '（学习档案还是空的）');
      } catch (e) { return err(e?.message ?? e); }
    }
  },
  {
    name: 'study_plan',
    description: '学习计划与复习调度（学习模式核心工具）。action=today（默认）看今日任务（先温故复习、后知新开节）；action=plan 看整体规划与复习队列；action=section-done 登记“某节已讲完”（会自动排入间隔复习：1/3/7/15/30 天）；action=review 记录一次复习结果（ok=true 进档，false 回到第 1 档）。每讲完一节必须调 section-done 登记，否则系统不知道进度、也不会安排复习。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'today=今日任务（默认）/ plan=整体规划 / section-done=登记某节讲完 / review=记录复习结果' },
        subject: { type: 'string', description: '科目：金融市场基础知识 或 证券市场基本法律法规' },
        chapter: { type: 'string', description: '章节名（如 第一章 金融市场体系）' },
        section: { type: 'string', description: '小节名（section-done / review 时用，如 第一节 金融市场概述）' },
        key: { type: 'string', description: 'review 时的队列项 key（today 输出里带；不确定可省略，用 subject/chapter/section 定位）' },
        kind: { type: 'string', description: 'review 时的项类型：section=节复习 / wrong=错题回炉' },
        qid: { type: 'string', description: 'review 错题回炉时的题号（可选）' },
        ok: { type: 'boolean', description: 'review 时：true=复习通过（进下一档）/ false=没通过（回到第 1 档）' }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        const SP = await import('./study-plan.js');
        const uin = String(ctx.chatId || '');
        const action = String(args.action || 'today').toLowerCase();
        if (action === 'today') return ok(SP.formatToday(SP.todayTasks(uin)));
        if (action === 'plan') return ok(SP.formatPlan(uin));
        if (action === 'section-done') {
          if (!args.subject || !args.section) return err('section-done 需要 subject 和 section（如 subject=金融市场基础知识, section=第一节 金融市场概述）');
          const r = SP.completeSection(uin, { subject: args.subject, chapter: args.chapter, section: args.section });
          return ok('已登记讲完：《' + r.done.subject + '》' + r.done.chapter + ' · ' + r.done.section
            + '\n已排入间隔复习（明天首次复习）\n\n' + SP.formatToday(r.tasks));
        }
        if (action === 'review') {
          const okFlag = args.ok === true || String(args.ok) === 'true';
          const r = SP.recordReviewResult(uin, {
            key: args.key, kind: args.kind, subject: args.subject, chapter: args.chapter,
            section: args.section, qid: args.qid, ok: okFlag
          });
          const head = r.mastered
            ? '该节已连续通过全部 5 档复习，视为掌握 ✔（已移出复习队列）'
            : (okFlag ? '复习通过 → 进第 ' + (r.item.stage + 1) + '/5 档' : '未通过 → 回到第 1 档，' + (r.item.lapses) + ' 天后重来');
          return ok(head + '\n\n' + SP.formatToday(r.tasks));
        }
        return err('action 需为 today/plan/section-done/review');
      } catch (e) { return err(e?.message ?? e); }
    }
  }
];

/** 知识库工具名集合（供按身份过滤用）。 */
export const KB_TOOL_NAMES = new Set(KB_TOOLS.map((t) => t.name));
