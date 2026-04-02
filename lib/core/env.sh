#!/bin/bash
# ==============================================================================
#  共享环境与配置加载 helper
# ==============================================================================

if [ -n "${SILKSPOOL_ENV_HELPER_LOADED:-}" ]; then
    return 0 2>/dev/null || exit 0
fi
SILKSPOOL_ENV_HELPER_LOADED=1

SS_CORE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SS_BASE_DIR=$(cd "$SS_CORE_DIR/../.." && pwd)
SS_CONFIG_FILE="$SS_BASE_DIR/config.ini"

ss_require_config() {
    if [ ! -f "$SS_CONFIG_FILE" ]; then
        echo "[ERR] config.ini not found"
        echo "Hint: Run 'cp config.ini.example config.ini' and edit as needed"
        exit 1
    fi
}

ss_require_config
# shellcheck disable=SC1090
source "$SS_CONFIG_FILE"

ss_load_config() {
    ss_require_config
}

ss_load_utils() {
    # shellcheck disable=SC1091
    source "$SS_CORE_DIR/utils.sh"
}

ss_normalize_ssh_key_path() {
    if [ -n "${SSH_KEY_PATH:-}" ] && [[ "$SSH_KEY_PATH" == ./* ]]; then
        export SSH_KEY_PATH="$SS_BASE_DIR/${SSH_KEY_PATH#./}"
    fi
}

ss_bootstrap() {
    ss_load_config
    ss_load_utils
    ss_normalize_ssh_key_path
}

ss_get_host_conn() {
    local host=$1
    local conn="${HOST_INFO[$host]:-}"

    if [ -z "$conn" ]; then
        conn="${HOST_INFO[${host//_/-}]:-}"
    fi

    printf '%s\n' "$conn"
}

ss_require_host_conn() {
    local host=$1
    local conn
    conn=$(ss_get_host_conn "$host")

    if [ -z "$conn" ]; then
        log_err "Unknown host: $host"
        exit 1
    fi

    printf '%s\n' "$conn"
}

ss_get_host_env_file() {
    local host=$1
    printf '%s\n' "$SS_BASE_DIR/hosts/$host/.env"
}

ss_load_host_env() {
    local host=$1
    local env_file
    env_file=$(ss_get_host_env_file "$host")

    if [ ! -f "$env_file" ]; then
        return 1
    fi

    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    export SS_HOST_ENV_FILE="$env_file"
    return 0
}

ss_require_env_var() {
    local var_name=$1
    local message=${2:-"$var_name is required"}

    if [ -z "${!var_name:-}" ]; then
        log_err "$message"
        exit 1
    fi
}

ss_truthy() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}
