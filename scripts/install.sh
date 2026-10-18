#!/usr/bin/env bash
# qq-agent 一键部署（Ubuntu / Debian，x86_64）
#
# 做四件事：
#   1. 装系统依赖（xvfb、QQ 需要的 GUI 库、中文字体）
#   2. 装 LinuxQQ + NapCat Shell（解压式，rootless，落在 $NAPCAT_DIR）
#   3. 装 qq-agent 依赖并写默认配置（指向本机 NapCat）
#   4. 可选写 systemd 服务并启动（--systemd）
#
# 用法：
#   bash scripts/install.sh                 # 装到当前目录已有代码
#   bash scripts/install.sh --systemd       # 额外注册 systemd（需 sudo）
#   APP_DIR=~/qq-agent NAPCAT_DIR=~/napcat bash scripts/install.sh
#
# 环境变量：
#   APP_DIR      qq-agent 代码目录（默认：脚本所在仓库根目录）
#   NAPCAT_DIR   NapCat/LinuxQQ 安装目录（默认 $HOME/napcat）
#   GH_PROXY     GitHub 下载代理（默认 https://gh-proxy.com）
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NAPCAT_DIR="${NAPCAT_DIR:-$HOME/napcat}"
QQ_DIR="$NAPCAT_DIR/opt/QQ"
NAPCAT_APP="$QQ_DIR/resources/app/app_launcher/napcat"
GH_PROXY="${GH_PROXY:-https://gh-proxy.com}"
NAPCAT_VERSION="${NAPCAT_VERSION:-v4.18.38}"
QQ_DEB_URL="${QQ_DEB_URL:-https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_amd64.deb}"

USE_SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --systemd) USE_SYSTEMD=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg"; exit 1 ;;
  esac
done

log() { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

# ── 1. 系统依赖 ────────────────────────────────────────────────
log "安装系统依赖（需要 sudo）"
if command -v apt-get >/dev/null; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    curl ca-certificates jq unzip xvfb xauth \
    libnss3 libgbm1 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libxrender1 libxtst6 libxss1 libdrm2 libdbus-1-3 \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgtk-3-0t64 \
    libgdk-pixbuf-2.0-0 libx11-xcb1 libxcb-dri3-0 libxcb-present0 \
    libxcb-sync1 libxshmfence1 libatspi2.0-0t64 \
    fonts-wqy-zenhei fonts-noto-cjk
else
  warn "当前不是 apt 系发行版，请手动安装：xvfb、libgbm1、libasound2、libatk、libcairo2、libgtk-3、中文字体"
fi

# ── 2. LinuxQQ + NapCat ───────────────────────────────────────
if [ ! -x "$QQ_DIR/qq" ]; then
  log "下载 LinuxQQ"
  tmp_qq="$(mktemp -d)"
  curl -fL --retry 3 "$QQ_DEB_URL" -o "$tmp_qq/QQ.deb"
  mkdir -p "$NAPCAT_DIR"
  dpkg -x "$tmp_qq/QQ.deb" "$NAPCAT_DIR"
  rm -rf "$tmp_qq"
else
  log "LinuxQQ 已存在，跳过下载：$QQ_DIR"
fi

if [ ! -f "$NAPCAT_APP/napcat.mjs" ]; then
  log "下载 NapCat Shell $NAPCAT_VERSION"
  tmp_cat="$(mktemp -d)"
  url="https://github.com/NapNeko/NapCatQQ/releases/download/$NAPCAT_VERSION/NapCat.Shell.zip"
  if ! curl -fL --retry 2 --max-time 300 "$url" -o "$tmp_cat/napcat.zip"; then
    warn "GitHub 直连失败，改用代理：$GH_PROXY"
    curl -fL --retry 3 --max-time 600 "$GH_PROXY/$url" -o "$tmp_cat/napcat.zip"
  fi
  mkdir -p "$NAPCAT_APP"
  unzip -q "$tmp_cat/napcat.zip" -d "$NAPCAT_APP"
  rm -rf "$tmp_cat"
else
  log "NapCat 已存在，跳过下载：$NAPCAT_APP"
fi

log "注入 NapCat 启动脚本"
cat > "$QQ_DIR/resources/app/loadNapCat.js" <<'JS'
const path = require('node:path');
const { pathToFileURL } = require('node:url');
import(pathToFileURL(path.join(__dirname, 'app_launcher/napcat/napcat.mjs')).href);
JS
jq '.main = "./loadNapCat.js"' "$QQ_DIR/resources/app/package.json" > "$QQ_DIR/resources/app/package.json.tmp"
mv "$QQ_DIR/resources/app/package.json.tmp" "$QQ_DIR/resources/app/package.json"

# OneBot v11：本机 WS 3001 / HTTP 3000（qq-agent 默认就连这里）
if [ ! -f "$NAPCAT_APP/config/onebot11.json" ]; then
  log "写入 OneBot 配置"
  cat > "$NAPCAT_APP/config/onebot11.json" <<'JSON'
{
  "network": {
    "httpServers": [{ "name": "qq-agent-http", "enable": true, "host": "127.0.0.1", "port": 3000,
      "enableCors": true, "enableWebsocket": false, "messagePostFormat": "array", "token": "" }],
    "httpClients": [],
    "websocketServers": [{ "name": "qq-agent-ws", "enable": true, "host": "127.0.0.1", "port": 3001,
      "messagePostFormat": "array", "reportSelfMessage": false, "token": "", "enableForcePushEvent": true }],
    "websocketClients": []
  },
  "musicSignServerUrl": "",
  "token": "",
  "enableLocalFile2Url": false,
  "log": false
}
JSON
fi

# ── 3. qq-agent ───────────────────────────────────────────────
log "安装 qq-agent 依赖：$APP_DIR"
cd "$APP_DIR"
if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

if [ ! -f data/config.json ]; then
  log "生成 data/config.json"
  cp data/config.example.json data/config.json
  jq --arg d "$NAPCAT_APP" '.snowluma.dir = $d' data/config.json > data/config.json.tmp
  mv data/config.json.tmp data/config.json
fi

# ── 4. 启动 ───────────────────────────────────────────────────
start_napcat_cmd="cd '$QQ_DIR' && xvfb-run -a -s '-screen 0 1280x800x24' ./qq --no-sandbox"

if [ "$USE_SYSTEMD" = "1" ]; then
  log "注册 systemd 服务"
  sudo tee /etc/systemd/system/napcat.service >/dev/null <<EOF
[Unit]
Description=NapCat (LinuxQQ headless + OneBot v11)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
Environment=HOME=$HOME
Environment=TZ=Asia/Shanghai
WorkingDirectory=$QQ_DIR
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x800x24" $QQ_DIR/qq --no-sandbox
Restart=always
RestartSec=8

[Install]
WantedBy=multi-user.target
EOF
  sudo tee /etc/systemd/system/qq-agent.service >/dev/null <<EOF
[Unit]
Description=qq-agent console
After=network-online.target napcat.service

[Service]
Type=simple
User=$USER
Environment=HOME=$HOME
Environment=TZ=Asia/Shanghai
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now napcat qq-agent
  log "服务已启动：systemctl status napcat qq-agent"
else
  log "后台启动（未注册 systemd）"
  ( cd "$QQ_DIR" && setsid nohup xvfb-run -a -s "-screen 0 1280x800x24" ./qq --no-sandbox > "$HOME/napcat.log" 2>&1 & )
  ( cd "$APP_DIR" && setsid nohup node src/server.js > "$HOME/qq-agent.log" 2>&1 & )
  log "日志：$HOME/napcat.log / $HOME/qq-agent.log"
fi

echo
log "完成。下一步："
echo "  1) 等 10~20 秒，扫码登录二维码：$NAPCAT_APP/cache/qrcode.png"
echo "  2) 打开控制台：http://127.0.0.1:3210 （远端请用 ssh -L 3210:127.0.0.1:3210 转发）"
echo "  3) 设置页填 OpenAI 兼容 API 的 baseUrl / key / 模型，点「测试一下」"
echo "  4) 扫码后到「设置 → 白名单」勾选群，再发条测试消息验证"
