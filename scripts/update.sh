#!/usr/bin/env bash
# 把本机部署更新到远端最新版（origin/main）并重启服务。
#
#   bash scripts/update.sh
#
# 说明：
#   · 用 fetch + reset --hard，不依赖本地有无改动（这是部署机，不是开发机）；
#   · 只覆盖 git 跟踪的文件；data/、skills/、plugins/ 里的未跟踪内容原样保留；
#   · 更新后跑一次扩展重载与健康检查，失败会打印日志位置。
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-qq-agent}"
CONSOLE="${CONSOLE:-http://127.0.0.1:3210}"

log() { printf '\033[1;34m==> %s\033[0m\n' "$*"; }

cd "$APP_DIR"
before="$(git rev-parse --short HEAD)"

log "拉取 origin/$BRANCH"
git fetch --prune origin
git reset --hard "origin/$BRANCH"
after="$(git rev-parse --short HEAD)"

if [ "$before" = "$after" ]; then
  log "已是最新（$after），仍继续依赖检查与服务重启"
else
  log "代码更新：$before → $after"
  git --no-pager log --oneline "$before..$after" | sed 's/^/    /'
fi

log "同步依赖"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

log "重启服务：$SERVICE"
if command -v systemctl >/dev/null && systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  systemctl restart "$SERVICE"
else
  pkill -f "node .*src/server.js" 2>/dev/null || true
  ( setsid nohup node src/server.js > "$HOME/qq-agent.log" 2>&1 & )
fi

log "健康检查"
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "$CONSOLE/api/status" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if curl -fsS --max-time 3 "$CONSOLE/api/status" >/dev/null 2>&1; then
  ext=$(curl -fsS --max-time 5 "$CONSOLE/api/skills" | jq -r '.summary | "扩展 \(.total) 个（启用 \(.active)，异常 \(.broken)）"' 2>/dev/null || echo "扩展状态未知")
  log "OK：$CONSOLE · $ext"
else
  echo "控制台未就绪，最近日志：" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager 2>/dev/null || tail -30 "$HOME/qq-agent.log" 2>/dev/null || true
  exit 1
fi
