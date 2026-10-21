#!/usr/bin/env bash
# 每日备份 data/（配置、消息、会话、记忆、额度账本）+ 扩展目录，保留最近 N 份。
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
out="$DEST/backup-$ts.tgz"

# 排除可重建的缓存（表情图库索引、二维码），其余全备。
# 扩展目录（plugins/ skills/）**不在 git 里**，备份也必须带上 —— 否则机器挂了
# 官网装的插件/技能就彻底没了（它们跟 data/ 一样只存在于这台机器上）。
tar czf "$out" \
  --exclude='data/whale-memes' \
  --exclude='data/gallery-mirror' \
  --exclude='data/napcat-qrcode.png' \
  --exclude='plugins/*/node_modules' \
  --exclude='skills/*/node_modules' \
  -C "$APP_DIR" data plugins skills

chmod 600 "$out"
echo "已备份：$out（$(du -h "$out" | cut -f1)）"

# 只保留最近 KEEP 份（连旧命名的 data-*.tgz 一起轮转，避免升级后旧备份永远留着）
ls -1t "$DEST"/backup-*.tgz "$DEST"/data-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f -- "$old"
  echo "已清理旧备份：$old"
done
