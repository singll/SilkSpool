#!/bin/bash
# ==============================================================================
#  Knowledge Bundle - Default Configuration Sources
#  描述: 定义配置文件的远程获取源，支持从官方仓库动态下载最新默认配置
#  用法: 由 runner.sh 的 init_defaults 函数调用
# ==============================================================================

# CONFIG_DEFAULTS 数组格式:
#   "本地相对路径|远程URL|处理方式"
#
# 处理方式 (可选):
#   - download: 直接下载 (默认)
#   - template: 下载后作为模板，用户需修改关键参数

declare -a CONFIG_DEFAULTS=(
    # RAGFlow nginx 配置 + 空默认站点 (本地生成)
    "ragflow/conf/ragflow.nginx.conf|LOCAL_TEMPLATE|download"
    "ragflow/conf/empty.conf|LOCAL_TEMPLATE|download"

    # .env 模板 (必须修改密码)
    ".env|LOCAL_TEMPLATE|template"
)

# 配置文件说明 (用于 init 时提示用户)
declare -A CONFIG_HINTS
CONFIG_HINTS[".env"]="[!] MUST MODIFY: All passwords starting with CHANGE_ME_"
CONFIG_HINTS["ragflow/conf/ragflow.nginx.conf"]="RAGFlow nginx frontend proxy configuration"

# ==============================================================================
#  特殊处理: 生成本地模板而非下载
#  当 URL 为 LOCAL_TEMPLATE 时，由 runner.sh 调用此函数生成
# ==============================================================================
generate_local_template() {
    local target_path=$1
    local local_path=$2

    case "$local_path" in
        ".env")
            cat > "$target_path" << 'EOF'
# ==============================================================================
#  Knowledge Stack Environment Variables
#  Description: This file contains sensitive credentials - DO NOT commit to git
# ==============================================================================

# --- Container Prefix ---
APP_PREFIX=sp-

# --- NFS Storage Paths (optional, for TrueNAS/NFS mounts) ---
# Uncomment and modify if using NFS; otherwise local Docker volumes are used
# NFS_DOCUMENTS=/data/documents
# NFS_MINIO=/data/minio
# NFS_LOGS=/data/logs

# --- RAGFlow Configuration ---
RAGFLOW_IMAGE=infiniflow/ragflow:v0.22.1
MYSQL_PASSWORD=CHANGE_ME_mysql_password
MINIO_USER=minio
MINIO_PASSWORD=CHANGE_ME_minio_password
REDIS_PASSWORD=CHANGE_ME_redis_password

# --- Firecrawl Configuration ---
POSTGRES_PASSWORD=CHANGE_ME_postgres_password
POSTGRES_DB=firecrawl
RABBITMQ_USER=firecrawl
RABBITMQ_PASSWORD=CHANGE_ME_rabbitmq_password

# --- n8n Configuration ---
N8N_PASSWORD=CHANGE_ME_n8n_password

# --- Knowledge Management Configuration ---
RAGFLOW_API_KEY=your-ragflow-api-key
KM_SECRET_KEY=CHANGE_ME_secret_key

# --- Memos Public URL (for OIDC SSO, optional) ---
# MEMOS_PUBLIC_URL=https://memos.example.com
EOF
            return 0
            ;;

        "ragflow/conf/ragflow.nginx.conf")
            cat > "$target_path" << 'NGINX_EOF'
server {
    listen 80;
    server_name _;
    root /ragflow/web/dist;

    gzip on;
    gzip_min_length 1k;
    gzip_comp_level 9;
    gzip_types text/plain application/javascript application/x-javascript text/css application/xml text/javascript application/x-httpd-php image/jpeg image/gif image/png;
    gzip_vary on;
    gzip_disable "MSIE [1-6]\.";

    client_max_body_size 1024m;

    location ~ ^/api/v1/admin {
        proxy_pass http://localhost:9381;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location ~ ^/(v1|api) {
        proxy_pass http://localhost:9380;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location / {
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location ~ ^/static/(css|js|media)/ {
        expires 10y;
        access_log off;
    }
}
NGINX_EOF
            return 0
            ;;

        "ragflow/conf/empty.conf")
            cat > "$target_path" << 'EOF'
# Empty file to disable default nginx site
EOF
            return 0
            ;;
    esac
    return 1
}
