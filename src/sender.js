// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';

/**
 * 本地路径 → file:// URI（插件常用）。
 * NapCat 对 file:/// 与裸路径都认，但显式 URI 更稳，且能处理 Windows 盘符与空格。
 */
export function toFileUri(filePath) {
  const p = String(filePath ?? '').trim();
  if (!p) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p; // 已经是 URI
  const normalized = p.replace(/\\/g, '/');
  // encodeURI 保留 / 和 :（Windows 盘符要保住冒号），只转空格等特殊字符
  const encoded = encodeURI(normalized);
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * 清掉模型把“工具调用协议”当正文吐出来的残渣。
 * DeepSeek 系模型偶尔输出 `<｜｜DSML｜｜ calls> ...` 这类全角标记，
 * 中文正则/HTML 清洗都拦不住（以 ｜ 开头），发到群里就是一串英文乱码。
 */
export function stripToolMarkup(text) {
  let t = String(text ?? '');
  t = t.replace(/<[｜|]{1,2}[\s\S]*?(?:>|$)/g, '');        // <｜｜DSML｜｜ ...>
  t = t.replace(/<\/?[｜|][\s\S]*$/g, '');                 // 收尾半截 </｜｜DSML
  t = t.replace(/<\|[^>\n]{0,200}(?:>|$)/g, '');           // <|...|>
  t = t.replace(/(?:^|\n)\s*(?:calls?|invoke|parameter)\b[^\n]*/gi, ''); // 剥剩下的裸协议行
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class SendQueue {
  constructor({ onebot, store, onSent = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.rateBypass = new Map();  // chatKey -> 截止时间戳（主人触发的那一轮免限流）
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  /** 让某个会话在接下来一段时间内不受发送限流限制（主人发言时用）。 */
  allowRateBypass(chatKey, ms = 90000) {
    const until = Date.now() + Math.max(1000, Number(ms) || 90000);
    this.rateBypass.set(String(chatKey), until);
    return until;
  }

  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    const maxMin = Number(cfg.maxPerMinute) || 0;
    const maxHour = Number(cfg.maxPerHour) || 0;
    if (maxMin <= 0 && maxHour <= 0) return;   // 0/缺省 = 不限速（主人已取消频率限制）
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    const bypass = (this.rateBypass.get(String(chatKey)) || 0) > now;
    if (maxMin > 0 && minute.length >= maxMin && !bypass) {
      throw new Error(`发送频率超限（每分钟最多 ${maxMin} 条），请等一会再发`);
    }
    if (maxHour > 0 && hour.length >= maxHour && !bypass) {
      throw new Error(`发送频率超限（每小时最多 ${maxHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  /**
   * 只读检查：这个会话现在还能不能发消息（不占用额度、不写任何状态）。
   *
   * 供 Skill 的 `chat.quota-gate` 在**请求模型之前**判断"这一轮发得出去吗"——
   * 发不出去就别问模型，省掉"想完了却被限流挡回来"的纯浪费。
   * 真正扣额度的仍然是发送那一刻的 #checkRate，所以先问后发不会重复计数。
   */
  canSend(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send || {};
    const maxMin = Number(cfg.maxPerMinute) || 0;
    const maxHour = Number(cfg.maxPerHour) || 0;
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    if (maxMin > 0 && minute.length >= maxMin) {
      return {
        ok: false,
        code: 'minute-limit',
        reason: `发送频率已达上限（每分钟最多 ${maxMin} 条）`,
        remainingMinute: 0,
        remainingHour: maxHour > 0 ? Math.max(0, maxHour - hour.length) : null
      };
    }
    if (maxHour > 0 && hour.length >= maxHour) {
      return {
        ok: false,
        code: 'hour-limit',
        reason: `发送频率已达上限（每小时最多 ${maxHour} 条）`,
        remainingMinute: maxMin > 0 ? Math.max(0, maxMin - minute.length) : null,
        remainingHour: 0
      };
    }
    return {
      ok: true,
      code: null,
      reason: '',
      remainingMinute: maxMin > 0 ? Math.max(0, maxMin - minute.length) : null,
      remainingHour: maxHour > 0 ? Math.max(0, maxHour - hour.length) : null
    };
  }

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of list) {
      // 只要夹带工具协议标记（<｜…> / <|…|>），整条丢弃：这类内容不是给人看的，
      // 拆出半截（比如参数里的 "10"）反而更怪。
      if (/<[｜|]/.test(String(m ?? ''))) {
        console.warn('[sender] 已丢弃一条含工具协议残渣的消息');
        continue;
      }
      let plain = stripToolMarkup(mdToPlain(String(m ?? '')));
      if (!plain) continue;
      // 统一清洗模型偶尔夹带的 XML 工具调用残留（</parameter></invoke></tool_calls> 等）
      plain = plain
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/<\/?parameter>|<\/?invoke>|<\/?tool_calls>|<\/?function_calls>|<\/?search_attempts>/gi, '')
        .replace(/^\s*<\/?[a-zA-Z]+/gm, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!plain) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      // 间隔应该发生在"两条之间"：第一条立刻发（用户等待的是首字），
      // 后续每条才按真人节奏停顿。旧写法把 gap 算给了第一条、最后一条反而 0，
      // 表现是"先等 25~45 秒，然后两条一口气蹦出来"。
      const gap = i === 0 ? 0 : this.#gap(text, false);
      promises.push(chain(async () => {
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        const data = await this.onebot.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        });
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text, ts });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') sent.push(r.value);
      else failed.push({ error: String(r.reason?.message ?? r.reason) });
    }
    if (sent.length === 0 && failed.length > 0) {
      throw new Error(failed.map((f) => f.error).join('；'));
    }
    return { sent, failed };
  }

  /** 上传文件到当前会话（产物交付用）。 */
  sendFile(chatKey, filePath, fileName) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      const data = await this.onebot.sendFile(kind, id, filePath, fileName);
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[文件:${fileName || String(filePath).split('/').pop()}]`, ts });
      this.onSent?.({ chatKey, text: '[文件]', messageId: data?.file_id ?? null });
      return data;
    });
  }

  /** 发送一张任意图片（独立气泡，URL 或本地路径）。 */
  sendImage(chatKey, imageUrl, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    // 插件（whale-memes / reply-meme）传的是 { file: '/abs/path.webp' }，
    // 早期核心只接受字符串，String(对象) 会变成 "[object Object]" → NapCat 报
    // “文件处理失败: 识别URL失败”。这里统一拆包，字符串/对象都支持。
    const picked = (imageUrl && typeof imageUrl === 'object')
      ? (imageUrl.file || imageUrl.url || imageUrl.path || '')
      : imageUrl;
    const src = String(picked ?? '').trim();
    if (!src) throw new Error('sendImage 需要一个图片地址或 { file } 对象');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(500, 1200));
      const data = await this.onebot.sendImage(kind, id, src, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[图片:${src.split('/').pop().slice(0, 60)}]`, ts });
      this.onSent?.({ chatKey, text: '[图片]', messageId: data?.message_id ?? null });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 发送任意消息段（语音/视频/自定义组合）。
   * 插件（如 voxcpm-voice）用 ctx.sender.sendMedia(chatKey, [{type:'record',data:{file}}], {label})
   * 走同一条队列：串行、限频、留档。
   */
  sendMedia(chatKey, segments, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const list = Array.isArray(segments) ? segments.filter(Boolean) : [segments].filter(Boolean);
    if (!list.length) throw new Error('sendMedia 需要至少一个消息段');
    // 本地绝对路径统一补 file://，NapCat 对 file:// 和裸路径都认，但显式一点更稳
    const normalized = list.map((seg) => {
      const file = seg?.data?.file;
      if (typeof file === 'string' && file.startsWith('/') && ['record', 'image', 'video'].includes(seg.type)) {
        return { ...seg, data: { ...seg.data, file: `file://${file}` } };
      }
      return seg;
    });
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1200));
      const data = await this.onebot.sendSegments(kind, id, normalized);
      const label = String(options.label || '[媒体]');
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: label, ts });
      this.onSent?.({ chatKey, text: label, messageId: data?.message_id ?? null });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const data = await this.onebot.sendSticker(kind, id, sticker.url, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      await sleep(randInt(300, 900));
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }
}
