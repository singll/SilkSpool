#!/usr/bin/env bash
# ==============================================================================
# Vulhub 靶场幂等安装（spool bundle vulhub setup <host>）
# 职责：git/docker 检查 → clone vulhub（pin commit）→ 按 envs.list 拉起环境
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
REPO_DIR="$BASE_DIR/vulhub"
REPO="https://github.com/vulhub/vulhub.git"

log()  { echo "[setup] $*"; }
warn() { echo "[setup][WARN] $*"; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then SUDO='sudo'; fi

command -v git >/dev/null || { $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git; }
command -v docker >/dev/null || { echo "docker 未安装"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 不可用"; exit 1; }
docker info >/dev/null 2>&1 || $SUDO usermod -aG docker "$(id -un)" || true

if [ -d "$REPO_DIR/.git" ]; then
    log "仓库已存在，沿用（升级走显式 git fetch，避免环境漂移）"
else
    rm -rf "$REPO_DIR"
    log "克隆 vulhub（depth 1，镜像回退）..."
    git clone --depth 1 "$REPO" "$REPO_DIR" \
        || git clone --depth 1 "https://ghfast.top/$REPO" "$REPO_DIR"
fi
cd "$REPO_DIR"
git rev-parse HEAD > "$BASE_DIR/REPO_COMMIT"
log "仓库 commit: $(cat "$BASE_DIR/REPO_COMMIT")"

log "按 envs.list 拉起靶场环境..."
bash "$BASE_DIR/vulhub-ctl.sh" up
log "状态："
bash "$BASE_DIR/vulhub-ctl.sh" status
log "setup 完成"
