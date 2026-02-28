#!/bin/bash
# ==============================================================================
#  Keeper Bundle - Default Configuration Sources
# ==============================================================================

declare -a CONFIG_DEFAULTS=(
    ".env|LOCAL_TEMPLATE|template"
)

declare -A CONFIG_HINTS
CONFIG_HINTS[".env"]="[!] MUST MODIFY: All passwords and KNOWLEDGE_HOST address"

generate_local_template() {
    local target_path=$1
    local local_path=$2

    case "$local_path" in
        ".env")
            cat > "$target_path" << 'EOF'
# ==============================================================================
#  Keeper Stack Environment Variables
# ==============================================================================

# --- 容器前缀 ---
APP_PREFIX=sp-

# --- 跨服务器通信 ---
# knowledge 服务器 IP (RAGFlow + Firecrawl 所在)
KNOWLEDGE_HOST=192.168.7.220

# --- Redis ---
REDIS_PASSWORD=CHANGE_ME_redis_password

# --- n8n ---
N8N_PASSWORD=CHANGE_ME_n8n_password
# 固定加密密钥 (重要! 确保凭证在容器重建后不丢失, 请生成随机字符串)
N8N_ENCRYPTION_KEY=CHANGE_ME_generate_random_string
# Owner 自动注册 (首次启动时自动创建管理员账号)
N8N_OWNER_EMAIL=admin@example.com

# --- Bellkeeper ---
BELLKEEPER_DB_PASSWORD=CHANGE_ME_bellkeeper_db_password
RAGFLOW_API_KEY=your-ragflow-api-key

# --- Memos ---
MEMOS_API_TOKEN=your-memos-api-token
# MEMOS_PUBLIC_URL=https://memos.example.com

# --- CouchDB (Obsidian LiveSync) ---
COUCHDB_USER=admin
COUCHDB_PASSWORD=CHANGE_ME_couchdb_password
COUCHDB_SECRET=CHANGE_ME_couchdb_secret
EOF
            return 0
            ;;
    esac
    return 1
}
