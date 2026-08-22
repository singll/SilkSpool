#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent SQLite 一致性快照备份（P0-5：DB down 紧急恢复 + 集中存储归宿）
# 由 silksec-backup.timer 定时触发，幂等。
# VACUUM INTO 生成一致性快照（含已提交 WAL 帧、不阻塞在线写入），保留最近 N 份；
# 可选 rsync 推送到集中存储（silkdata / TrueNAS NFS 挂载点）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
DB_FILE="$DATA_DIR/asset-graph.db"
BACKUP_DIR="${SEC_BACKUP_DIR:-$DATA_DIR/backups}"
KEEP="${SEC_BACKUP_KEEP:-14}"
REMOTE="${SEC_BACKUP_REMOTE:-}"   # 可选 rsync 目标（如 silkspool@192.168.7.231:/path/ 或本地 NFS 挂载点）；空=仅本地

log() { echo "[backup] $*"; }

mkdir -p "$BACKUP_DIR"
[ -f "$DB_FILE" ] || { log "库不存在，跳过：$DB_FILE"; exit 0; }

ts=$(date +%Y%m%d-%H%M%S)
snap="$BACKUP_DIR/asset-graph.$ts.db"

# VACUUM INTO：一致性快照，不阻塞在线写入；失败回退 .backup
if sqlite3 "$DB_FILE" "VACUUM INTO '$snap'" 2>/dev/null; then
    sz=$(stat -c%s "$snap" 2>/dev/null || echo 0)
    log "快照生成 $snap ($sz bytes)"
else
    log "VACUUM INTO 失败，回退 .backup"
    sqlite3 "$DB_FILE" ".backup '$snap'"
fi

# 保留最近 KEEP 份
ls -1t "$BACKUP_DIR"/asset-graph.*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" && log "清理旧快照 $old"
done

# 可选：推送到集中存储
if [ -n "$REMOTE" ]; then
    if rsync -a "$snap" "$REMOTE" 2>/dev/null; then
        log "已推送到集中存储 $REMOTE"
    else
        log "推送集中存储失败（$REMOTE），本地快照仍保留"
    fi
fi

log "backup 完成"
