#!/bin/sh
# ==============================================================================
#  n8n 自动初始化入口脚本 (Auto-Setup Entrypoint)
#
#  核心设计:
#    将 .env 挂载进容器, 每次启动时由本脚本读取并 export
#    → docker compose restart 即可加载新配置, 无需 up -d 重建容器
#    → 数据卷自然持久, 彻底解决账号丢失问题
#
#  启动流程:
#    1. 从挂载的 .env 加载环境变量 (每次启动都执行)
#    2. 设置 n8n 运行参数默认值
#    3. 首次启动: 自动注册 Owner + 导入工作流
#    4. exec n8n start (n8n 成为 PID 1, 最优信号处理)
# ==============================================================================

ENV_FILE="/home/node/config/.env"
N8N_PORT="${N8N_PORT:-5678}"
N8N_URL="http://localhost:${N8N_PORT}"
WORKFLOW_DIR="/home/node/n8n-workflows"
INIT_MARKER="/home/node/.n8n/.silkspool-initialized"

log() { echo "[n8n-init] $*"; }

# ==============================================================================
#  Phase 1: 加载环境变量 (每次启动)
#  从挂载的 .env 读取, 使 docker compose restart 能获取最新配置
# ==============================================================================
if [ -f "$ENV_FILE" ]; then
    log "Loading environment from mounted .env"
    set -a
    . "$ENV_FILE"
    set +a
else
    log "WARNING: No .env file at $ENV_FILE, using Docker env vars only"
fi

# --- 变量映射 (适配 n8n 工作流中 $env.XXX 的引用名) ---
export BELLKEEPER_URL="${BELLKEEPER_INTERNAL_URL:-http://bellkeeper:8080}"
export HOST_DOCKER_INTERNAL="host.docker.internal"

# --- n8n 运行参数默认值 ---
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
export EXECUTIONS_DATA_PRUNE="${EXECUTIONS_DATA_PRUNE:-true}"
export EXECUTIONS_DATA_MAX_AGE="${EXECUTIONS_DATA_MAX_AGE:-168}"
export EXECUTIONS_DATA_PRUNE_MAX_COUNT="${EXECUTIONS_DATA_PRUNE_MAX_COUNT:-5000}"
export N8N_BLOCK_ENV_ACCESS_IN_NODE="${N8N_BLOCK_ENV_ACCESS_IN_NODE:-false}"

# --- 清理: 移除 n8n 不需要的敏感变量 ---
unset REDIS_PASSWORD BELLKEEPER_DB_PASSWORD COUCHDB_SECRET

# ==============================================================================
#  Phase 2: 首次初始化 (仅在无标记文件时执行)
# ==============================================================================
if [ ! -f "$INIT_MARKER" ]; then
    log "First-time initialization detected"

    # 确保 curl 可用 (Alpine 镜像可能未预装)
    if ! command -v curl >/dev/null 2>&1; then
        log "Installing curl..."
        apk add --no-cache curl >/dev/null 2>&1 || true
    fi

    # 启动 n8n (后台, 用于 REST API 初始化)
    log "Starting n8n for initialization..."
    n8n start &
    INIT_PID=$!

    # 信号处理 (初始化阶段)
    trap "kill -TERM $INIT_PID 2>/dev/null; wait $INIT_PID 2>/dev/null; exit 0" TERM INT QUIT

    # 等待 n8n 就绪 (最多 3 分钟)
    log "Waiting for n8n to be ready..."
    ready=false
    i=0
    while [ $i -lt 90 ]; do
        if curl -sf "${N8N_URL}/healthz" >/dev/null 2>&1; then
            ready=true
            log "n8n is ready!"
            break
        fi
        if ! kill -0 $INIT_PID 2>/dev/null; then
            log "ERROR: n8n exited during initialization"
            break
        fi
        i=$((i + 1))
        sleep 2
    done

    if [ "$ready" = "true" ]; then
        # --- 自动注册 Owner 账号 ---
        owner_email="${N8N_OWNER_EMAIL:-}"
        owner_pass="${N8N_OWNER_PASSWORD:-${N8N_PASSWORD:-}}"
        owner_created=false

        if [ -n "$owner_email" ] && [ -n "$owner_pass" ]; then
            log "Attempting owner setup..."
            http_code=$(curl -sf -o /dev/null -w "%{http_code}" \
                -X POST "${N8N_URL}/rest/owner/setup" \
                -H "Content-Type: application/json" \
                -d "{
                    \"email\": \"${owner_email}\",
                    \"firstName\": \"${N8N_OWNER_FIRST_NAME:-Admin}\",
                    \"lastName\": \"${N8N_OWNER_LAST_NAME:-SilkSpool}\",
                    \"password\": \"${owner_pass}\"
                }" 2>/dev/null || echo "000")

            case "$http_code" in
                200)
                    log "Owner account created: ${owner_email}"
                    owner_created=true
                    ;;
                *)
                    log "Owner exists or unavailable (HTTP ${http_code})"
                    ;;
            esac
        else
            log "N8N_OWNER_EMAIL or password not set, skipping owner setup"
        fi

        # --- 首次安装且 Owner 刚创建: 导入工作流 ---
        if [ "$owner_created" = "true" ] && [ -d "$WORKFLOW_DIR" ]; then
            set -- "$WORKFLOW_DIR"/*.json
            if [ -f "$1" ]; then
                wf_count=$#
                log "Importing ${wf_count} workflows..."

                # 停止 n8n 以安全写入 SQLite
                kill -TERM $INIT_PID 2>/dev/null
                wait $INIT_PID 2>/dev/null || true
                INIT_PID=""
                sleep 1

                ok=0
                for f in "$WORKFLOW_DIR"/*.json; do
                    if n8n import:workflow --input="$f" 2>/dev/null; then
                        log "  OK: $(basename "$f")"
                        ok=$((ok + 1))
                    else
                        log "  FAIL: $(basename "$f")"
                    fi
                done
                log "Imported ${ok}/${wf_count} workflows"
            fi
        fi
    fi

    # 写入初始化标记 (存在数据卷中, 跨重启持久)
    mkdir -p "$(dirname "$INIT_MARKER")"
    touch "$INIT_MARKER"
    log "Initialization complete"

    # 确保后台 n8n 已停止
    if [ -n "$INIT_PID" ]; then
        kill -TERM $INIT_PID 2>/dev/null
        wait $INIT_PID 2>/dev/null || true
    fi
    trap - TERM INT QUIT
    sleep 1
fi

# ==============================================================================
#  Phase 3: 启动 n8n
#  使用 exec 替换当前进程, n8n 成为 PID 1, 正确处理 Docker 信号
# ==============================================================================
log "Starting n8n (PID 1)..."
exec n8n start
