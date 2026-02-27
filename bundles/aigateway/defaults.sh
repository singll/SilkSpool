#!/bin/bash
# ==============================================================================
#  AI Gateway Bundle - Default Configuration Sources
# ==============================================================================

declare -a CONFIG_DEFAULTS=(
    ".env|LOCAL_TEMPLATE|template"
)

declare -A CONFIG_HINTS
CONFIG_HINTS[".env"]="[!] MUST MODIFY: All passwords starting with CHANGE_ME_"

generate_local_template() {
    local target_path=$1
    local local_path=$2

    case "$local_path" in
        ".env")
            cat > "$target_path" << 'EOF'
# ==============================================================================
#  AI Gateway Environment Variables
# ==============================================================================

# --- 容器前缀 ---
APP_PREFIX=sp-

# --- Redis ---
REDIS_PASSWORD=CHANGE_ME_redis_password

# --- New API (AI Model Gateway) ---
NEWAPI_DB_PASSWORD=CHANGE_ME_newapi_db_password
EOF
            return 0
            ;;
    esac
    return 1
}
