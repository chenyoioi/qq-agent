// OpenAI 兼容 Chat Completions 客户端（非流式；QQ 本身不支持流式，没必要）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { getConfig } from './config.js';
import { skillManager } from './skills/manager.js';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

// 网关类状态码的人话解释：这类码几乎都不是"你配错了"，而是中转站/上游挂了。
// 写进错误文本，用户和日志一眼能看懂，不用去查 554 是什么。
const GATEWAY_CODES = {
  502: '中转站网关 502：上游模型不可用',
  503: '服务暂时不可用（上游过载/维护）',
  504: '上游模型响应超时',
  520: 'CDN 未知错误（源站异常）',
  521: 'CDN 源站已关闭',
  522: 'CDN 连接源站超时',
  523: 'CDN 源站不可达',
  524: 'CDN 等待源站响应超时',
  525: 'CDN 与源站 TLS 握手失败',
  526: 'CDN 源站证书无效',
  527: 'CDN 与源站连接被中断',
  554: '上游/网关异常（中转站返回的非标准码，通常是上游节点失败或被限流）'
};

function gatewayHint(status, body = '') {
  const code = Number(status) || 0;
  const known = GATEWAY_CODES[code];
  if (!known) return '';
  // 中转站自己已经给出 code/message 时优先展示它的原文
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = [j.code, j.message].filter(Boolean).join(' · ');
  } catch { /* 不是 JSON 就算了 */ }
  return `（${known}${detail ? `；服务端说明：${String(detail).slice(0, 120)}` : ''}。这类错误与你的 Key/地址无关，重试或换模型/换提供商）`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 */
export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, maxTokens = null, signal = null, ctx = null, skillContext = null }) {
  // skillContext 是部分插件（bili-browse 等）沿用的旧写法，语义等同 ctx：
  // 里面装的是本次调用的 api/model/messages 等上下文，供 llm.* 能力链读取。
  const context = ctx || skillContext || null;
  const cfg = getConfig().api;
  const body = {
    model: cfg.model,
    messages,
    stream: false
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  const temp = temperature === null ? (cfg.temperature ?? 0.8) : temperature;
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);
  // 调用方可以只要一句话（插件做"锐评"这类短输出时用），不传就不加这个字段
  if (maxTokens !== null && maxTokens !== undefined && Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    body.max_tokens = Math.round(Number(maxTokens));
  }

  // 扩展提供的请求参数转换（llm.request-params）：插件可按会话改写 tools/参数。
  // 串行执行，后者能看到前者的输出；单个插件抛错只记录，不影响请求。
  let finalBody = body;
  for (const fn of skillManager.getRequestTransforms(context || {})) {
    try {
      const next = await fn({ body: finalBody, api: cfg, model: cfg.model, messages, tools, temperature: temp, context: context || {} });
      if (next && typeof next === 'object') finalBody = next.body || next;
    } catch (error) {
      skillManager.recordError('llm.request-params', error);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(5000, Number(cfg.timeoutMs) || 180000));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  }

  let res;
  // 主模型失败（503/429/5xx/网络/超时）时按顺序切备用模型重试一次。
  // 备用列表来自 config.api.fallbackModels；为空时行为和以前完全一致。
  const tryModels = [cfg.model, ...(Array.isArray(cfg.fallbackModels) ? cfg.fallbackModels : [])]
    .map((m) => String(m || '').trim()).filter(Boolean);
  res = null;
  let lastError = null;
  for (const model of tryModels) {
    try {
      res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(cfg.apiKey) },
        body: JSON.stringify({ ...finalBody, model }),
        signal: controller.signal
      });
    } catch (error) {
      res = null;
      if (error?.name === 'AbortError') {
        clearTimeout(timer);
        throw new Error(`模型请求超时（${cfg.timeoutMs}ms）`);
      }
      lastError = new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
      continue;
    }
    if (res.ok) { finalBody = { ...finalBody, model }; break; }
    const text = await res.text().catch(() => '');
    lastError = new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}${gatewayHint(res.status, text)}`);
    // 5xx 一律可重试：中转站/CDN 会吐 520~527、554 这类非标准网关码，
    // 以前只认 500/502/503/504，碰上 554 就直接判死，备用模型完全没机会上场。
    if (!(res.status >= 500 || [408, 409, 425, 429].includes(res.status))) break;
    if (tryModels.indexOf(model) < tryModels.length - 1) {
      console.warn(`[llm] ${model} 返回 ${res.status}，换备用模型重试`);
    }
  }
  clearTimeout(timer);
  if (!res || !res.ok) throw lastError ?? new Error('模型请求失败');
  const data = await res.json().catch(() => { throw new Error('模型 API 返回了无法解析的 JSON'); });
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
  const result = {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? cfg.model,
    raw: data
  };

  // 扩展响应/用量转换（llm.response / llm.usage）：错误隔离，失败不影响主流程
  if (context) {
    for (const fn of skillManager.getResponseTransforms(context)) {
      try {
        const next = await fn({ result, ...context });
        if (next && typeof next === 'object' && next.result) Object.assign(result, next.result);
      } catch (error) {
        skillManager.recordError('llm.response', error);
      }
    }
    const extra = {};
    let hasExtra = false;
    for (const fn of skillManager.getUsageTransforms(context)) {
      try {
        const add = await fn({ result, usage: result.usage, ...context });
        if (add && typeof add === 'object') {
          for (const [k, v] of Object.entries(add)) {
            const n = Number(v) || 0;
            if (n) { extra[k] = (extra[k] || 0) + n; hasExtra = true; }
          }
        }
      } catch (error) {
        skillManager.recordError('llm.usage', error);
      }
    }
    if (hasExtra) result.extraUsage = extra;
  }
  return result;
}

/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = getConfig().api;
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/** 累加 usage。 */
export function addUsage(target, usage) {
  if (!usage) return target;
  target.promptTokens += Number(usage.prompt_tokens) || 0;
  target.completionTokens += Number(usage.completion_tokens) || 0;
  target.totalTokens += Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
}

/** 按配置单价折算成本（元）。 */
export function estimateCost(usage) {
  const cfg = getConfig().api;
  const cost = (usage.promptTokens / 1e6) * (Number(cfg.priceInputPerM) || 0)
    + (usage.completionTokens / 1e6) * (Number(cfg.priceOutputPerM) || 0);
  return Math.round(cost * 1e4) / 1e4;
}
