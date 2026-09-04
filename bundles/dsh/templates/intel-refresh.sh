#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 情报刷新（intel-feeder v1，silksec-intel.timer 每日触发）
# 动作：nuclei 模板库更新 → 模板计数变化写 data/intel/intel.jsonl
# 后续接 dsh-sentinel/schedule：模板更新事件 → 存量资产重扫任务
#
# afrog 已摘除（2026-09-04 排查 G7）：旧代码 `afrog -up` 是不存在的 flag（"flag provided
# but not defined"→每日 update_failed 假警报），且 afrog 3.x 本地无模板库可刷（pocs 目录仅
# .DS_Store 残留，扫描时从 afrog 云端按需取 poc）——本地计数口径无意义，引擎列表不再纳入。
# ==============================================================================
set -uo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="$BASE_DIR/data"
INTEL_DIR="$DATA_DIR/intel"
LOG="$INTEL_DIR/intel.jsonl"
mkdir -p "$INTEL_DIR"

export PATH="/usr/local/go/bin:/usr/local/bin:$PATH"

log() { echo "[intel] $*"; }

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

log "完成（日志: $LOG）"
