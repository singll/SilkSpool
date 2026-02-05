#!/bin/bash
set -e
BASE_DIR="{{DEPLOY_PATH}}"
ACTION=$1

# 检查 Docker Compose 版本
check_dc() { docker compose version &>/dev/null && echo "docker compose" || echo "docker-compose"; }
DC=$(check_dc)

# 创建必要的挂载目录
mkdir -p "$BASE_DIR/recorder/config" "$BASE_DIR/robot/config" "$BASE_DIR/robot/logs"
cd "$BASE_DIR"

case "$ACTION" in
    setup)
        echo ">>> Pulling images..."
        $DC -f docker-compose.yaml pull
        $DC -f docker-compose.yaml up -d --remove-orphans
        ;;
    up)
        $DC -f docker-compose.yaml up -d --remove-orphans
        ;;
    down)
        $DC -f docker-compose.yaml down
        ;;
    status)
        $DC -f docker-compose.yaml ps
        ;;
esac
