#!/usr/bin/env bash
# 每日备份 data/（配置、消息、会话、记忆、额度账本），保留最近 N 份。
#   bash scripts/backup.sh
# 环境变量：BACKUP_DIR（默认 /root/qq-agent-backups）、KEEP（默认 7）
#
# 注意：备份里含 data/config.json（模型 Key），目录权限设为 700，别随手拷走。
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEST="${BACKUP_DIR:-/root/qq-agent-backups}"
KEEP="${KEEP:-7}"

mkdir -p "$DEST"
chmod 700 "$DEST"

ts="$(date +%Y%m%d-%H%M%S)"
out="$DEST/data-$ts.tgz"

# 排除可重建的缓存（表情图库索引、二维码），其余全备
tar czf "$out" \
  --exclude='data/whale-memes' \
  --exclude='data/gallery-mirror' \
  --exclude='data/napcat-qrcode.png' \
  -C "$APP_DIR" data

chmod 600 "$out"
echo "已备份：$out（$(du -h "$out" | cut -f1)）"

# 只保留最近 KEEP 份
ls -1t "$DEST"/data-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f -- "$old"
  echo "已清理旧备份：$old"
done
