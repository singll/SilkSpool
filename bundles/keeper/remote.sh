#!/bin/bash
# ==============================================================================
#  Keeper 远程执行脚本
#  服务: n8n, Bellkeeper, Memos, RSSHub, CouchDB
#  注意: 此脚本中的 {{APP_PREFIX}} 会在传输过程中被替换
# ==============================================================================

set -e

# --- 动态注入 ---
APP_PREFIX="{{APP_PREFIX}}"
BASE_DIR="{{DEPLOY_PATH}}"
BK_DIR="$BASE_DIR/bellkeeper"
ACTION=$1
SERVICE=$2

# 兼容 docker-compose (v1) 和 docker compose (v2)
get_dc() { docker compose version &>/dev/null && echo "docker compose" || echo "docker-compose"; }

# --- 自举函数: 确保远程环境可用 ---
check_env() {
    if ! command -v git &>/dev/null; then
        echo "[*] Installing Git..."
        command -v apt-get &>/dev/null && sudo apt-get update && sudo apt-get install -y git
    fi
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

# --- 源码更新 ---
update_repos() {
    echo "[Git] Checking source repository status..."

    # Bellkeeper (Go + SolidJS)
    if [ -d "$BK_DIR" ]; then
        echo "   [*] Updating Bellkeeper..."
        if [ -d "$BK_DIR/.git" ]; then
            git -C "$BK_DIR" pull || echo "   [!] Bellkeeper update failed, using existing code."
        else
            echo "   [*] Bellkeeper directory exists (rsync mode), skipping git pull."
        fi
    else
        echo "   [*] Cloning Bellkeeper..."
        if ! git clone https://github.com/singll/Bellkeeper.git "$BK_DIR" 2>/dev/null; then
            echo "   [!] GitHub clone failed. Please use rsync to push source code."
        fi
    fi
}

# --- Docker 资源清理 ---
cleanup_docker_resources() {
    local mode="${1:-normal}"
    echo "[*] Cleaning Docker resources (mode: $mode)..."
    docker image prune -f 2>/dev/null || true
    if [ "$mode" = "aggressive" ]; then
        docker builder prune -af 2>/dev/null || true
    else
        docker builder prune -f --filter "until=168h" 2>/dev/null || true
    fi
    docker network prune -f 2>/dev/null || true
    docker container prune -f 2>/dev/null || true
}

check_env
DC=$(get_dc)

mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

case "$ACTION" in
    setup)
        configure_docker_log_rotation
        update_repos
        export APP_PREFIX="$APP_PREFIX"

        echo "[*] Building images..."
        $DC -f docker-compose.yaml build

        echo "[*] Starting services..."
        $DC -f docker-compose.yaml up -d --remove-orphans

        echo "[*] Post-build cleanup..."
        docker builder prune -f --filter "until=24h" 2>/dev/null || true
        ;;

    up)
        update_repos
        export APP_PREFIX="$APP_PREFIX"

        echo "[*] Checking for build updates..."
        $DC -f docker-compose.yaml build
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

    cleanup)
        cleanup_docker_resources "${2:-normal}"
        ;;

    service)
        export APP_PREFIX="$APP_PREFIX"
        svc_name="$SERVICE"
        svc_action="${3:-up}"

        if [ -z "$svc_name" ]; then
            echo "Usage: $0 service <service_name> [action]"
            echo ""
            echo "Available services:"
            echo "  bellkeeper    - Bellkeeper (Go + SolidJS)"
            echo "  bellkeeper-db - Bellkeeper PostgreSQL"
            echo "  n8n           - n8n workflow"
            echo "  memos         - Memos note-taking"
            echo "  rsshub        - RSSHub"
            echo "  couchdb       - CouchDB (Obsidian LiveSync)"
            echo ""
            echo "Actions: up, down, build, logs, restart"
            exit 1
        fi

        echo "[Service] Operating on: $svc_name (action: $svc_action)"

        case "$svc_action" in
            up)
                if [[ "$svc_name" == "bellkeeper"* ]]; then
                    if [ -d "$BK_DIR" ]; then
                        echo "   [*] Updating Bellkeeper source..."
                        git -C "$BK_DIR" pull || true
                    fi
                fi
                $DC -f docker-compose.yaml up -d --no-deps --build "$svc_name"
                ;;
            down)
                $DC -f docker-compose.yaml stop "$svc_name"
                ;;
            build)
                $DC -f docker-compose.yaml build --no-cache "$svc_name"
                ;;
            logs)
                $DC -f docker-compose.yaml logs -f --tail=100 "$svc_name"
                ;;
            restart)
                $DC -f docker-compose.yaml restart "$svc_name"
                ;;
            *)
                echo "Unknown action: $svc_action"
                exit 1
                ;;
        esac
        ;;

    *)
        echo "Usage: $0 {setup|up|down|status|cleanup|service}"
        exit 1
        ;;
esac
