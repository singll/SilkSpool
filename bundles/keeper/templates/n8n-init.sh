#!/bin/sh
# ==============================================================================
#  n8n 入口脚本 - 环境变量热加载
#
#  核心功能:
#    从挂载的 .env 文件动态加载环境变量
#    → docker compose restart 即可加载新配置, 无需 up -d 重建容器
#    → 不重建容器 = 数据卷天然持久, 账号/工作流/凭证不会丢失
# ==============================================================================

ENV_FILE="/home/node/config/.env"

log() { echo "[n8n-init] $*"; }

# --- 从挂载的 .env 加载环境变量 ---
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

# --- 启动 n8n (exec 替换当前进程, n8n 作为 PID 1) ---
log "Starting n8n..."
exec n8n start
