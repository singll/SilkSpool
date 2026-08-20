#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 情报刷新（intel-feeder v1，silksec-intel.timer 每日触发）
# 动作：nuclei/afrog 模板库更新 → 模板计数变化写 data/intel/intel.jsonl
# 后续接 dsh-sentinel/schedule：模板更新事件 → 存量资产重扫任务
# ==============================================================================
set -uo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="$BASE_DIR/data"
INTEL_DIR="$DATA_DIR/intel"
LOG="$INTEL_DIR/intel.jsonl"
mkdir -p "$INTEL_DIR"

export PATH="/usr/local/go/bin:/usr/local/bin:$PATH"

log() { echo "[intel] $*"; }

count_nuclei() { ls ~/.local/nuclei-templates 2>/dev/null | wc -l; nuclei -tl 2>/dev/null | wc -l || echo 0; }
count_afrog()  { ls ~/.local/afrog/pocs 2>/dev/null | wc -l || echo 0; }

record() { # <engine> <before> <after> <status>
    printf '{"ts":%s,"engine":"%s","before":%s,"after":%s,"status":"%s"}\n' \
        "$(date +%s)" "$1" "${2:-0}" "${3:-0}" "$4" >> "$LOG"
}

# --- nuclei 模板 ---
if command -v nuclei >/dev/null 2>&1; then
    before=$(nuclei -tl 2>/dev/null | wc -l)
    if nuclei -ut -silent >/dev/null 2>&1; then
        after=$(nuclei -tl 2>/dev/null | wc -l)
        log "nuclei 模板: $before → $after"
        record nuclei "$before" "$after" ok
    else
        log "nuclei 模板更新失败"
        record nuclei "$before" "$before" update_failed
    fi
fi

# --- afrog 库 ---
if command -v afrog >/dev/null 2>&1; then
    before=$(ls ~/.afrog/pocs 2>/dev/null | wc -l)
    if afrog -up >/dev/null 2>&1; then
        after=$(ls ~/.afrog/pocs 2>/dev/null | wc -l)
        log "afrog poc: $before → $after"
        record afrog "$before" "$after" ok
    else
        log "afrog 更新失败"
        record afrog "$before" "$before" update_failed
    fi
fi

log "完成（日志: $LOG）"
