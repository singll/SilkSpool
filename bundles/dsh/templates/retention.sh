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

RETENTION_DAYS="${SEC_RETENTION_DAYS:-30}"
AUDIT_MAX_BYTES="${SEC_AUDIT_MAX_BYTES:-52428800}"   # 50MB

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

log "retention 完成"
