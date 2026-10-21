const ALLOWED_HOSTS = new Set(['aigengtu.com', 'img.aigengtu.com']);
// 本地图库镜像（scripts/mirror-gallery.mjs 生成，由控制台 /gallery/* 提供）。
// 镜像里的条目带本地 url，优先用它：远程 CDN 在部分网络下会超时/被墙，
// 而图其实已经镜像到本机了。
const LOCAL_MIRROR_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):3210\/gallery\/[\w./-]+$/;

export function trustedUrl(value) {
  // 先认本地镜像：只允许本机 3210 的 /gallery/ 路径，避免变成"能读本机任意端口"
  if (LOCAL_MIRROR_RE.test(String(value ?? ''))) {
    const u = new URL(value);
    if (!u.search && !u.hash) return u.href;
  }
  const u = new URL(value, 'https://aigengtu.com/');
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) {
    throw new Error('图源地址不在 aigengtu.com 白名单内');
  }
  return u.href;
}

// Host api.fetch remains the only network entry point, preserving web_fetch permissions.
// Check each redirect before fetching it, and limit streamed bytes as well as Content-Length.
export async function readBytes(httpFetch, value, { timeoutMs = 15000, maxBytes = 12 * 1024 * 1024, accept = '*/*' } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('图源请求超时')); }, timeoutMs);
  });
  const job = async () => {
    let url = trustedUrl(value);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await httpFetch(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: accept, 'User-Agent': 'reply-meme/1.0 (+https://aigengtu.com/)', Referer: 'https://aigengtu.com/' }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        try { await response.body?.cancel?.(); } catch { /* already consumed */ }
        if (!location) throw new Error('图源跳转缺少地址');
        url = trustedUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* no body */ }
        throw new Error(`图源 HTTP ${response.status}`);
      }
      // Also validate final URL for host wrappers that ignore redirect:manual.
      if (response.url) trustedUrl(response.url);
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared > maxBytes) {
        controller.abort();
        throw new Error('图源文件超过大小限制');
      }
      let buffer;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            size += chunk.byteLength;
            if (size > maxBytes) { controller.abort(); throw new Error('图源文件超过大小限制'); }
            chunks.push(Buffer.from(chunk));
          }
          buffer = Buffer.concat(chunks, size);
        } finally {
          try { await reader.cancel(); } catch { /* already closed */ }
          reader.releaseLock();
        }
      } else {
        // Same fallback interface as the supplied package's api.fetch wrapper.
        buffer = Buffer.from(await response.arrayBuffer());
      }
      if (!buffer.length || buffer.length > maxBytes) throw new Error('图源文件为空或超过大小限制');
      return buffer;
    }
    throw new Error('图源跳转次数过多');
  };
  try { return await Promise.race([job(), timeout]); }
  finally { clearTimeout(timer); }
}
