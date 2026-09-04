#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 数据保留期清理（审计 S7 / output-retention 等价）
# 由 silksec-retention.timer 每日触发，幂等。
# 默认：flows 保留 30 天、results 保留 30 天、audit.jsonl 超 50MB 轮转。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
FLOWS_DIR="$DATA_DIR/flows"
RESULTS_DIR="$DATA_DIR/results"
AUDIT_LOG="$DATA_DIR/audit.jsonl"
DATASNAP_DIR="$BASE_DIR/backups/datasnap"
IMPORT_STAGING_DIR="$DATA_DIR/import-staging"

RETENTION_DAYS="${SEC_RETENTION_DAYS:-30}"
AUDIT_MAX_BYTES="${SEC_AUDIT_MAX_BYTES:-52428800}"   # 50MB
DATASNAP_DAYS="${SEC_DATASNAP_DAYS:-90}"            # 一次性导入快照保留 90 天

log() { echo "[retention] $*"; }

# --- 1. 流量归档：删除超过 N 天的 JSONL ---
if [ -d "$FLOWS_DIR" ]; then
    n=$(find "$FLOWS_DIR" -type f -name '*.jsonl' -mtime +"$RETENTION_DAYS" -delete -print | wc -l)
    log "flows 清理 $n 个过期文件"
fi

# --- 2. 扫描结果：删除超过 N 天的 run 目录 ---
if [ -d "$RESULTS_DIR" ]; then
    n=$(find "$RESULTS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} + -print 2>/dev/null | wc -l)
    log "results 清理 $n 个过期 run 目录"
fi

# --- 3. 审计日志轮转：超阈值归档（保留最近一份备份） ---
if [ -f "$AUDIT_LOG" ]; then
    sz=$(stat -c%s "$AUDIT_LOG" 2>/dev/null || echo 0)
    if [ "$sz" -gt "$AUDIT_MAX_BYTES" ]; then
        ts=$(date +%Y%m%d-%H%M%S)
        mv "$AUDIT_LOG" "$AUDIT_LOG.$ts.bak"
        log "audit.jsonl 轮转 ($sz bytes → $AUDIT_LOG.$ts.bak)"
    fi
fi

# --- 4. 一次性快照/导入暂存（v4.5 新增：datasnap tgz 与 import-staging 不再无限堆积） ---
if [ -d "$DATASNAP_DIR" ]; then
    n=$(find "$DATASNAP_DIR" -type f -name '*.tgz' -mtime +"$DATASNAP_DAYS" -delete -print 2>/dev/null | wc -l)
    log "datasnap 清理 $n 个过期快照（>${DATASNAP_DAYS}d）"
fi
if [ -d "$IMPORT_STAGING_DIR" ]; then
    # import-staging 是一次性导入源（如 cyberstrikeai），导入完成后整目录滞留无治理——90 天兜底清除
    if [ -n "$(find "$IMPORT_STAGING_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +"$DATASNAP_DAYS" 2>/dev/null | head -1)" ]; then
        find "$IMPORT_STAGING_DIR" -maxdepth 1 -mindepth 1 -type d -mtime +"$DATASNAP_DAYS" -exec rm -rf {} + -print 2>/dev/null | while read -r d; do log "import-staging 清理 $d"; done
    fi
fi

log "retention 完成"