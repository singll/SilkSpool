#!/usr/bin/env bash
# ==============================================================================
# Vulhub 靶场控制（vulhub-ctl.sh <up|down|status> [name ...]）
# 按 envs.list 管理 vulhub 各环境（docker compose 起停 + 端口改写 + 就绪探测）
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
REPO_DIR="$BASE_DIR/vulhub"
LIST_FILE="$BASE_DIR/envs.list"
STATE_FILE="$BASE_DIR/envs.state"

log()  { echo "[vulhub] $*"; }
warn() { echo "[vulhub][WARN] $*"; }

[ -f "$LIST_FILE" ] || { echo "清单不存在: $LIST_FILE" >&2; exit 1; }

entries() {
    if [ $# -gt 0 ]; then
        for n in "$@"; do grep -E "^${n}\|" "$LIST_FILE" || warn "$n 不在清单中"; done
    else
        grep -vE '^\s*#|^\s*$' "$LIST_FILE"
    fi
}

# 改写 compose 外部端口（幂等：行首锚定，右侧=内部端口时替换左侧外部端口）
fix_port() {
    local compose="$1" internal="$2" external="$3"
    # vulhub compose 端口行: - "8080:80" / - 8080:8080 / - '80:80'
    sed -i -E "s|^(\s*-\s*['\"]?)[0-9]+(:${internal}['\"]?\s*$)|\1${external}\2|" "$compose"
}

env_up() {
    local name="$1" envpath="$2" internal="$3" external="$4" ready="$5"
    local dir="$REPO_DIR/$envpath"
    [ -d "$dir" ] || { warn "$name 环境目录不存在: $envpath"; return 1; }
    fix_port "$dir/docker-compose.yml" "$internal" "$external"
    log "$name 启动（:$external）..."
    (cd "$dir" && docker compose -p "vulhub-$name" up -d --quiet-pull 2>&1 | tail -2)
    # 就绪探测（最长 120s）
    local i
    for i in $(seq 1 24); do
        if curl -s -o /dev/null --connect-timeout 3 --max-time 8 "http://127.0.0.1:${external}${ready}" 2>/dev/null; then
            log "$name 就绪 ✓ http://vulhub.singll.net:${external}"
            echo "$name|$external|ready" >> "$STATE_FILE.tmp"
            return 0
        fi
        sleep 5
    done
    warn "$name 未在 120s 内就绪（可能仍在初始化）: http://127.0.0.1:${external}"
    echo "$name|$external|pending" >> "$STATE_FILE.tmp"
}

env_down() {
    local name="$1" envpath="$2"
    local dir="$REPO_DIR/$envpath"
    [ -d "$dir" ] || return 0
    log "$name 停止"
    (cd "$dir" && docker compose -p "vulhub-$name" down 2>&1 | tail -1)
}

env_status() {
    local name="$1" external="$4"
    local state="down"
    (cd "$REPO_DIR/$2" && docker compose -p "vulhub-$name" ps --format '{{.State}}' 2>/dev/null | grep -q running) && state="running"
    local http="-"
    [ "$state" = "running" ] && http=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 "http://127.0.0.1:${external}/" 2>/dev/null || echo "err")
    printf '%-16s %-10s :%-6s http=%s\n' "$name" "$state" "$external" "$http"
}

ACTION="${1:-status}"; shift || true
case "$ACTION" in
    up)
        rm -f "$STATE_FILE.tmp"
        while IFS='|' read -r name envpath internal external ready; do
            [[ "$name" =~ ^#.*$ || -z "$name" ]] && continue
            env_up "$name" "$envpath" "$internal" "$external" "$ready"
        done < <(entries "$@")
        mv "$STATE_FILE.tmp" "$STATE_FILE" 2>/dev/null || true
        ;;
    down)
        while IFS='|' read -r name envpath internal external ready; do
            [[ "$name" =~ ^#.*$ || -z "$name" ]] && continue
            env_down "$name" "$envpath"
        done < <(entries "$@")
        ;;
    status)
        while IFS='|' read -r name envpath internal external ready; do
            [[ "$name" =~ ^#.*$ || -z "$name" ]] && continue
            env_status "$name" "$envpath" "$internal" "$external" "$ready"
        done < <(entries "$@")
        ;;
    *) echo "usage: vulhub-ctl.sh <up|down|status> [name ...]"; exit 1 ;;
esac
