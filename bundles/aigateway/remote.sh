#!/bin/bash
# ==============================================================================
#  AI Gateway 远程执行脚本
#  注意: 此脚本中的 {{APP_PREFIX}} 会在传输过程中被替换
# ==============================================================================

set -e

# --- 动态注入 ---
APP_PREFIX="{{APP_PREFIX}}"
BASE_DIR="{{DEPLOY_PATH}}"
ACTION=$1

# 兼容 docker-compose (v1) 和 docker compose (v2)
get_dc() { docker compose version &>/dev/null && echo "docker compose" || echo "docker-compose"; }

# --- 自举函数: 确保远程环境可用 ---
check_env() {
    if ! command -v docker &>/dev/null; then
        echo "[*] Installing Docker..."
        curl -fsSL https://get.docker.com | sh
        sudo usermod -aG docker $USER || true
    fi
}

# --- 配置 Docker 日志轮转 ---
configure_docker_log_rotation() {
    local daemon_json="/etc/docker/daemon.json"
    if [ -f "$daemon_json" ] && grep -q "max-size" "$daemon_json" 2>/dev/null; then
        echo "   [OK] Docker log rotation already configured"
        return 0
    fi
    echo "[*] Configuring Docker log rotation..."
    sudo tee "$daemon_json" > /dev/null << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
EOF
    sudo systemctl restart docker || true
    sleep 3
}

check_env
DC=$(get_dc)

mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

case "$ACTION" in
    setup)
        configure_docker_log_rotation
        export APP_PREFIX="$APP_PREFIX"
        echo "[*] Pulling images..."
        $DC -f docker-compose.yaml pull
        echo "[*] Starting services..."
        $DC -f docker-compose.yaml up -d --remove-orphans
        ;;

    up)
        export APP_PREFIX="$APP_PREFIX"
        echo "[*] Updating services..."
        $DC -f docker-compose.yaml pull
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

    *)
        echo "Usage: $0 {setup|up|down|status}"
        exit 1
        ;;
esac
