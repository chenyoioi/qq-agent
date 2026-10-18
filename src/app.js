// 🔴 时区铁律（记忆系统 00 铁律 0.5 / 01 第六节）：
//   服务器系统时区是 UTC，但用户在**中国（UTC+8）** —— 所有面向用户的时间必须是北京时间。
//   TZ 必须在任何 new Date() 之前设置，且 ESM 的 import 会先于模块体执行，
//   所以这三行放在**所有 import 之上**。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR } from './config.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments } from './onebot.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, estimateCost, chatCompletion } from './llm.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from './providers.js';
import { scanModelsVision, visionResults } from './vision-scan.js';
import { ScheduleNotifyScheduler } from './schedule-notify.js';
import { qrInfo, readQrBuffer } from './napcat-qr.js';
import { NapCatWebui } from './napcat-webui.js';
import { QrRefreshGuard } from './qr-refresh-guard.js';
import { OneBotHealth } from './onebot-health.js';
import { ScheduledTaskRunner } from './scheduled-tasks.js';
import { createEventBus, todayKey } from './util.js';
import { loadPlugins, watchPlugins, unloadSkill, SKILL_DIRS } from './plugin-loader.js';
import { skillManager } from './skills/manager.js';
import { setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { listTools, getToolAvailability } from './tool-registry.js';
import { KB_TOOL_NAMES } from './tools.js';
import { validateZipStructure, unzipToModuleDir } from './zip-install.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

/**
 * 调用外部桌面应用的内部 API（带访问令牌）。
 *
 * ⚠️ 令牌从 600 的 config.json 读取，**只在本进程使用**，不下发给浏览器。
 * 用于面板的「账号总览 / 一键切号」—— 复用桌面侧已实现且已做安全校验的能力
 * （桌面侧已限制 URL 白名单 + 改配置前自动备份），避免两处重复实现。
 */
async function deskApi(pathname, method = 'GET', body) {
  const cfgPath = '/path/to/desktop-app/data/config.json';
  let token = '';
  try {
    token = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).authToken || '';
  } catch (error) {
    throw new Error('读不到桌面令牌（' + cfgPath + '）');
  }
  if (!token) throw new Error('桌面令牌为空');
  const res = await fetch('http://127.0.0.1:8090' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desk-Token': token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  return data?.data !== undefined ? data.data : data;
}

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();
  let pluginWatcher = null;

  /** Skill 运行期上下文（可用性判断 / 提示词片段用）。 */
  function skillRuntimeContext() {
    const c = getConfig();
    return {
      model: c.api?.model,
      provider: c.api?.provider,
      visionEnabled: c.api?.vision !== false,
      searchEnabled: c.webSearch?.enabled !== false
    };
  }

  /**
   * Skill 重扫：启动与「刷新」按钮共用的唯一入口。
   * 重扫磁盘 → 激活已启用项 → 重建 watcher（fs.watch 在目录重建后会失效）。
   */
  async function reloadSkills({ reason = 'manual' } = {}) {
    const result = await loadPlugins({ log });
    for (const st of skillManager.list(skillRuntimeContext())) {
      if (st.enabled && st.loaded) {
        try { skillManager.activate(st.id, skillRuntimeContext()); } catch (error) {
          log(`[skill] 激活 ${st.id} 失败：${error?.message ?? error}`);
        }
      }
    }
    const hotReloadOn = process.env.QQ_AGENT_DEV === '1'
      || getConfig().extensions?.hotReload !== false;
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    if (hotReloadOn) {
      pluginWatcher = watchPlugins({
        log,
        onReload: () => { reloadSkills({ reason: 'watch' }).catch(() => {}); }
      });
    }
    if (reason !== 'boot') {
      log(`[skill] 重扫完成（${reason}）：${result.loaded.length} 成功，${result.failed.length} 失败`
        + (result.pruned?.length ? `，卸载 ${result.pruned.length} 个已删除项` : ''));
      emit('skills-changed', { at: Date.now() });
    }
    return result;
  }

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    return fs.existsSync(bundled) ? bundled : '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const wsPort = snowlumaWsPort();
    if (await isPortOpen('127.0.0.1', wsPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退：launcher.bat 独立控制台窗口（老行为，日志无法内置）
    const launcher = path.join(dir, 'launcher.bat');
    if (!fs.existsSync(launcher)) return { ok: false, error: `目录里没有 index.mjs / node.exe，也没有 launcher.bat：${dir}` };
    const child = spawn('cmd.exe', ['/c', launcher], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false // 保留 SnowLuma 自己的控制台窗口
    });
    child.unref();
    pushSnowlumaLog('SnowLuma 已用独立控制台窗口启动（此模式下日志不进内置控制台）', 'stdout');
    return { ok: true, launched: true, embedded: false };
  }

  const emit = (type, payload) => {
    bus.emit(type, payload);
    const line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 2000);
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 300);
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });

  // 每晚定时私聊播报次日课程（应用内调度器，不用 cron/systemd；配置见 data/config.json 的 scheduleNotify）
  const scheduleNotify = new ScheduleNotifyScheduler({ orchestrator, sender, onebot, log, root: ROOT });
  // 通用定时任务（主人在 QQ 里下的提醒/定时指令）
  // ── NapCat WebUI 客户端（账密登录 / 人机验证代理）──
  const napcatWebui = new NapCatWebui({ log });



  // ── QQ 账号健康探针 ──
  // 只用 WS 连接状态判断健康是不够的：NapCat 的 WS 在**账号离线**时依然在监听，
  // 会导致控制台误报"已连接"（2026-09-14 事故：掉线 5 小时无人发现）。
  // 这里周期性调 get_status 拿真实的 online 标志，掉线时推 SSE 事件 + 打印告警。
  const onebotHealth = new OneBotHealth({ onebot, log });
  onebotHealth.on('offline', (st) => {
    log('[health] ⚠ QQ 账号离线，机器人将无法收发消息。请检查 NapCat 登录状态。');
    emit('onebot-health', { online: false, since: st.offlineSince, error: st.lastError });
  });
  onebotHealth.on('recovered', () => {
    log('[health] ✔ QQ 账号已恢复在线。');
    emit('onebot-health', { online: true, at: Date.now() });
  });

  // ── 登录二维码刷新守护 ──
  // NapCat 的自动刷新循环会卡死（2026-09-16 事故），进程却还活着，
  // 外部健康检查查不出来。这里靠"二维码文件是否还在更新"来发现并踢活。
  const qrGuard = new QrRefreshGuard({
    napcatWebui,
    // ⚠️ 必须用「账号是否在线」，**不能**用 onebot.connected（WS 是否连着）！
    //    NapCat 的 WS 在账号离线时依然在监听 → connected 恒为 true → 守护误以为
    //    "已登录"，直接跳过检查，于是二维码再旧也不会被踢活（2026-09-17 事故）。
    //    这是同一个坑第三次出现（前两次：控制台显示、二维码面板），务必保持警惕。
    isLoggedIn: () => onebotHealth.snapshot().online === true,
    dir: () => snowlumaDir(),
    log
  });

  const scheduledRunner = new ScheduledTaskRunner({ orchestrator, log });

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 登录后会在 snowluma/config/onebot_<uin>.json 里写入随机 accessToken。
  // 脱敏发布/全新副本中 qq-agent 的 token 为空，若不自动同步会一直 401。这里在
  // OneBot 未连接时读取 SnowLuma 配置，把 HTTP/WS 令牌补进我们的配置。
  let lastSyncTokenSig = '';
  function syncSnowlumaTokens() {
    try {
      const dir = snowlumaDir();
      if (!dir) return false;
      const cfgDir = path.join(dir, 'config');
      const files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      if (!files.length) return false;
      const data = JSON.parse(fs.readFileSync(path.join(cfgDir, files[0]), 'utf8'));
      const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
      const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
      const wsToken = String(ws?.accessToken ?? '');
      const httpToken = String(http?.accessToken ?? '');
      const sig = `${wsToken}|${httpToken}`;
      if (!sig || sig === lastSyncTokenSig) return false;
      const cur = getConfig();
      if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== httpToken) {
        updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken } });
        log('[onebot] 已从 SnowLuma 配置同步 OneBot 访问令牌');
      }
      lastSyncTokenSig = sig;
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时自动同步一次令牌并重连
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    if (syncSnowlumaTokens()) {
      const cur = getConfig();
      onebot.wsUrl = String(cur.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(cur.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(cur.snowluma?.accessToken || '');
      onebot.httpToken = String(cur.snowluma?.httpAccessToken || cur.snowluma?.accessToken || '');
      onebot.reconnect();
    }
  }
  onebot.onStatus((status) => {
    if (!status.connected && String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      const senderId = String(msg?.sender?.user_id ?? msg?.user_id ?? '');
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), senderId, text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    if (!text && !media.length) return;
    const chatKey = kind + ':' + id;
    store.appendIncoming(chatKey, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    emit('chat-update', chatKey);
    // 所有消息都交给模型处理（入库 + 触发），由模型根据上下文自主决定是否回复。
    // 系统提示已引导：@/点名/针对自己的必回；无关群聊/别人的图/别人的引用 → 模型选择安静结束（不回复）。
    orchestrator.onIncoming(chatKey);
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorId}）`;
    } else {
      const operatorName = isGroup ? (await resolveAtName(id, operatorId)) || operatorId : operatorId;
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    store.appendIncoming(`${isGroup ? 'group' : 'private'}:${id}`, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: '（拍一拍事件）',
      text,
      media: []
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null,
            // 账号级健康（与"WS 是否连上"不同：账号离线时 WS 仍可能连着）
            account: onebotHealth.snapshot(),
            // 综合结论：WS 连着 **且** 账号在线，才算真正可用
            healthy: !!onebot.connected && onebotHealth.snapshot().online !== false
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          orchestrator: orchestrator.statusSummary(),
          usage: {
            ...usage,
            cost: estimateCost(usage)
          },
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null
        });
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-200) });
      }

      // ── 登录二维码（未登录时展示，供扫码）──
      // NapCat 会把二维码写到它的 cache/qrcode.png，约每 2 分钟自动刷新。
      if (pathname === '/api/snowluma/qr' && method === 'GET') {
        const info = qrInfo(snowlumaDir());
        return json(res, 200, {
          exists: info.exists,
          qrAt: info.qrAt,
          ageMs: info.ageMs,
          // ⚠️ 用「账号是否在线」而非「WS 是否连着」——WS 在账号离线时依然在监听，
        //    用 connected 会让面板以为已登录、从而不显示二维码（2026-09-16 事故）。
        loggedIn: onebotHealth.snapshot().online === true,
          onebotError: onebot.lastConnectError || '',
          self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
        });
      }

      if (pathname === '/api/snowluma/qr.png' && method === 'GET') {
        const got = readQrBuffer(snowlumaDir());
        if (!got) return json(res, 404, { error: '暂无二维码（已登录，或 NapCat 未在等待扫码）' });
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': got.buffer.length
        });
        return res.end(got.buffer);
      }

      // ── NapCat 登录代理（账密登录 / 人机验证 / 新设备）──
      // 目的：QQ 风控掉线后，用户可在面板里用账号密码自助登录，不必找管理员扫码。
      // 安全：**密码明文不出浏览器**（前端算 MD5 后只传 passwordMd5），
      //       整个 /api/snowluma/* 已在 nginx Basic Auth 之后。
      if (pathname === '/api/snowluma/login/info' && method === 'GET') {
        return json(res, 200, napcatWebui.info(snowlumaDir()));
      }

      if (pathname === '/api/snowluma/login/status' && method === 'GET') {
        try {
          const st = await napcatWebui.loginStatus(snowlumaDir());
          const quick = await napcatWebui.quickList(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, status: st, quickList: quick });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/password' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.passwordMd5) return json(res, 400, { ok: false, error: '需要 uin 与 passwordMd5' });
          const r = await napcatWebui.passwordLogin(body.uin, body.passwordMd5, snowlumaDir());
          // 三种结果：直接成功(null) / 需要人机验证 / 需要新设备验证
          return json(res, 200, {
            ok: true,
            needCaptcha: !!(r && r.needCaptcha),
            proofWaterUrl: r?.proofWaterUrl || '',
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/captcha' && method === 'POST') {
        try {
          const body = await readBody(req);
          const need = ['uin', 'passwordMd5', 'ticket', 'randstr'];
          for (const k of need) if (!body?.[k]) return json(res, 400, { ok: false, error: '缺少参数 ' + k });
          const r = await napcatWebui.captchaLogin(body.uin, body.passwordMd5, body.ticket, body.randstr, body.sid, snowlumaDir());
          return json(res, 200, {
            ok: true,
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/new-device' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = await napcatWebui.newDeviceLogin(body.uin, body.passwordMd5, body.newDevicePullQrCodeSig, snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：取二维码（str_url 给手机 QQ 扫）
      if (pathname === '/api/snowluma/login/new-device-qr' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.jumpUrl) return json(res, 400, { ok: false, error: '需要 uin 与 jumpUrl' });
          const r = await napcatWebui.getNewDeviceQr(body.uin, body.jumpUrl, snowlumaDir());
          // 顺手在服务端把 str_url 渲染成二维码 dataURL，前端直接展示
          let qrImage = '';
          try {
            if (r?.str_url) qrImage = await napcatWebui.newDeviceQrDataUrl(r.str_url);
          } catch (e) {
            log('[login] 新设备二维码生成失败:', e?.message ?? e);
          }
          return json(res, 200, { ok: true, qr: r, qrImage });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：轮询状态（3=已扫码 / 1=已确认）
      if (pathname === '/api/snowluma/login/new-device-poll' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.bytesToken) return json(res, 400, { ok: false, error: '需要 uin 与 bytesToken' });
          const r = await napcatWebui.pollNewDeviceQr(body.uin, body.bytesToken, snowlumaDir());
          return json(res, 200, { ok: true, poll: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 设备指纹：查看 / 重置（缓解风控掉线）
      if (pathname === '/api/snowluma/device' && method === 'GET') {
        try {
          const guid = await napcatWebui.getDeviceGuid(snowlumaDir()).catch((e) => ({ error: String(e?.message ?? e) }));
          const backups = await napcatWebui.getGuidBackups(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, guid, backups });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/device/reset' && method === 'POST') {
        try {
          const r = await napcatWebui.resetDeviceId(snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── 账号总览与一键切号（2026-09-16 新增）─────────────────────────────
      // 用户诉求：面板里要能**直接看到后台在线账号并一键切过去**。
      // 原「快速登录」按钮调 SetQuickLoginQQ 只是**设定**、不触发登录，点了没反应（已查明）。
      // 这里改为：透传外部桌面应用已实现好的账号总览与切号能力。
      if (pathname === '/api/accounts/overview' && method === 'GET') {
        try {
          const data = await deskApi('/api/qq/accounts');
          return json(res, 200, { ok: true, data });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/accounts/switch' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.action) return json(res, 400, { ok: false, error: '需要 action' });
          const r = await deskApi('/api/qq/switch', 'POST', body);
          return json(res, 200, r);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/set-quick' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin) return json(res, 400, { ok: false, error: '需要 uin' });
          await napcatWebui.setQuickLogin(body.uin, snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/refresh-qr' && method === 'POST') {
        try {
          await napcatWebui.refreshQr(snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`,
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        // customRules 允许为空
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: p.apiKey || '',
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgNow.api.apiKey || '');
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testModelChat({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: p });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: p });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: visionResults(), scanning: visionScan.running });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      if (pathname === '/api/config' && method === 'GET') {
        return json(res, 200, cfgNow);
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 2000);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: next });
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      // ── 扩展（Skill / Plugin）管理 ──────────────────────────────────
      if (pathname === '/api/skills' && method === 'GET') {
        const context = skillRuntimeContext();
        const installed = new Set(skillManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installed.has(id))
          .map((id) => ({ id, enabled: getConfig().skills?.[id]?.enabled !== false }));
        return json(res, 200, {
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }

      if (pathname === '/api/skills/reload' && method === 'POST') {
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned || [],
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/skills/toggle' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body.id || '').trim();
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        const enabled = body.enabled !== false;
        setSkillEnabled(id, enabled);
        const context = skillRuntimeContext();
        try {
          if (enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        } catch (error) {
          log(`[skill] 切换 ${id} 失败：${error?.message ?? error}`);
        }
        emit('skills-changed', { at: Date.now(), id });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          settings: skillManager.settingsView(id)
        });
      }

      if (pathname === '/api/skills/config' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body.id || '').trim();
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        const skill = skillManager.registry?.get?.(id);
        const allowed = new Set([
          ...Object.keys(skill?.manifest?.settings || {}),
          ...Object.keys(skill?.manifest?.configSchema || {})
        ]);
        const patch = {};
        for (const [k, v] of Object.entries(body.settings || {})) {
          if (!allowed.size || !allowed.has(k)) continue;
          // 密文字段收到掩码或空串 = 不修改
          if (v === '******' || (typeof v === 'string' && v.trim() === '' && /key|token|secret|password|cookie/i.test(k))) continue;
          patch[k] = v;
        }
        if (Object.keys(patch).length) setSkillConfig(id, patch);
        emit('skills-changed', { at: Date.now(), id });
        return json(res, 200, { ok: true, skill: skillManager.status(id, skillRuntimeContext()), settings: skillManager.settingsView(id) });
      }

      // 安装：body { filename, dataBase64, type?: 'skill'|'plugin' }
      if (pathname === '/api/skills/install' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const b64 = String(body.dataBase64 || '').replace(/^data:[^,]*,/, '');
          if (!b64) return json(res, 400, { ok: false, error: '缺少安装包内容（dataBase64）' });
          const buf = Buffer.from(b64, 'base64');
          // 类型判定：显式指定 > 按安装包里的清单自动识别（plugin.json = 确定性型）
          let type = null;
          if (body.type === 'plugin' || body.type === 'skill') {
            type = body.type;
          } else {
            try {
              const entries = validateZipStructure(buf);
              const names = entries.map((e) => e.name);
              const hasPlugin = names.some((n) => /(^|\/)plugin\.json$/i.test(n));
              const hasSkill = names.some((n) => /(^|\/)skill\.json$/i.test(n));
              type = (hasPlugin && !hasSkill) ? 'plugin' : 'skill';
            } catch {
              type = 'skill';   // 结构校验会由 unzipToModuleDir 再抛一次，这里只决定目录
            }
          }
          const dirName = await unzipToModuleDir(buf, { root: ROOT, type, preferId: String(body.id || '') });
          const result = await reloadSkills({ reason: 'install' });
          return json(res, 200, {
            ok: true,
            type,
            dir: `${type === 'plugin' ? 'plugins' : 'skills'}/${dirName}`,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error }))
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 卸载：body { id, deleteFiles?: boolean }
      if (pathname === '/api/skills/uninstall' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body.id || '').trim();
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        const context = skillRuntimeContext();
        try { unloadSkill(id, context); } catch (error) { log(`[skill] 卸载 ${id} 失败：${error?.message ?? error}`); }
        const cfgNow = getConfig();
        if (cfgNow.skills && cfgNow.skills[id]) {
          const next = { ...cfgNow.skills };
          delete next[id];
          updateConfig({ skills: next });
        }
        if (body.deleteFiles !== false) {
          // 只在 skills/ 与 plugins/ 目录下按 manifest id 精确匹配后删除
          for (const root of [SKILL_DIRS.skills, SKILL_DIRS.plugins]) {
            let dirs = [];
            try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
            for (const name of dirs) {
              const dir = path.join(root, name);
              // 清单可能是 skill.json（LLM 型）或 plugin.json（确定性型）
              for (const manifestName of ['skill.json', 'plugin.json']) {
                try {
                  const raw = JSON.parse(fs.readFileSync(path.join(dir, manifestName), 'utf8'));
                  if (String(raw.id || '') !== id) continue;
                  fs.rmSync(dir, { recursive: true, force: true });
                  break;
                } catch { /* 没有这个清单或不是该条目 */ }
              }
            }
          }
        }
        await reloadSkills({ reason: 'uninstall' });
        emit('skills-changed', { at: Date.now(), id });
        return json(res, 200, { ok: true });
      }

      // 工具可用性（UI 排障：为什么这个工具这一轮没给模型）
      if (pathname === '/api/tools' && method === 'GET') {
        const context = skillRuntimeContext();
        const tools = listTools().map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          description: String(t.description || '').slice(0, 160),
          skillId: t.skillId || null,
          builtin: !t.skillId,
          defaultEnabled: t.defaultEnabled !== false,
          override: (getConfig().tools?.overrides?.[t.id] ?? null),
          masterOnly: !!t.masterOnly,
          tutorOnly: KB_TOOL_NAMES.has(t.id),
          requiresVision: !!t.requiresVision,
          requiresSearch: !!t.requiresSearch,
          availability: getToolAvailability(t.id, {
            skills: skillManager,
            toolsCfg: getConfig().tools,
            visionEnabled: context.visionEnabled,
            searchEnabled: context.searchEnabled,
            runtimeContext: context
          })
        }));
        return json(res, 200, {
          tools,
          total: tools.length,
          // 常规可用 = 已启用且不依赖"主人触发/学习模式"这类运行期条件
          available: tools.filter((t) => t.availability.enabled && !t.masterOnly && !t.tutorOnly).length,
          conditional: tools.filter((t) => t.masterOnly || t.tutorOnly).length,
          byCategory: tools.reduce((acc, t) => {
            const k = t.category || 'system';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
          }, {})
        });
      }

      // 单工具开关：写入 config.tools.overrides[id]（true=强制开，false=强制关，不写=默认）
      if (pathname === '/api/tools/toggle' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body.id || '').trim();
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        const def = listTools().find((t) => t.id === id);
        if (!def) return json(res, 404, { ok: false, error: `工具不存在：${id}` });
        const cfgNow = getConfig();
        const overrides = { ...(cfgNow.tools?.overrides || {}), [id]: body.enabled !== false };
        updateConfig({ tools: { ...(cfgNow.tools || {}), overrides } });
        emit('skills-changed', { at: Date.now(), id });
        const context = skillRuntimeContext();
        return json(res, 200, {
          ok: true,
          id,
          availability: getToolAvailability(id, {
            skills: skillManager,
            toolsCfg: getConfig().tools,
            visionEnabled: context.visionEnabled,
            searchEnabled: context.searchEnabled,
            runtimeContext: context
          })
        });
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        return json(res, 200, { chats });
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply
        }));
        return json(res, 200, { chatKey, messages });
      }

      // 联网搜索的 key 状态与设置（key 本身**绝不回传**，只回遮影形态）
      if (pathname === '/api/search-keys' && method === 'GET') {
        try {
          const cfg = getConfig();
          const arr = Array.isArray(cfg.webSearch?.anysearchKeys) ? cfg.webSearch.anysearchKeys : [];
          const envCount = [process.env.ANYSEARCH_API_KEY, process.env.ANYSEARCH_API_KEY_2].filter(Boolean).length;
          return json(res, 200, {
            provider: String(cfg.webSearch?.provider || 'auto'),
            envCount,
            configKeys: arr.map((k) => {
              const s = String(k || '');
              return s ? (s.slice(0, 6) + '****' + s.slice(-4)) : '';
            }),
            configKeyCount: arr.filter((x) => String(x || '').trim()).length,
            total: envCount + arr.filter((x) => String(x || '').trim()).length
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
      // 保存 key：只接受新填入的值（不回显旧的）；传空字符串表示删除该位
      if (pathname === '/api/search-keys' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          if (!Array.isArray(body.keys)) return json(res, 400, { ok: false, error: 'keys 必须是数组' });
          const rawKeys = body.keys.map((k) => String(k ?? '').trim());
          // 判定用户意图：
          //   · 全部为空且显式传了 allowClear → 清空
          //   · 全部为空但没授权清空  → 保留原值（防误点保存把 key 清掉）
          //   · 有新值                → 用新值替换（遮影值 **** 不参与）
          const newOnes = rawKeys.filter((k) => k && !k.includes('****'));
          const hadMasked = rawKeys.some((k) => k.includes('****'));
          const prev = Array.isArray(getConfig().webSearch?.anysearchKeys) ? getConfig().webSearch.anysearchKeys : [];
          let next;
          if (newOnes.length) {
            // 有新填的：替换（若同时含遮影项，说明用户想保留其余，这里简单起见以新值为准）
            next = newOnes;
          } else if (hadMasked) {
            // 只有遮影项 = 用户没改，保持原样
            next = prev;
          } else if (body.allowClear === true) {
            next = [];
          } else {
            next = prev;   // 空提交且未授权清空 → 不动
          }
          updateConfig({ webSearch: { ...(getConfig().webSearch || {}), anysearchKeys: next } });
          return json(res, 200, { ok: true, saved: next.length, unchanged: next === prev });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
      // 能力总览：工具清单 + 关键功能状态（供设置页展示）
      if (pathname === '/api/capabilities' && method === 'GET') {
        try {
          const { buildToolDefs } = await import('./tools.js');
          const defs = buildToolDefs();
          const GROUP_RULES = [
            ['扩展（Skill）', /^[a-zA-Z0-9_-]+__/],
            ['消息与互动', /^(send_message|send_sticker|send_image|send_file|send_poke|receive_file|list_stickers|get_sticker_image|sticker_note|collect_sticker)$/],
            ['信息获取', /^(get_recent_messages|get_active_members|get_message_detail|get_message_images|web_search|web_fetch)$/],
            ['记忆', /^(memory_append|memory_query|memory_remove)$/],
            ['学习/知识库', /^(kb_overview|kb_questions|kb_textbook|kb_progress|study_log)$/],
            ['课表', /^schedule_query$/],
            ['主人专属', /^(dsh_task|teacher_control)$/],
            ['其它', /.*/]
          ];
          const capCtx = skillRuntimeContext();
          const tools = defs.filter((d) => d && (d.id || d.name)).map((d) => {
            const id = d.id || d.name;
            let group = '其它';
            for (const [g, re] of GROUP_RULES) { if (re.test(id)) { group = g; break; } }
            const st = getToolAvailability(id, {
              skills: skillManager,
              toolsCfg: getConfig().tools,
              visionEnabled: capCtx.visionEnabled,
              searchEnabled: capCtx.searchEnabled,
              runtimeContext: capCtx
            });
            return {
              name: id,
              group,
              enabled: st.enabled,
              reason: st.reason || '',
              description: String(d.description || '').slice(0, 200),
              masterOnly: !!d.masterOnly,
              tutorOnly: KB_TOOL_NAMES.has(id),
              params: Object.keys(d.parameters?.properties || {})
            };
          });
          // 关键功能状态
          let schedule = null;
          try {
            const SQ = await import('./schedule-query.js');
            const tmr = SQ.localDate(SQ.shiftDate(1));
            const r = SQ.getDaySchedule(tmr);
            schedule = { ok: !!r.ok, tomorrow: tmr, count: r.count || 0, range: r.range || null };
          } catch (e) { schedule = { ok: false, error: String(e?.message || e) }; }
          const cfg = getConfig();
          // 定时任务摘要
          let scheduled = { count: 0, items: [] };
          try {
            const ST = await import('./scheduled-tasks.js');
            const list = ST.listTasks().filter((t) => t.enabled);
            scheduled = { count: list.length, items: list.slice(0, 8).map((t) => ST.describeTask(t)) };
          } catch (e) { scheduled = { count: 0, items: [], error: String(e?.message || e) }; }
          // 搜索引擎状态
          const hasAnyKey = !!(process.env.ANYSEARCH_API_KEY || process.env.ANYSEARCH_API_KEY_2);
          const searchProvider = String(cfg.webSearch?.provider || 'auto');
          return json(res, 200, {
            tools,
            // total = 常规可用工具数（Skill/开关/vision/搜索都会影响）；注册数另给
            total: tools.filter((t) => t.enabled && !t.masterOnly && !t.tutorOnly).length,
            registered: tools.length,
            features: {
              schedule,
              scheduleNotify: {
                enabled: cfg.scheduleNotify?.enabled !== false,
                time: cfg.scheduleNotify?.time || '21:00'
              },
              identityModes: Object.entries(cfg.identityModes || {}).map(([k, v]) => ({ id: k, label: v?.label || k, enter: v?.enter || [], exit: v?.exit || [] })),
              personaModes: cfg.personaModes || {},
              customPersonas: (cfg.customPersonas || []).map((p) => p.name),
              kb: (() => { try { return fs.existsSync(path.join(DATA_DIR, 'knowledge', 'securities')) ? 'ok' : 'missing'; } catch { return 'unknown'; } })(),
              search: {
                enabled: cfg.webSearch?.enabled !== false,
                provider: searchProvider,
                anysearchAvailable: hasAnyKey,
                effective: searchProvider === 'bing'
                  ? 'Bing 网页抓取'
                  : (searchProvider === 'anysearch'
                    ? (hasAnyKey ? 'AnySearch' : 'AnySearch（未配置 key，会失败）')
                    : (hasAnyKey ? 'AnySearch（失败自动回退 Bing）' : 'Bing（未配置 AnySearch key）'))
              },
              scheduled
            }
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      // 补报 DSH 任务：任务已完成但没汇报时（或通知链路故障后），让机器人现在汇报一次
      if (pathname === '/api/dsh/report' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const workDir = String(body.workDir ?? '').trim();
          const chatKey = String(body.chatKey ?? 'private:123456789').trim();
          if (!workDir) return json(res, 400, { ok: false, error: 'workDir 必填' });
          const fsmod = await import('node:fs');
          const pathmod = await import('node:path');
          if (!fsmod.existsSync(workDir)) return json(res, 404, { ok: false, error: '目录不存在' });
          const items = fsmod.readdirSync(workDir, { withFileTypes: true });
          const files = [];
          for (const it of items) {
            const p = pathmod.join(workDir, it.name);
            if (it.isDirectory()) {
              let n = 0; try { n = fsmod.readdirSync(p).length; } catch {}
              files.push({ name: it.name + '/', size: 0, dir: true, entries: n });
            } else {
              let sz = 0; try { sz = fsmod.statSync(p).size; } catch {}
              files.push({ name: it.name, size: sz, dir: false });
            }
          }
          const real = files.filter((f) => (f.dir ? (f.entries || 0) > 0 : (f.size || 0) > 0));
          let reportFile = '', reportText = '';
          const cand = real.find((f) => !f.dir && /回给主人|汇报|report|summary/i.test(f.name) && /\.(txt|md)$/i.test(f.name));
          if (cand) {
            reportFile = cand.name;
            try { reportText = fsmod.readFileSync(pathmod.join(workDir, cand.name), 'utf8').slice(0, 2500); } catch {}
          }
          orchestrator.wake(chatKey, {
            proactive: true,
            taskContext: {
              kind: 'DSH 后台任务（补报）',
              name: pathmod.basename(workDir),
              taskText: String(body.taskText || '').slice(0, 400),
              workDir, files: real, empty: !real.length,
              reportFile, reportText
            }
          }).catch(() => {});
          return json(res, 200, { ok: true, fileCount: real.length, reportFile });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const ok = orchestrator.forceWake(chatKey);
        return json(res, 200, { ok });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      // ── 课程播报（每晚定时私聊次日课程）──
      // 手动触发一次（忽略时间与幂等；body.dryRun=true 只回文案不发送）
      if (pathname === '/api/schedule-notify/run' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        if (body?.dryRun) {
          const prev = scheduleNotify.configOverride;
          if (body.override && typeof body.override === 'object') {
            scheduleNotify.configOverride = { ...(getConfig().scheduleNotify || {}), ...body.override };
          }
          try {
            const d = scheduleNotify.buildDigestForTomorrow();
            return json(res, 200, {
              ok: true, dryRun: true, forDate: d.date, weekday: d.weekday, count: d.count, text: d.text,
              time: scheduleNotify.time(), chatKey: scheduleNotify.chatKey(), stateFile: scheduleNotify.stateFile()
            });
          } finally { scheduleNotify.configOverride = prev; }
        }
        const r = await scheduleNotify.runNow();
        return json(res, 200, { ok: r.ok, via: r.via, error: r.error, text: r.text, status: scheduleNotify.status() });
      }

      // 播报状态 + 未来 N 天预览（?offset=1 为明天）
      if (pathname === '/api/schedule-notify/status' && method === 'GET') {
        const offset = Number(url.searchParams.get('offset') ?? 1);
        return json(res, 200, { ok: true, status: scheduleNotify.status(), preview: scheduleNotify.preview(offset) });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
          // 恢复时自动补处理暂停期间积压的未读消息
          orchestrator.drainBacklogAfterResume();
        }
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      // 扩展自带控制面板的动作接口：POST /api/plugin-ui/<id>/action
      if (pathname.startsWith('/api/plugin-ui/') && method === 'POST') {
        const m = /^\/api\/plugin-ui\/([^/]+)\/action$/.exec(pathname);
        if (!m) return json(res, 404, { error: '未知接口' });
        const id = decodeURIComponent(m[1]);
        const skill = skillManager.registry?.get?.(id);
        if (!skill || typeof skill.handleUiRequest !== 'function') {
          return json(res, 404, { error: `扩展 ${id} 未提供 UI 接口` });
        }
        const body = await readBody(req).catch(() => ({}));
        try {
          const out = await skill.handleUiRequest({ action: String(body.action || ''), payload: body.payload ?? body });
          return json(res, 200, out ?? { ok: true });
        } catch (error) {
          return json(res, 500, { error: String(error?.message ?? error) });
        }
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // 扩展自带页面：/plugin-ui/<id>/<file> → plugins/<id>/ui/<file>（其次 skills/<id>/ui/）
    if (pathname.startsWith('/plugin-ui/') && req.method === 'GET') {
      const rest = pathname.slice('/plugin-ui/'.length);
      const slash = rest.indexOf('/');
      const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
      const rel = (slash === -1 ? '' : rest.slice(slash + 1)) || 'index.html';
      const types = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
      };
      for (const base of [path.join(ROOT, 'plugins', id, 'ui'), path.join(ROOT, 'skills', id, 'ui')]) {
        const baseAbs = path.resolve(base);
        const full = path.resolve(baseAbs, rel);
        if (full !== baseAbs && !full.startsWith(baseAbs + path.sep)) continue;   // 防路径穿越
        try {
          const data = fs.readFileSync(full);
          res.writeHead(200, { 'content-type': types[path.extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
          res.end(data);
          return;
        } catch { /* 试下一个候选 */ }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('plugin ui not found');
      return;
    }

    // 静态 UI
    if (req.method === 'GET') {
      let file = pathname === '/' ? '/index.html' : pathname;
      file = file.replace(/\.\./g, '');
      const fullPath = path.join(UI_DIR, file);
      if (!fullPath.startsWith(UI_DIR)) { res.writeHead(403); res.end(); return; }
      try {
        let data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        // index.html 里给 app.js / style.css 注入基于 mtime 的版本号，
        // 这样每次更新前端代码后浏览器会自动拉新文件（避免"改了没生效"的缓存问题）
        if (ext === '.html') {
          const stamp = (f) => { try { return Math.floor(fs.statSync(path.join(UI_DIR, f)).mtimeMs).toString(36); } catch { return '0'; } };
          // 用相对路径 + 版本号：
          //   · 浏览器在 /qqbot/ 下访问 './app.js' → 自动解析为 /qqbot/app.js（Nginx 反代正确）
          //   · 本地直连 3210 时解析为 /app.js（也对）
          //   · 这样既拿到缓存失效，又不依赖 Nginx 的 sub_filter 改写
          data = Buffer.from(
            data.toString('utf8')
              .replace('href="/style.css"', 'href="./style.css?v=' + stamp('/style.css') + '"')
              .replace('src="/app.js"', 'src="./app.js?v=' + stamp('/app.js') + '"'),
            'utf8'
          );
        }
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, process.env.QQ_AGENT_HOST || '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 启动账号健康探针（60 秒一次）
    onebotHealth.start();
    qrGuard.start();

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const wsPort = snowlumaWsPort();
        if (!(await isPortOpen('127.0.0.1', wsPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(c.snowluma?.accessToken || '');
      onebot.httpToken = String(c.snowluma?.httpAccessToken || c.snowluma?.accessToken || '');
    }
    await onebot.connect();

    // 扩展加载：skills/（LLM 型，注册工具）+ plugins/（确定性型，能力/钩子）
    try {
      await reloadSkills({ reason: 'boot' });
      const s = skillManager.summary(skillRuntimeContext());
      log(`扩展已加载：${s.total ?? 0} 个（启用 ${s.active ?? 0}，异常 ${s.broken ?? 0}）`
        + (s.failed ? `，失败 ${s.failed}` : ''));
    } catch (error) {
      log(`[skill] 加载失败：${error?.message ?? error}`);
    }

    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startDshWatcher(); // DSH 任务完成汇报 watcher
    if (getConfig().scheduleNotify?.enabled !== false) scheduleNotify.start();   // 每晚课程播报调度器
    scheduledRunner.start();   // 通用定时任务调度器
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    onebotHealth.stop();
    qrGuard.stop();
    scheduleNotify.stop();
    await orchestrator.abortAll();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, scheduleNotify, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus, onebotHealth, qrGuard, reloadSkills, skillManager };
}
