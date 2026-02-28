#!/bin/sh
# ==============================================================================
#  n8n 自动初始化入口脚本 (Auto-Setup Entrypoint)
#  功能:
#    1. 启动 n8n 并等待就绪
#    2. 首次启动时自动注册 Owner 账号
#    3. 首次启动时自动导入工作流文件
#    4. 后续 docker compose up -d 不再需要重新注册
#
#  工作原理:
#    - 每次容器启动时, 后台启动 n8n 并检查是否需要初始设置
#    - 通过 REST API 尝试创建 Owner (若已存在则跳过, HTTP != 200)
#    - 若检测到首次安装 (Owner 刚创建), 自动导入挂载的工作流文件
#    - 使用 N8N_ENCRYPTION_KEY 确保凭证数据在容器重建后不丢失
# ==============================================================================

N8N_PORT="${N8N_PORT:-5678}"
N8N_URL="http://localhost:${N8N_PORT}"
WORKFLOW_DIR="/home/node/n8n-workflows"

# Owner 凭证 (从环境变量读取, N8N_OWNER_PASSWORD 回退到 N8N_PASSWORD)
OWNER_EMAIL="${N8N_OWNER_EMAIL:-}"
OWNER_PASS="${N8N_OWNER_PASSWORD:-${N8N_PASSWORD:-}}"
OWNER_FIRST="${N8N_OWNER_FIRST_NAME:-Admin}"
OWNER_LAST="${N8N_OWNER_LAST_NAME:-SilkSpool}"

log() { echo "[n8n-init] $*"; }

# --- 确保 curl 可用 (Alpine 镜像可能未预装) ---
ensure_deps() {
    if ! command -v curl >/dev/null 2>&1; then
        log "Installing curl..."
        apk add --no-cache curl >/dev/null 2>&1 || true
    fi
}

# --- 等待 n8n 就绪 ---
wait_for_n8n() {
    log "Waiting for n8n to be ready..."
    local i=0
    while [ $i -lt 90 ]; do
        if curl -sf "${N8N_URL}/healthz" >/dev/null 2>&1; then
            log "n8n is ready!"
            return 0
        fi
        # 检查 n8n 进程是否还活着
        if ! kill -0 "$N8N_PID" 2>/dev/null; then
            log "ERROR: n8n process exited unexpectedly"
            return 1
        fi
        i=$((i + 1))
        sleep 2
    done
    log "WARNING: Timeout waiting for n8n (180s)"
    return 1
}

# --- 自动注册 Owner 账号 ---
auto_setup_owner() {
    if [ -z "$OWNER_EMAIL" ] || [ -z "$OWNER_PASS" ]; then
        log "N8N_OWNER_EMAIL or password not configured, skipping auto-setup"
        return 1
    fi

    log "Checking if owner setup is needed..."

    HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
        -X POST "${N8N_URL}/rest/owner/setup" \
        -H "Content-Type: application/json" \
        -d "{
            \"email\": \"${OWNER_EMAIL}\",
            \"firstName\": \"${OWNER_FIRST}\",
            \"lastName\": \"${OWNER_LAST}\",
            \"password\": \"${OWNER_PASS}\"
        }" 2>/dev/null || echo "000")

    case "$HTTP_CODE" in
        200)
            log "Owner account created successfully: ${OWNER_EMAIL}"
            return 0
            ;;
        *)
            log "Owner already exists or setup unavailable (HTTP ${HTTP_CODE}), skipping"
            return 1
            ;;
    esac
}

# --- 自动导入工作流 ---
auto_import_workflows() {
    if [ ! -d "$WORKFLOW_DIR" ]; then
        log "No workflow directory mounted, skipping import"
        return 0
    fi

    # 检查是否有 JSON 文件
    set -- "$WORKFLOW_DIR"/*.json
    if [ ! -f "$1" ]; then
        log "No workflow JSON files found, skipping import"
        return 0
    fi
    local json_count=$#

    log "Importing $json_count workflows..."

    # 停止 n8n 以安全写入 SQLite 数据库
    kill -TERM "$N8N_PID" 2>/dev/null
    wait "$N8N_PID" 2>/dev/null || true
    sleep 1

    local imported=0
    local failed=0
    for f in "$WORKFLOW_DIR"/*.json; do
        local name=$(basename "$f")
        if n8n import:workflow --input="$f" 2>/dev/null; then
            log "  Imported: $name"
            imported=$((imported + 1))
        else
            log "  Failed: $name"
            failed=$((failed + 1))
        fi
    done

    log "Import complete: ${imported} succeeded, ${failed} failed"

    # 使用 exec 重新启动 n8n (替换当前进程, 正确处理信号)
    log "Restarting n8n..."
    exec n8n start
}

# ==============================================================================
#  主流程
# ==============================================================================

ensure_deps

# --- 信号处理: 确保 Docker stop 能正确关闭 n8n ---
N8N_PID=""
cleanup() {
    log "Received shutdown signal, stopping n8n..."
    [ -n "$N8N_PID" ] && kill -TERM "$N8N_PID" 2>/dev/null
    [ -n "$N8N_PID" ] && wait "$N8N_PID" 2>/dev/null
    exit 0
}
trap cleanup TERM INT QUIT

# --- 启动 n8n (后台, 用于初始化检查) ---
log "Starting n8n..."
n8n start &
N8N_PID=$!

# --- 等待 n8n 就绪并执行自动配置 ---
if wait_for_n8n; then
    if auto_setup_owner; then
        # Owner 刚创建 = 首次安装, 导入工作流
        # auto_import_workflows 内部会 exec n8n start, 不会返回
        auto_import_workflows
    fi
fi

# --- 正常运行: 等待 n8n 进程 ---
log "n8n is running (PID: ${N8N_PID})"
wait "$N8N_PID"
exit $?
