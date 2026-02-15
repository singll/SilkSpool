#!/bin/bash
# ==============================================================================
#  Knowledge 远程执行脚本
#  注意: 此脚本中的 {{APP_PREFIX}} 会在传输过程中被替换
# ==============================================================================

set -e

# --- 动态注入 ---
APP_PREFIX="{{APP_PREFIX}}"
BASE_DIR="{{DEPLOY_PATH}}"  # <--- 不再写死 /opt/...，由 runner 注入
FC_DIR="$BASE_DIR/firecrawl"
KM_DIR="$BASE_DIR/knowledge-management" # <--- 旧版 knowledge-management
BK_DIR="$BASE_DIR/bellkeeper"           # <--- 新版 Bellkeeper (Go + SolidJS)
ACTION=$1  # 接收来自 runner.sh 的第一个参数
SERVICE=$2 # 可选: 指定要操作的服务名称 (用于 service 命令)

# --- NFS 存储路径 (从 .env 读取，这里提供默认值) ---
NFS_DOCUMENTS="${NFS_DOCUMENTS:-/data/documents}"
NFS_MINIO="${NFS_MINIO:-/data/minio}"
NFS_LOGS="${NFS_LOGS:-/data/logs}"

# --- 磁盘空间阈值 (百分比) ---
DISK_WARN_THRESHOLD=80
DISK_CRITICAL_THRESHOLD=90

# --- 自举函数: 确保远程环境可用 ---
# 在裸机上也能运行
check_env() {
    # 检查 Git
    if ! command -v git &>/dev/null; then
        echo "[*] Installing Git..."
        command -v apt-get &>/dev/null && sudo apt-get update && sudo apt-get install -y git
    fi
    # 检查 Docker
    if ! command -v docker &>/dev/null; then
        echo "[*] Installing Docker..."
        curl -fsSL https://get.docker.com | sh
        sudo usermod -aG docker $USER || true
    fi
}

# --- 配置 Docker 日志轮转 (防止容器日志撑满硬盘) ---
configure_docker_log_rotation() {
    local daemon_json="/etc/docker/daemon.json"

    # 检查是否已配置
    if [ -f "$daemon_json" ] && grep -q "max-size" "$daemon_json" 2>/dev/null; then
        echo "   [OK] Docker log rotation already configured"
        return 0
    fi

    echo "[*] Configuring Docker log rotation..."

    # 创建或更新 daemon.json
    sudo tee "$daemon_json" > /dev/null << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
EOF

    echo "   [OK] Docker log rotation configured (max-size: 50MB, max-file: 3)"
    echo "   [!] Docker restart required for changes to take effect (does not affect existing containers)"

    # 重启 Docker 服务
    sudo systemctl restart docker || true
    sleep 3
}

# --- 确保 NFS 目录结构存在 ---
prepare_nfs_dirs() {
    echo "[*] Preparing NFS storage directories..."

    # RAGFlow 文档目录
    if [ -d "$NFS_DOCUMENTS" ]; then
        mkdir -p "$NFS_DOCUMENTS/ragflow"
        echo "   [OK] $NFS_DOCUMENTS/ragflow"
    else
        echo "   [!] NFS not mounted: $NFS_DOCUMENTS (will use local storage)"
    fi

    # MinIO 数据目录
    if [ -d "$NFS_MINIO" ]; then
        mkdir -p "$NFS_MINIO"
        echo "   [OK] $NFS_MINIO"
    else
        echo "   [!] NFS not mounted: $NFS_MINIO (will use local storage)"
    fi

    # 日志目录 (含 RAGFlow 应用日志)
    if [ -d "$NFS_LOGS" ]; then
        mkdir -p "$NFS_LOGS"
        mkdir -p "$NFS_LOGS/ragflow"
        echo "   [OK] $NFS_LOGS"
        echo "   [OK] $NFS_LOGS/ragflow"
    else
        echo "   [!] NFS not mounted: $NFS_LOGS"
    fi
}

# --- 磁盘空间监控与清理 ---
check_and_clean_disk() {
    echo "[*] Checking disk space..."

    local usage
    usage=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')

    echo "   Current root partition usage: ${usage}%"

    if [ "$usage" -ge "$DISK_CRITICAL_THRESHOLD" ]; then
        echo "   [!] Disk usage exceeds ${DISK_CRITICAL_THRESHOLD}%, performing emergency cleanup..."
        cleanup_docker_resources aggressive
    elif [ "$usage" -ge "$DISK_WARN_THRESHOLD" ]; then
        echo "   [!] Disk usage exceeds ${DISK_WARN_THRESHOLD}%, performing routine cleanup..."
        cleanup_docker_resources normal
    else
        echo "   [OK] Disk space sufficient"
    fi
}

# --- Docker 资源清理 ---
cleanup_docker_resources() {
    local mode="${1:-normal}"

    echo "[*] Cleaning Docker resources (mode: $mode)..."

    # 1. 清理悬空镜像 (始终执行)
    echo "   Cleaning dangling images..."
    docker image prune -f 2>/dev/null || true

    # 2. 清理构建缓存
    echo "   Cleaning build cache..."
    if [ "$mode" = "aggressive" ]; then
        # 激进模式: 清理所有未使用的构建缓存
        docker builder prune -af 2>/dev/null || true
    else
        # 常规模式: 只清理 7 天前的缓存
        docker builder prune -f --filter "until=168h" 2>/dev/null || true
    fi

    # 3. 清理未使用的网络
    docker network prune -f 2>/dev/null || true

    # 4. 激进模式下清理未使用的卷 (危险操作，需谨慎)
    if [ "$mode" = "aggressive" ]; then
        echo "   [!] Cleaning unused volumes..."
        # 只清理匿名卷，不清理命名卷
        docker volume prune -f --filter "dangling=true" 2>/dev/null || true
    fi

    # 5. 清理已停止的容器
    docker container prune -f 2>/dev/null || true

    # 显示清理后的空间
    local new_usage
    new_usage=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
    echo "   [OK] Cleanup completed, current usage: ${new_usage}%"
}

# 兼容 docker-compose (v1) 和 docker compose (v2)
get_dc() { docker compose version &>/dev/null && echo "docker compose" || echo "docker-compose"; }

# --- 主逻辑 ---
check_env
DC=$(get_dc)

mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

# =========================================================
#  新增: 源码更新函数
#  功能: 检查目录是否存在，不存在则 Clone，存在则 Pull
# =========================================================
update_repos() {
    echo "[Git] Checking source repository status..."

    # 1. 处理 Firecrawl (外部依赖)
    if [ -d "$FC_DIR" ]; then
        echo "   [*] Updating Firecrawl..."
        # 使用 || true 防止因本地修改导致 pull 失败中断脚本
        git -C "$FC_DIR" pull || echo "   [!] Firecrawl update failed (possible local conflict), skipping."
    else
        echo "   [*] Cloning Firecrawl..."
        git clone https://github.com/mendableai/firecrawl.git "$FC_DIR"
    fi

    # 2. 处理 Knowledge Management (旧版 Python 全栈项目)
    if [ -d "$KM_DIR" ]; then
        echo "   [*] Updating Knowledge Management..."
        git -C "$KM_DIR" pull || echo "   [!] Knowledge Management update failed, skipping."
    else
        echo "   [*] Cloning Knowledge Management..."
        # 指向您的 GitHub 仓库
        git clone https://github.com/singll/knowledge-management.git "$KM_DIR"
    fi

    # 3. 处理 Bellkeeper (新版 Go + SolidJS 项目)
    # 优先使用本地 rsync 推送的代码，如果不存在则尝试从 GitHub 克隆
    if [ -d "$BK_DIR" ]; then
        echo "   [*] Updating Bellkeeper..."
        # 检查是否有 .git 目录 (git 仓库)
        if [ -d "$BK_DIR/.git" ]; then
            git -C "$BK_DIR" pull || echo "   [!] Bellkeeper update failed, using existing code."
        else
            echo "   [*] Bellkeeper directory exists (rsync mode), skipping git pull."
        fi
    else
        echo "   [*] Bellkeeper not found, trying to clone from GitHub..."
        # 尝试从 GitHub 克隆，如果失败则提示用户使用 rsync
        if ! git clone https://github.com/singll/Bellkeeper.git "$BK_DIR" 2>/dev/null; then
            echo "   [!] GitHub clone failed. Please use rsync to push source code:"
            echo "       rsync -avz --exclude node_modules --exclude dist /path/to/Bellkeeper/ user@host:$BK_DIR/"
            echo "   [!] Skipping Bellkeeper setup."
        fi
    fi
}

# --- 确保 Firecrawl 数据库 schema 正确初始化 ---
init_firecrawl_db() {
    local db_container="${APP_PREFIX}firecrawl-db"
    local max_retries=30
    local retry=0

    echo "[DB] Checking Firecrawl database initialization status..."

    # 等待数据库容器就绪
    while [ $retry -lt $max_retries ]; do
        if docker exec "$db_container" pg_isready -U postgres &>/dev/null; then
            break
        fi
        echo "   [*] Waiting for database to be ready... ($retry/$max_retries)"
        sleep 2
        retry=$((retry + 1))
    done

    if [ $retry -ge $max_retries ]; then
        echo "   [x] Database startup timed out"
        return 1
    fi

    # 检查 nuq schema 是否存在
    local schema_exists
    schema_exists=$(docker exec "$db_container" psql -U postgres -d firecrawl -tAc \
        "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'nuq';" 2>/dev/null || echo "")

    if [ "$schema_exists" != "1" ]; then
        echo "   [*] Initializing nuq schema..."
        docker exec "$db_container" psql -U postgres -d firecrawl \
            -f /docker-entrypoint-initdb.d/010-nuq.sql 2>/dev/null || true
        echo "   [OK] Database schema initialization completed"
    else
        echo "   [OK] Database schema already exists"
    fi
}

case "$ACTION" in
    setup)
        # 0. 配置 Docker 日志轮转 (首次部署时)
        configure_docker_log_rotation

        # 1. 准备 NFS 目录
        prepare_nfs_dirs

        # 2. 检查磁盘空间
        check_and_clean_disk

        # 3. 先拉取/更新代码
        update_repos

        export APP_PREFIX="$APP_PREFIX"

        # 4. 强制构建 (Build)
        # 因为您的 knowledge-web 依赖源码构建，所以必须执行 build
        echo "[*] Building images..."
        $DC -f docker-compose.yaml build

        # 5. 启动服务
        echo "[*] Starting services..."
        $DC -f docker-compose.yaml up -d --remove-orphans

        # 6. 确保 Firecrawl 数据库初始化
        init_firecrawl_db

        # 7. 构建后清理 (释放构建缓存)
        echo "[*] Post-build cleanup..."
        docker builder prune -f --filter "until=24h" 2>/dev/null || true
        ;;

    up)
        # 准备 NFS 目录
        prepare_nfs_dirs

        # 检查磁盘空间
        check_and_clean_disk

        # 升级逻辑: 同样需要拉取最新代码并重新构建
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
        # 手动触发清理
        echo "[*] Performing manual cleanup..."
        cleanup_docker_resources "${2:-normal}"
        check_and_clean_disk
        ;;

    disk-check)
        # 磁盘状态检查 (可用于定时任务)
        check_and_clean_disk

        echo ""
        echo "[*] Disk usage details:"
        df -h / /data/documents /data/minio /data/logs 2>/dev/null || df -h /

        echo ""
        echo "[*] Docker resource usage:"
        docker system df

        echo ""
        echo "[*] Docker volume sizes:"
        for vol in $(docker volume ls -q 2>/dev/null | head -10); do
            size=$(docker run --rm -v "$vol:/data" alpine du -sh /data 2>/dev/null | cut -f1)
            echo "   $vol: $size"
        done
        ;;

    # =========================================================
    #  独立服务测试命令 (不影响其他运行的服务)
    #  用法: service <service_name> <action>
    #  示例: service bellkeeper up     # 启动 Bellkeeper
    #        service bellkeeper down   # 停止 Bellkeeper
    #        service bellkeeper build  # 仅构建 Bellkeeper
    #        service bellkeeper logs   # 查看日志
    # =========================================================
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
            echo "  ragflow       - RAGFlow"
            echo "  firecrawl-api - Firecrawl API"
            echo ""
            echo "Actions: up, down, build, logs, restart"
            exit 1
        fi

        echo "[Service] Operating on: $svc_name (action: $svc_action)"

        case "$svc_action" in
            up)
                # 如果是 Bellkeeper，先更新代码
                if [[ "$svc_name" == "bellkeeper"* ]]; then
                    if [ -d "$BK_DIR" ]; then
                        echo "   [*] Updating Bellkeeper source..."
                        git -C "$BK_DIR" pull || true
                    else
                        echo "   [*] Cloning Bellkeeper..."
                        git clone https://github.com/singll/Bellkeeper.git "$BK_DIR"
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
                echo "Available actions: up, down, build, logs, restart"
                exit 1
                ;;
        esac
        ;;

    *)
        echo "Usage: $0 {setup|up|down|status|cleanup|disk-check|service}"
        echo ""
        echo "Commands:"
        echo "  setup      - Initial deployment (includes Docker log configuration)"
        echo "  up         - Update deployment"
        echo "  down       - Stop services"
        echo "  status     - View service status"
        echo "  cleanup    - Manual Docker resource cleanup (optional: cleanup aggressive)"
        echo "  disk-check - Check disk status"
        echo "  service    - Manage individual service (service <name> <action>)"
        exit 1
        ;;
esac
