// 把 NapCat 的 cache/qrcode.png 放大后同步到稳定路径，便于扫码。
// NapCat 每约 2 分钟重写一次 qrcode.png，这里监视 mtime 变化后重新放大。
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const SRC = process.env.NAPCAT_QR_PATH
  || '/root/napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png';
const OUT = process.env.QR_OUT || '/root/qq-agent/data/napcat-qrcode.png';
const SCALE = Number(process.env.QR_SCALE || 4);

function upscale(srcBuf, scale) {
  const png = PNG.sync.read(srcBuf);
  const out = new PNG({ width: png.width * scale, height: png.height * scale });
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < out.width; x++) {
      const sx = Math.floor(x / scale);
      const si = (png.width * sy + sx) << 2;
      const di = (out.width * y + x) << 2;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return PNG.sync.write(out, { colorType: 0 });
}

let lastMtime = 0;
function check() {
  try {
    const st = fs.statSync(SRC);
    if (st.size === 0 || st.mtimeMs === lastMtime) return;
    lastMtime = st.mtimeMs;
    fs.writeFileSync(OUT, upscale(fs.readFileSync(SRC), SCALE));
    console.log(new Date().toISOString(), 'QR 已更新 ->', OUT);
  } catch { /* 未登录/文件不存在时忽略 */ }
}

check();
setInterval(check, 2000);
