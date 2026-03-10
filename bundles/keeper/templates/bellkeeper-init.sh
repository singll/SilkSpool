#!/bin/sh
# ==============================================================================
#  Bellkeeper 入口脚本 - 环境变量热加载
#
#  核心功能:
#    从挂载的 .env 文件动态加载环境变量
#    → docker compose restart 即可加载新配置, 无需 up -d 重建容器
#    → 不重建容器 = 数据卷天然持久, 数据库连接/配置不会丢失
# ==============================================================================

ENV_FILE="/app/config/.env"

log() { echo "[bellkeeper-init] $*"; }

# --- 从挂载的 .env 加载环境变量 ---
if [ -f "$ENV_FILE" ]; then
    log "Loading environment from mounted .env"
    set -a
    . "$ENV_FILE"
    set +a
else
    log "WARNING: No .env file at $ENV_FILE, using Docker env vars only"
fi

# --- 派生变量 (从 .env 原始值构造 Bellkeeper 所需的完整配置) ---
PREFIX="${APP_PREFIX:-sp-}"

# Server
export BELLKEEPER_SERVER_MODE="${BELLKEEPER_SERVER_MODE:-release}"
export BELLKEEPER_SERVER_HOST="${BELLKEEPER_SERVER_HOST:-0.0.0.0}"
export BELLKEEPER_SERVER_PORT="${BELLKEEPER_SERVER_PORT:-8080}"
export BELLKEEPER_SERVER_API_KEY="${BELLKEEPER_API_KEY:-}"

# Database (本机 PostgreSQL)
export BELLKEEPER_DATABASE_DRIVER="${BELLKEEPER_DATABASE_DRIVER:-postgres}"
export BELLKEEPER_DATABASE_HOST="${BELLKEEPER_DATABASE_HOST:-${PREFIX}bellkeeper-db}"
export BELLKEEPER_DATABASE_PORT="${BELLKEEPER_DATABASE_PORT:-5432}"
export BELLKEEPER_DATABASE_NAME="${BELLKEEPER_DATABASE_NAME:-bellkeeper}"
export BELLKEEPER_DATABASE_USER="${BELLKEEPER_DATABASE_USER:-bellkeeper}"
export BELLKEEPER_DATABASE_PASSWORD="${BELLKEEPER_DB_PASSWORD:-bellkeeper123}"

# RagFlow (跨服务器访问 knowledge)
export BELLKEEPER_RAGFLOW_BASE_URL="${BELLKEEPER_RAGFLOW_BASE_URL:-http://${KNOWLEDGE_HOST:-192.168.7.220}:8080}"
export BELLKEEPER_RAGFLOW_API_KEY="${RAGFLOW_API_KEY:-}"

# n8n (同机访问)
export BELLKEEPER_N8N_WEBHOOK_BASE_URL="${BELLKEEPER_N8N_WEBHOOK_BASE_URL:-http://${PREFIX}n8n:5678}"
export BELLKEEPER_N8N_API_BASE_URL="${BELLKEEPER_N8N_API_BASE_URL:-http://${PREFIX}n8n:5678/api/v1}"
export BELLKEEPER_N8N_API_KEY="${N8N_API_KEY:-}"

# LLM Proxy (由 bellkeeper.yaml 中 ${VAR} 引用)
export LLM_NEWAPI_BASE_URL="${LLM_NEWAPI_BASE_URL:-}"
export LLM_NEWAPI_API_KEY="${LLM_NEWAPI_API_KEY:-}"
export LLM_DEEPSEEK_API_KEY="${LLM_DEEPSEEK_API_KEY:-}"
export LLM_KIMI_API_KEY="${LLM_KIMI_API_KEY:-}"
export LLM_SILICONFLOW_API_KEY="${LLM_SILICONFLOW_API_KEY:-}"
export LLM_QWEN_API_KEY="${LLM_QWEN_API_KEY:-}"

# --- 清理: 移除 Bellkeeper 不需要的敏感变量 ---
unset REDIS_PASSWORD COUCHDB_SECRET N8N_PASSWORD N8N_ENCRYPTION_KEY

# --- 启动 Bellkeeper (exec 替换当前进程, bellkeeper 作为 PID 1) ---
log "Starting Bellkeeper..."
exec /app/bellkeeper serve
