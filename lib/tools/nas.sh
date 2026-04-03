#!/bin/bash
# ==============================================================================
#  TrueNAS 管理命令
#  入口: ./spool.sh nas ...
#  认证: hosts/<NAS_HOST>/.env 中的 TRUENAS_API_KEY
# ==============================================================================

set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BASE_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
CORE_DIR="$BASE_DIR/lib/core"
RPC_PY="$CORE_DIR/truenas_rpc.py"

# shellcheck disable=SC1091
source "$CORE_DIR/env.sh"
ss_bootstrap
# shellcheck disable=SC1091
source "$CORE_DIR/confirm.sh"

NAS_HOST="${NAS_HOST:-truenas}"
TRUENAS_API_URL="${TRUENAS_API_URL:-}"
TRUENAS_API_USERNAME="${TRUENAS_API_USERNAME:-root}"
TRUENAS_API_VERIFY_TLS="${TRUENAS_API_VERIFY_TLS:-1}"
TRUENAS_RPC_TIMEOUT="${TRUENAS_RPC_TIMEOUT:-30}"
TRUENAS_JOB_TIMEOUT="${TRUENAS_JOB_TIMEOUT:-300}"
TRUENAS_DEFAULT_POOL="${TRUENAS_DEFAULT_POOL:-}"

HOST_ENV_FILE=$(ss_get_host_env_file "$NAS_HOST")
[ -f "$HOST_ENV_FILE" ] && ss_load_host_env "$NAS_HOST" || true

FLAG_YES=0
FLAG_CONFIRM=""
OPT_ARGS="[]"
OPT_RESOURCE=""
OPT_WAIT_JOB=0

ensure_config() {
    ss_require_env_var TRUENAS_API_URL "TRUENAS_API_URL is required in config.ini"
    ss_require_env_var TRUENAS_API_USERNAME "TRUENAS_API_USERNAME is required in config.ini"
    ss_require_env_var TRUENAS_API_KEY "TRUENAS_API_KEY is required in hosts/${NAS_HOST}/.env"
}

json_eq_query() {
    python3 - "$1" "$2" <<'PY'
import json
import sys
field = sys.argv[1]
raw = sys.argv[2]
try:
    value = int(raw)
except ValueError:
    value = raw
print(json.dumps([[[field, '=', value]], {'get': True}], ensure_ascii=False))
PY
}

json_single_arg() {
    python3 - "$1" <<'PY'
import json
import sys
print(json.dumps([sys.argv[1]], ensure_ascii=False))
PY
}

normalize_dir_create_args() {
    local resource=$1
    local args_json=${2:-"[]"}

    python3 - "$resource" "$args_json" <<'PY'
import json
import sys

resource = sys.argv[1]
raw = sys.argv[2]

try:
    data = json.loads(raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"Invalid JSON for --args: {exc}")

if data == []:
    payload = {"path": resource}
elif isinstance(data, dict):
    payload = data
elif isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
    payload = data[0]
elif isinstance(data, list) and len(data) >= 1 and isinstance(data[0], str):
    payload = {"path": data[0]}
    if len(data) >= 2:
        if not isinstance(data[1], dict):
            raise SystemExit("dir create --args second element must be an object")
        payload["options"] = data[1]
else:
    raise SystemExit("dir create --args must be [], a dict, or legacy [path, options]")

path = payload.get("path") or resource
if not path:
    raise SystemExit("dir create requires --resource or args.path")
payload["path"] = path

options = payload.get("options")
if options is None:
    options = {}
elif not isinstance(options, dict):
    raise SystemExit("dir create options must be an object")
payload["options"] = options

for key in ("mode", "raise_chmod_error"):
    if key in payload:
        options.setdefault(key, payload.pop(key))

options.setdefault("raise_chmod_error", False)

print(json.dumps([payload], ensure_ascii=False))
PY
}

parse_common_flags() {
    FLAG_YES=0
    FLAG_CONFIRM=""
    OPT_ARGS="[]"
    OPT_RESOURCE=""
    OPT_WAIT_JOB=0
    POSITIONAL=()

    while [ $# -gt 0 ]; do
        case "$1" in
            --args)
                shift
                OPT_ARGS="${1:-}"
                ;;
            --resource)
                shift
                OPT_RESOURCE="${1:-}"
                ;;
            --yes|-y)
                FLAG_YES=1
                ;;
            --confirm)
                shift
                FLAG_CONFIRM="${1:-}"
                ;;
            --wait-job)
                OPT_WAIT_JOB=1
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                POSITIONAL+=("$1")
                ;;
        esac
        shift || true
    done
}

run_rpc() {
    local method=$1
    local args_json=${2:-"[]"}
    local wait_job=${3:-0}

    local cmd=(python3 "$RPC_PY" --url "$TRUENAS_API_URL" --username "$TRUENAS_API_USERNAME" --timeout "$TRUENAS_RPC_TIMEOUT" --job-timeout "$TRUENAS_JOB_TIMEOUT")
    if ! ss_truthy "$TRUENAS_API_VERIFY_TLS"; then
        cmd+=(--insecure)
    fi
    cmd+=(call "$method" --args "$args_json")
    if [ "$wait_job" -eq 1 ]; then
        cmd+=(--wait-job)
    fi

    "${cmd[@]}"
}

render_json() {
    local payload=$1
    printf '%s\n' "$payload" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$payload"
}

execute_read() {
    local method=$1
    local args_json=${2:-"[]"}
    local output
    ensure_config
    output=$(run_rpc "$method" "$args_json" 0)
    render_json "$output"
}

execute_write() {
    local mode=$1
    local title=$2
    local method=$3
    local resource=$4
    local args_json=$5

    if [ -z "$resource" ]; then
        log_err "--resource is required for write operations"
        exit 1
    fi

    ss_print_action_summary "$title" "$resource" "$method" "$args_json"
    if [ "$mode" = "destructive" ]; then
        ss_require_destructive_confirmation "$resource" "$title"
    else
        ss_require_write_confirmation "$title" "$resource"
    fi

    local output
    output=$(run_rpc "$method" "$args_json" 1)
    render_json "$output"
}

show_help() {
    echo -e "${BLUE}TrueNAS Management${NC}"
    echo ""
    echo "Usage: ./spool.sh nas <group> <command> [options]"
    echo ""
    echo "Read commands:"
    echo "  nas info"
    echo "  nas pool list [--args '[]']"
    echo "  nas pool show <id>"
    echo "  nas dataset list [--args '[]']"
    echo "  nas dataset show <id>"
    echo "  nas dir list --args '[\"/mnt/tank\"]'"
    echo "  nas dir show <path>"
    echo "  nas snapshot list [--args '[]']"
    echo "  nas snapshot show <id>"
    echo "  nas rpc call <method> [--args '[]'] [--wait-job]"
    echo ""
    echo "Write commands (require --yes):"
    echo "  nas pool create --resource <name> --args '[...]' --yes"
    echo "  nas pool update --resource <name> --args '[...]' --yes"
    echo "  nas dataset create --resource <name> --args '[...]' --yes"
    echo "  nas dataset update --resource <name> --args '[...]' --yes"
    echo "  nas dir create --resource <path> --args '[...]' --yes"
    echo "  nas snapshot create --resource <id> --args '[...]' --yes"
    echo ""
    echo "Destructive commands (require --yes + exact confirmation):"
    echo "  nas pool delete --resource <name> --args '[...]' --yes --confirm <name>"
    echo "  nas dataset delete --resource <name> --args '[...]' --yes --confirm <name>"
    echo "  nas dir delete --resource <path> --args '[...]' --yes --confirm <path>"
    echo "  nas snapshot delete --resource <id> --args '[...]' --yes --confirm <id>"
    echo "  nas snapshot rollback --resource <id> --args '[...]' --yes --confirm <id>"
    echo ""
    echo "Notes:"
    echo "  - --args must be a JSON array matching the TrueNAS JSON-RPC method signature"
    echo "  - pool delete maps to pool.export (TrueNAS pool removal workflow)"
    echo "  - dir create/delete map to filesystem.mkdir / filesystem.rmdir"
    echo "  - API key auth requires a TLS URL (https://... or wss://...)"
    echo ""
    echo "Current config:"
    echo "  NAS_HOST:             ${NAS_HOST}"
    echo "  TRUENAS_API_URL:      ${TRUENAS_API_URL}"
    echo "  TRUENAS_API_USERNAME: ${TRUENAS_API_USERNAME}"
    echo "  TRUENAS_API_KEY:      Read from hosts/${NAS_HOST}/.env"
    echo "  TRUENAS_DEFAULT_POOL: ${TRUENAS_DEFAULT_POOL:-<unset>}"
}

rpc_dispatch() {
    local action=${1:-help}
    shift || true

    case "$action" in
        call)
            local method=${1:-}
            shift || true
            [ -z "$method" ] && log_err "Usage: ./spool.sh nas rpc call <method> [--args '[]'] [--wait-job]" && exit 1
            parse_common_flags "$@"
            ensure_config
            local output
            output=$(run_rpc "$method" "$OPT_ARGS" "$OPT_WAIT_JOB")
            render_json "$output"
            ;;
        *)
            show_help
            exit 1
            ;;
    esac
}

pool_dispatch() {
    local action=${1:-help}
    shift || true

    case "$action" in
        list)
            parse_common_flags "$@"
            execute_read "pool.query" "$OPT_ARGS"
            ;;
        show)
            local pool_id=${1:-}
            [ -z "$pool_id" ] && log_err "Usage: ./spool.sh nas pool show <id>" && exit 1
            execute_read "pool.query" "$(json_eq_query id "$pool_id")"
            ;;
        create)
            parse_common_flags "$@"
            execute_write normal "Creating pool" "pool.create" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        update)
            parse_common_flags "$@"
            execute_write normal "Updating pool" "pool.update" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        delete)
            parse_common_flags "$@"
            execute_write destructive "Deleting pool" "pool.export" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        *)
            show_help
            exit 1
            ;;
    esac
}

dataset_dispatch() {
    local action=${1:-help}
    shift || true

    case "$action" in
        list)
            parse_common_flags "$@"
            execute_read "pool.dataset.query" "$OPT_ARGS"
            ;;
        show)
            local dataset_id=${1:-}
            [ -z "$dataset_id" ] && log_err "Usage: ./spool.sh nas dataset show <id>" && exit 1
            execute_read "pool.dataset.query" "$(json_eq_query id "$dataset_id")"
            ;;
        create)
            parse_common_flags "$@"
            execute_write normal "Creating dataset" "pool.dataset.create" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        update)
            parse_common_flags "$@"
            execute_write normal "Updating dataset" "pool.dataset.update" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        delete)
            parse_common_flags "$@"
            execute_write destructive "Deleting dataset" "pool.dataset.delete" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        *)
            show_help
            exit 1
            ;;
    esac
}

dir_dispatch() {
    local action=${1:-help}
    shift || true

    case "$action" in
        list)
            parse_common_flags "$@"
            execute_read "filesystem.listdir" "$OPT_ARGS"
            ;;
        show)
            local path=${1:-}
            [ -z "$path" ] && log_err "Usage: ./spool.sh nas dir show <path>" && exit 1
            execute_read "filesystem.stat" "$(json_single_arg "$path")"
            ;;
        create)
            parse_common_flags "$@"
            local mkdir_args
            mkdir_args=$(normalize_dir_create_args "$OPT_RESOURCE" "$OPT_ARGS") || exit 1
            execute_write normal "Creating directory" "filesystem.mkdir" "$OPT_RESOURCE" "$mkdir_args"
            ;;
        delete)
            parse_common_flags "$@"
            execute_write destructive "Deleting directory" "filesystem.rmdir" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        *)
            show_help
            exit 1
            ;;
    esac
}

snapshot_dispatch() {
    local action=${1:-help}
    shift || true

    case "$action" in
        list)
            parse_common_flags "$@"
            execute_read "pool.snapshot.query" "$OPT_ARGS"
            ;;
        show)
            local snapshot_id=${1:-}
            [ -z "$snapshot_id" ] && log_err "Usage: ./spool.sh nas snapshot show <id>" && exit 1
            execute_read "pool.snapshot.query" "$(json_eq_query id "$snapshot_id")"
            ;;
        create)
            parse_common_flags "$@"
            execute_write normal "Creating snapshot" "pool.snapshot.create" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        delete)
            parse_common_flags "$@"
            execute_write destructive "Deleting snapshot" "pool.snapshot.delete" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        rollback)
            parse_common_flags "$@"
            execute_write destructive "Rolling back snapshot" "pool.snapshot.rollback" "$OPT_RESOURCE" "$OPT_ARGS"
            ;;
        *)
            show_help
            exit 1
            ;;
    esac
}

main() {
    local group=${1:-help}
    shift || true

    case "$group" in
        info)
            execute_read "system.info" "[]"
            ;;
        rpc)
            rpc_dispatch "$@"
            ;;
        pool)
            pool_dispatch "$@"
            ;;
        dataset)
            dataset_dispatch "$@"
            ;;
        dir)
            dir_dispatch "$@"
            ;;
        snapshot)
            snapshot_dispatch "$@"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_err "Unknown nas command group: $group"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
