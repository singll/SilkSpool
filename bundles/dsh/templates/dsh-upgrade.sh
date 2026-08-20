#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent (DSH) 一键升级脚本（spool bundle dsh upgrade <host>）
# 流程：版本检查 → 数据/配置备份 → npm 安装目标版本 → 重启 → 冒烟 → 失败回滚
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="$BASE_DIR/data"
SERVICE="silksecagent"
NODE_BIN="/usr/local/node/bin"

FORCE=0
TARGET=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)   FORCE=1; shift ;;
        --version) TARGET="${2:-}"; shift 2 ;;
        -h|--help) echo "usage: bash dsh-upgrade.sh [--force] [--version X.Y.Z]"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

log() { echo "[upgrade] $*"; }
err() { echo "[upgrade][ERROR] $*" >&2; }

export PATH="$NODE_BIN:$PATH"

[ -d "$APP_DIR" ] || { err "$APP_DIR 不存在，请先 spool bundle dsh setup <host>"; exit 1; }

cur_version() {
    python3 -c 'import json;print(json.load(open("'"$APP_DIR"'/node_modules/@deepseek-ai/dsh/package.json"))["version"])' 2>/dev/null || echo ""
}

latest_version() {
    curl -fsSL --connect-timeout 15 --retry 3 \
        "https://registry.npmjs.org/@deepseek-ai/dsh" \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["dist-tags"]["latest"])'
}

CUR_VER="$(cur_version)"
if [ -z "$TARGET" ]; then
    log "获取 npm 最新版本..."
    TARGET="$(latest_version)"
    [ -n "$TARGET" ] || { err "无法获取最新版本（可 --version 手动指定）"; exit 1; }
fi
log "当前版本: ${CUR_VER:-unknown}  目标版本: $TARGET"

if [ "$FORCE" -ne 1 ] && [ -n "$CUR_VER" ] && [ "$CUR_VER" = "$TARGET" ]; then
    log "已是目标版本 ($TARGET)，无需升级（--force 可强制重装）"
    exit 0
fi

# ---------- 1. 备份 ----------
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$DATA_DIR/backups"
tar -czf "$DATA_DIR/backups/dsh-upgrade-$TS.tgz" \
    -C "$BASE_DIR" .env 2>/dev/null \
    -C "$APP_DIR" package.json package-lock.json 2>/dev/null || true
log "备份: $DATA_DIR/backups/dsh-upgrade-$TS.tgz"

rollback() {
    err "升级失败，回滚到 $CUR_VER"
    cd "$APP_DIR"
    python3 - "$CUR_VER" <<'EOF'
import json, sys
p = json.load(open("package.json"))
p.setdefault("dependencies", {})["@deepseek-ai/dsh"] = sys.argv[1]
json.dump(p, open("package.json", "w"), indent=2, ensure_ascii=False)
EOF
    pnpm install --prod --ignore-scripts || true
    sudo systemctl restart "$SERVICE" || true
}

# ---------- 2. 安装目标版本 ----------
log "安装 @deepseek-ai/dsh@$TARGET ..."
cd "$APP_DIR"
python3 - "$TARGET" <<'EOF'
import json, sys
p = json.load(open("package.json"))
p.setdefault("dependencies", {})["@deepseek-ai/dsh"] = sys.argv[1]
json.dump(p, open("package.json", "w"), indent=2, ensure_ascii=False)
EOF
if ! pnpm install --prod --ignore-scripts; then
    rollback; exit 1
fi

# ---------- 3. 重启 + 冒烟 ----------
log "重启 $SERVICE ..."
sudo systemctl restart "$SERVICE"
sleep 5

if ! systemctl is-active --quiet "$SERVICE"; then
    err "$SERVICE 启动失败，排查: sudo journalctl -u $SERVICE -n 50"
    rollback; exit 1
fi
# Web UI 冒烟（:3080 响应即通过，不要求 200）
SMOKE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 http://127.0.0.1:3081/ || echo "000")
if [ "$SMOKE_CODE" = "000" ]; then
    err "冒烟失败: http://127.0.0.1:3081 无响应"
    rollback; exit 1
fi

NEW_VER="$(cur_version)"
log "升级完成: ${CUR_VER:-unknown} -> ${NEW_VER:-$TARGET} (HTTP $SMOKE_CODE)"
log "备份位置: $DATA_DIR/backups/dsh-upgrade-$TS.tgz"
