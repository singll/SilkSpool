#!/usr/bin/env bash
# ==============================================================================
# CyberStrikeAI 一键升级脚本（spool upgrade csai / spool bundle csai upgrade csai）
# 流程：版本检查 → 配置备份 → 停服 → 上游 upgrade.sh(sudo 后台) → 等待构建
#       → 清理临时进程 → 恢复属主 → systemd 启动 → 验证
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/CyberStrikeAI"
SERVICE="cyberstrikeai"
LOG="/tmp/csai-upgrade.log"
GO_BIN="/usr/local/go/bin"
BUILD_TIMEOUT=1200   # 等待升级+构建完成的最大秒数

FORCE=0
TAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=1; shift ;;
        --tag)   TAG="${2:-}"; shift 2 ;;
        -h|--help) echo "usage: bash csai-upgrade.sh [--force] [--tag vX.Y.Z]"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

log()  { echo "[upgrade] $*"; }
err()  { echo "[upgrade][ERROR] $*" >&2; }

[ -d "$APP_DIR" ] || { err "$APP_DIR 不存在"; exit 1; }
[ -f "$APP_DIR/upgrade.sh" ] || { err "上游 upgrade.sh 不存在: $APP_DIR/upgrade.sh"; exit 1; }

current_version() {
    sed -n 's/^[[:space:]]*version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}/\1/p' "$APP_DIR/config.yaml" | head -1
}

latest_tag() {
    curl -fsSL --connect-timeout 15 --retry 3 --retry-delay 2 \
        "https://api.github.com/repos/Ed1s0nZ/CyberStrikeAI/releases/latest" \
        | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

CUR_VER="$(current_version)"
if [ -z "$TAG" ]; then
    log "获取最新 Release..."
    TAG="$(latest_tag)"
    [ -n "$TAG" ] || { err "无法获取最新 release tag（可 --tag 手动指定）"; exit 1; }
fi
log "当前版本: ${CUR_VER:-unknown}  目标版本: $TAG"

if [ "$FORCE" -ne 1 ] && [ -n "$CUR_VER" ] && [ "$CUR_VER" = "$TAG" ]; then
    log "已是最新版本 ($TAG)，无需升级（--force 可强制重装）"
    exit 0
fi

# ---------- 1. 配置文件备份 ----------
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BASE_DIR/backups"
tar -czf "$BASE_DIR/backups/csai-config-$TS.tgz" -C "$BASE_DIR" .env -C "$APP_DIR" config.yaml
log "配置备份: $BASE_DIR/backups/csai-config-$TS.tgz"

# ---------- 2. 停止服务 ----------
log "停止 $SERVICE..."
sudo systemctl stop "$SERVICE"

cleanup_upgrade() {
    # 上游 upgrade.sh 末尾的 run.sh 会以前台 HTTPS 拉起临时进程，须清掉再由 systemd 接管
    sudo pkill -TERM -f 'cyberstrike-ai .*--https' 2>/dev/null || true
    sudo pkill -TERM -f 'upgrade\.sh --yes' 2>/dev/null || true
}
trap cleanup_upgrade EXIT

# ---------- 3. 后台执行上游升级脚本 ----------
# 以 root 运行：data/ 下存在 root 属主的运行时文件，普通用户执行其内置 tar 备份会失败
log "执行上游 upgrade.sh（目标 $TAG）..."
rm -f "$LOG"
cd "$APP_DIR"
sudo env PATH="$GO_BIN:/usr/local/bin:/usr/bin:/bin" \
    setsid bash upgrade.sh --yes --no-stop --tag "$TAG" > "$LOG" 2>&1 &

# ---------- 4. 轮询等待构建完成 ----------
log "等待升级与构建完成（日志: $LOG，最长 ${BUILD_TIMEOUT}s）..."
elapsed=0
while [ "$elapsed" -lt "$BUILD_TIMEOUT" ]; do
    if grep -q 'All setup complete' "$LOG" 2>/dev/null; then
        break
    fi
    if ! sudo pgrep -f 'upgrade\.sh --yes|bash run\.sh|cyberstrike-ai .*--https' >/dev/null 2>&1; then
        echo ""
        err "上游升级脚本异常退出，日志末尾："
        tail -20 "$LOG" >&2 || true
        exit 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    printf '\r[upgrade] 已等待 %ds...' "$elapsed"
done
echo ""

if ! grep -q 'All setup complete' "$LOG" 2>/dev/null; then
    err "等待构建超时（${BUILD_TIMEOUT}s），请检查 $LOG"
    exit 1
fi
log "构建完成"

# ---------- 5. 清理临时进程 ----------
cleanup_upgrade
sleep 2

# ---------- 6. 恢复文件属主 ----------
log "恢复文件属主..."
sudo chown -R "$(id -u):$(id -g)" "$APP_DIR"

# ---------- 7. systemd 启动并验证 ----------
log "启动 $SERVICE..."
sudo systemctl start "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" || { err "$SERVICE 启动失败，排查: sudo journalctl -u $SERVICE -n 50"; exit 1; }

NEW_VER="$(current_version)"
log "升级完成: ${CUR_VER:-unknown} -> ${NEW_VER:-$TAG}"
log "服务状态: $(systemctl is-active "$SERVICE")"
log "备份位置: $BASE_DIR/backups/csai-config-$TS.tgz + $APP_DIR/.upgrade-backup/"
