#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent SQLite 紧急恢复（P0-5：库损坏/锁死时从最近快照恢复）
# 用法：silksec-restore.sh [快照文件]     # 不传则取 backups/ 最新一份
# 停服务 → 现库改名留存（便于取证）→ 清 WAL/SHM → 替换 → 起服务。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
DB_FILE="$DATA_DIR/asset-graph.db"
BACKUP_DIR="${SEC_BACKUP_DIR:-$DATA_DIR/backups}"
SERVICE="silksecagent"

log() { echo "[restore] $*"; }

snap="${1:-$(ls -1t "$BACKUP_DIR"/asset-graph.*.db 2>/dev/null | head -1)}"
[ -n "$snap" ] && [ -f "$snap" ] || { log "无可用快照：$BACKUP_DIR"; exit 1; }

log "将从快照恢复：$snap"
sudo systemctl stop "$SERVICE" 2>/dev/null || true
sleep 2

# 现库改名留存（不覆盖，便于事后取证）+ 清残留 WAL/SHM（避免与恢复库不一致）
if [ -f "$DB_FILE" ]; then
    mv "$DB_FILE" "$DB_FILE.corrupt-$(date +%Y%m%d-%H%M%S)" || true
fi
rm -f "$DB_FILE-wal" "$DB_FILE-shm"
cp "$snap" "$DB_FILE"
chown silkspool:silkspool "$DB_FILE" 2>/dev/null || true

sudo systemctl start "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
    log "恢复完成，服务已启动（源快照 $snap）"
else
    log "服务启动失败，请检查 journalctl -u $SERVICE"
    exit 1
fi
