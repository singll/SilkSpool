#!/bin/bash
set -e
APP_PREFIX="{{APP_PREFIX}}"
BASE_DIR="{{DEPLOY_PATH}}" # <--- 动态注入
ACTION=$1

# 自举: iStoreOS 这种精简系统可能没有 docker-compose
install_compose() {
    if ! command -v docker-compose >/dev/null && ! docker compose version &>/dev/null; then
        echo "[*] Installing docker-compose..."
        # 动态检测架构
        ARCH=$(uname -m)
        case "$ARCH" in
            x86_64)  ARCH="x86_64" ;;
            aarch64) ARCH="aarch64" ;;
            armv7l)  ARCH="armv7" ;;
            *)       echo "[x] Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        # 尝试获取最新版本，失败则回退
        COMPOSE_VERSION=$(curl -sL https://api.github.com/repos/docker/compose/releases/latest | grep '"tag_name":' | cut -d'"' -f4)
        [ -z "$COMPOSE_VERSION" ] && COMPOSE_VERSION="v2.24.5"
        curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" -o /usr/bin/docker-compose
        chmod +x /usr/bin/docker-compose
    fi
}

# 检查 DC 版本 (优先使用 docker compose v2)
check_dc() { docker compose version &>/dev/null && echo "docker compose" || echo "docker-compose"; }

install_compose
DC=$(check_dc)

mkdir -p "$BASE_DIR"; cd "$BASE_DIR"

case "$ACTION" in
    setup)
        # 预先创建外部网络
        if ! docker network ls | grep -q "gateway-net"; then docker network create gateway-net; fi
        export APP_PREFIX="$APP_PREFIX"
        $DC -f docker-compose.yaml pull
        $DC -f docker-compose.yaml up -d --remove-orphans
        ;;
    up)
        export APP_PREFIX="$APP_PREFIX"
        $DC -f docker-compose.yaml up -d --remove-orphans
        ;;
    down)
        export APP_PREFIX="$APP_PREFIX"
        $DC -f docker-compose.yaml down
        ;;
    status)
        export APP_PREFIX="$APP_PREFIX"
        $DC -f docker-compose.yaml ps
        ;;
esac
