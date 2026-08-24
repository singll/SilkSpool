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
warn() { echo "[upgrade][WARN] $*" >&2; }
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
log "配置备份: $DATA_DIR/backups/dsh-upgrade-$TS.tgz"

# ---------- 1b. 数据快照（状态 + 配置，跨不兼容存储格式的回滚兜底）----------
# rc.8 起 DSH 存储格式声明为「不兼容」——升级可能对 storages/（会话/轨迹）做单向迁移，
# 届时仅回滚 npm 版本无法复原旧格式数据。此处快照关键状态：asset-graph.db（领域数据）、
# scope.yml（授权真相）、storages/、tools.d/、profiles/、knowledge/、playbooks/、skills/。
# 排除 results/、flows/（大体量瞬态数据，retention 管理，回滚不需要）与 backups/（自身）。
DATA_SNAP="$DATA_DIR/backups/dsh-datasnap-$TS.tgz"
tar -czf "$DATA_SNAP" \
    --exclude='./results' --exclude='./flows' --exclude='./backups' \
    -C "$DATA_DIR" . 2>/dev/null || warn "数据快照 tar 返回非零（多为跳过瞬态文件，通常可忽略）"
if [ -s "$DATA_SNAP" ]; then
    log "数据快照: $DATA_SNAP ($(du -h "$DATA_SNAP" 2>/dev/null | cut -f1))"
else
    warn "数据快照为空，升级前请人工确认 $DATA_DIR 状态"
fi

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
    warn "已回滚 npm 版本至 $CUR_VER。注意：若失败发生在存储迁移之后（新版已改写 storages/ 格式），"
    warn "仅回滚版本不足以复原旧格式数据——需人工用数据快照恢复："
    warn "  bash $BASE_DIR/silksec-restore.sh   # 或手动解包 ${DATA_SNAP:-\$DATA_DIR/backups/dsh-datasnap-*.tgz}"
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
# Web UI 冒烟（:3081 响应即通过，不要求 200）
SMOKE_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 http://127.0.0.1:3081/ || echo "000")
if [ "$SMOKE_CODE" = "000" ]; then
    err "冒烟失败: http://127.0.0.1:3081 无响应"
    rollback; exit 1
fi

# 深冒烟：确认自研插件仍进组合树——DSH 破坏性升级最可能在此暴露（服务能起但插件 API 变更导致加载失败，
# 浅冒烟只看 HTTP 有响应会漏判）。sec-cli-adapter 是安全套件核心工具，不在组合树 = 平台已残废。
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
if ! (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" node "$DSH_BIN" --profile web --dump-config 2>/dev/null | grep -q 'sec-cli-adapter'); then
    err "深冒烟失败：--dump-config 未见 sec-cli-adapter（DSH 升级破坏了自研插件加载）"
    rollback; exit 1
fi
log "深冒烟通过：sec-cli-adapter 已进 web 组合树"

NEW_VER="$(cur_version)"
# 升级后重放客户端补丁：pnpm install 会把设置镜像补丁冲掉（见 settings-mirror-patch.sh）
if [ -f "$BASE_DIR/settings-mirror-patch.sh" ]; then
    bash "$BASE_DIR/settings-mirror-patch.sh" || warn "设置镜像补丁重放失败（不影响升级结果）"
fi
log "升级完成: ${CUR_VER:-unknown} -> ${NEW_VER:-$TARGET} (HTTP $SMOKE_CODE)"
log "备份位置: $DATA_DIR/backups/dsh-upgrade-$TS.tgz"
