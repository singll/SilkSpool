#!/bin/bash
# ==============================================================================
#  n8n 工作流管理脚本
#  用途: 通过 n8n REST API 导入/导出/更新工作流
#  入口: ./spool.sh n8n
# ==============================================================================

set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BASE_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
CORE_DIR="$BASE_DIR/lib/core"

# shellcheck disable=SC1091
source "$CORE_DIR/env.sh"
ss_bootstrap

N8N_HOST="${N8N_HOST:-keeper}"
N8N_CONTAINER="${N8N_CONTAINER:-sp-n8n}"
N8N_WORKFLOW_DIR="${N8N_WORKFLOW_DIR:-/opt/silkspool/keeper/n8n-workflows}"
N8N_API_URL="${N8N_API_URL:-http://localhost:5678}"
CONFIG_N8N_API_KEY="${N8N_API_KEY:-}"
N8N_API_KEY=""
LEGACY_N8N_API_KEY_USED=0

HOST_ENV_FILE=$(ss_get_host_env_file "$N8N_HOST")
HOST_ENV_HAS_N8N_API_KEY=0
if [ -f "$HOST_ENV_FILE" ] && grep -q '^N8N_API_KEY=' "$HOST_ENV_FILE"; then
    HOST_ENV_HAS_N8N_API_KEY=1
fi
if [ -f "$HOST_ENV_FILE" ]; then
    ss_load_host_env "$N8N_HOST" || true
fi
if [ "$HOST_ENV_HAS_N8N_API_KEY" -eq 1 ]; then
    N8N_API_KEY="${N8N_API_KEY:-}"
elif [ -n "$CONFIG_N8N_API_KEY" ]; then
    N8N_API_KEY="$CONFIG_N8N_API_KEY"
    LEGACY_N8N_API_KEY_USED=1
fi

LOCAL_WORKFLOW_DIR="$BASE_DIR/hosts/${N8N_HOST}/n8n-workflows"
SSH_KEY="${SSH_KEY_PATH:-$BASE_DIR/keys/id_silkspool}"
HOST_CONN=$(ss_get_host_conn "$N8N_HOST")
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
[ -f "$SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

log_error() { log_err "$1"; }

remote_exec() {
    local command=$1
    if [ -n "$HOST_CONN" ]; then
        ssh -n $SSH_OPTS "$HOST_CONN" "$command"
    else
        bash -lc "$command"
    fi
}

warn_legacy_api_key_source() {
    if [ "$LEGACY_N8N_API_KEY_USED" -eq 1 ]; then
        log_warn "N8N_API_KEY is still read from config.ini; move it to hosts/${N8N_HOST}/.env"
    fi
}

check_api_key() {
    if [ -z "$N8N_API_KEY" ]; then
        log_error "n8n API Key not configured"
        echo ""
        echo "Please follow these steps to create an API Key:"
        echo "  1. Open n8n Web UI"
        echo "  2. Click avatar (top right) -> Settings -> API Keys"
        echo "  3. Click 'Create an API key'"
        echo "  4. Copy the generated key"
        echo "  5. Add it to hosts/${N8N_HOST}/.env as N8N_API_KEY=..."
        echo ""
        if [ -n "$CONFIG_N8N_API_KEY" ]; then
            echo "Legacy fallback detected in config.ini, but the current command prefers hosts/${N8N_HOST}/.env"
            echo ""
        fi
        exit 1
    fi

    warn_legacy_api_key_source
}

check_container() {
    log_step "Checking n8n container status"
    if ! remote_exec "docker ps --format '{{.Names}}' | grep -q '^${N8N_CONTAINER}$'"; then
        log_error "n8n container ${N8N_CONTAINER} not running"
        exit 1
    fi
    log_info "n8n container ${N8N_CONTAINER} is running"
}

call_n8n_api() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    local curl_cmd="curl -s -X $method '${N8N_API_URL}/api/v1${endpoint}' \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -H 'X-N8N-API-KEY: $N8N_API_KEY'"

    if [ -n "$data" ]; then
        curl_cmd="$curl_cmd -d '$data'"
    fi

    remote_exec "$curl_cmd"
}

api_list_workflows() {
    call_n8n_api "GET" "/workflows"
}

clean_workflow_json() {
    python3 -c "
import sys, json

data = json.load(sys.stdin)
allowed_keys = ['name', 'nodes', 'connections', 'settings']
clean_data = {k: data[k] for k in allowed_keys if k in data}
if 'name' not in clean_data:
    clean_data['name'] = 'Unnamed Workflow'
if 'nodes' not in clean_data:
    clean_data['nodes'] = []
if 'connections' not in clean_data:
    clean_data['connections'] = {}
if 'settings' not in clean_data:
    clean_data['settings'] = {'executionOrder': 'v1'}
allowed_settings = ['executionOrder', 'saveManualExecutions', 'callerPolicy', 'errorWorkflow', 'timezone']
clean_data['settings'] = {k: v for k, v in clean_data.get('settings', {}).items() if k in allowed_settings}
if not clean_data['settings']:
    clean_data['settings'] = {'executionOrder': 'v1'}
print(json.dumps(clean_data))
" 2>/dev/null
}

api_create_workflow() {
    local json_file="$1"
    local json_content
    json_content=$(remote_exec "cat '$json_file'")

    local clean_json
    clean_json=$(printf '%s' "$json_content" | clean_workflow_json)
    if [ -z "$clean_json" ]; then
        return 1
    fi

    local json_base64
    json_base64=$(printf '%s' "$clean_json" | base64 -w 0)

    remote_exec "echo '$json_base64' | base64 -d > /tmp/wf-import.json && curl -s -X POST '${N8N_API_URL}/api/v1/workflows' \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -H 'X-N8N-API-KEY: ${N8N_API_KEY}' \
        -d @/tmp/wf-import.json && rm -f /tmp/wf-import.json"
}

api_update_workflow() {
    local workflow_id="$1"
    local json_file="$2"
    local json_content
    json_content=$(python3 -c "import sys; print(open(sys.argv[1], 'r', encoding='utf-8').read())" "$json_file" 2>/dev/null)

    local clean_json
    clean_json=$(printf '%s' "$json_content" | clean_workflow_json)
    if [ -z "$clean_json" ]; then
        return 1
    fi

    local json_base64
    json_base64=$(printf '%s' "$clean_json" | base64 -w 0)

    remote_exec "echo '$json_base64' | base64 -d > /tmp/wf-update.json && curl -s -X PUT '${N8N_API_URL}/api/v1/workflows/${workflow_id}' \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -H 'X-N8N-API-KEY: ${N8N_API_KEY}' \
        -d @/tmp/wf-update.json && rm -f /tmp/wf-update.json"
}

api_toggle_workflow() {
    local workflow_id="$1"
    local active="$2"

    if [ "$active" = "true" ]; then
        call_n8n_api "POST" "/workflows/${workflow_id}/activate"
    else
        call_n8n_api "POST" "/workflows/${workflow_id}/deactivate"
    fi
}

list_local_workflows() {
    log_info "Local workflow files (${LOCAL_WORKFLOW_DIR})"
    echo ""

    if [ ! -d "$LOCAL_WORKFLOW_DIR" ]; then
        log_error "Local workflow directory not found: $LOCAL_WORKFLOW_DIR"
        exit 1
    fi

    ls -1 "${LOCAL_WORKFLOW_DIR}"/*.json 2>/dev/null | while read -r file; do
        name=$(basename "$file")
        if [[ "$name" == "00-config.json" ]]; then
            echo "  - $name (config reference, skip import)"
        else
            echo "  - $name"
        fi
    done
    echo ""
}

list_remote_workflows() {
    log_info "Remote workflow files (${N8N_WORKFLOW_DIR})"
    echo ""
    remote_exec "ls -1 '${N8N_WORKFLOW_DIR}'/*.json 2>/dev/null" | while read -r file; do
        name=$(basename "$file")
        if [[ "$name" == "00-config.json" ]]; then
            echo "  - $name (config reference, skip import)"
        else
            echo "  - $name"
        fi
    done
    echo ""
}

list_n8n_workflows() {
    log_info "Existing workflows in n8n"
    echo ""

    local result
    result=$(api_list_workflows)

    if echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
        echo "$result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    workflows = data.get('data', [])
    if not workflows:
        print('  (No workflows)')
    for workflow in workflows:
        status = 'Active' if workflow.get('active') else 'Inactive'
        print(f\"  - {workflow.get('name')} ({status})\")
except Exception as exc:
    print(f'  Parse failed: {exc}')
" 2>/dev/null
    else
        local error_msg
        error_msg=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("message","Unknown error"))' 2>/dev/null || echo "API call failed")
        log_error "API call failed: $error_msg"
        return 1
    fi
    echo ""
}

import_all() {
    check_api_key
    check_container

    log_step "Starting workflow import"
    echo ""

    log_info "Checking existing workflows in n8n"
    local existing_result
    existing_result=$(api_list_workflows)

    local existing_names=""
    if echo "$existing_result" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
        existing_names=$(echo "$existing_result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for workflow in data.get('data', []):
        print(workflow.get('name', ''))
except Exception:
    pass
" 2>/dev/null)
    else
        local error_msg
        error_msg=$(echo "$existing_result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("message","Unknown error"))' 2>/dev/null || echo "API call failed")
        log_error "Failed to fetch existing workflows: $error_msg"
        exit 1
    fi

    local files_output
    files_output=$(remote_exec "ls -1 '${N8N_WORKFLOW_DIR}'/*.json 2>/dev/null")

    if [ -z "$files_output" ]; then
        log_error "No workflow files in remote directory: $N8N_WORKFLOW_DIR"
        log_info "Please run ./spool.sh sync push $N8N_HOST first to push workflow files"
        exit 1
    fi

    local success=0
    local failed=0
    local skipped=0
    local files=()
    readarray -t files <<< "$files_output"

    echo ""
    for file in "${files[@]}"; do
        [ -z "$file" ] && continue

        local filename
        filename=$(basename "$file")
        if [[ "$filename" == "00-config.json" ]]; then
            log_warn "Skipping config reference: $filename"
            continue
        fi

        local wf_name
        wf_name=$(remote_exec "python3 -c \"import json; print(json.load(open('$file')).get('name',''))\"" 2>/dev/null)

        if echo "$existing_names" | grep -qxF "$wf_name"; then
            log_warn "Skipping existing: $wf_name ($filename)"
            ((skipped++)) || true
            continue
        fi

        log_info "Importing workflow: $wf_name ($filename)"
        local result
        result=$(api_create_workflow "$file")

        if echo "$result" | grep -q '"id"'; then
            local new_id
            new_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
            log_success "Created (id: $new_id)"
            ((success++)) || true
        else
            local error_msg
            error_msg=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','Unknown error'))" 2>/dev/null)
            log_error "Creation failed: $error_msg"
            ((failed++)) || true
        fi
    done

    echo ""
    log_info "Import completed: $success succeeded, $skipped skipped"
    [ $failed -gt 0 ] && log_warn "$failed failed"
    [ $success -gt 0 ] && log_warn "Newly imported workflows are inactive by default; activate them in n8n UI"
}

export_all() {
    check_api_key
    check_container

    log_step "Exporting all workflows from n8n"
    local backup_dir="${LOCAL_WORKFLOW_DIR}/backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup_dir"

    local result
    result=$(api_list_workflows)
    if echo "$result" | grep -q '"message"'; then
        log_error "API call failed"
        exit 1
    fi

    echo "$result" | python3 -c "
import sys, json, os
backup_dir = '${backup_dir}'
data = json.load(sys.stdin)
workflows = data.get('data', [])
print(f'Exporting {len(workflows)} workflows to {backup_dir}')
for workflow in workflows:
    name = workflow.get('name', 'unnamed').replace('/', '-')
    filename = os.path.join(backup_dir, f'{name}.json')
    with open(filename, 'w', encoding='utf-8') as fh:
        json.dump(workflow, fh, ensure_ascii=False, indent=2)
    print(f'  [OK] {name}.json')
" 2>/dev/null

    log_info "Export completed: $backup_dir"
}

push_and_import() {
    log_step "Pushing workflow files to remote server"
    bash "$BASE_DIR/lib/core/sync.sh" push "$N8N_HOST"
    echo ""
    import_all
}

get_workflow_id_by_name() {
    local name="$1"
    local result
    result=$(api_list_workflows)

    echo "$result" | python3 -c "
import sys, json
name = '$name'
try:
    data = json.load(sys.stdin)
    for workflow in data.get('data', []):
        if workflow.get('name') == name:
            print(workflow.get('id', ''))
            break
except Exception:
    pass
" 2>/dev/null
}

update_workflow() {
    local target_name="$1"

    check_api_key
    check_container

    if [ -z "$target_name" ]; then
        log_error "Usage: n8n update <workflow-name>"
        echo "Example: n8n update M03-知识问答处理器"
        exit 1
    fi

    log_step "Updating workflow: $target_name"

    local workflow_id
    workflow_id=$(get_workflow_id_by_name "$target_name")
    if [ -z "$workflow_id" ]; then
        log_error "Workflow not found in n8n: $target_name"
        exit 1
    fi

    log_info "Found workflow ID: $workflow_id"

    local found_file=""
    while IFS= read -r file; do
        [ -z "$file" ] && continue
        local filename
        filename=$(basename "$file")
        [[ "$filename" == "00-config.json" ]] && continue

        local wf_name
        wf_name=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8')).get('name',''))" "$file" 2>/dev/null)
        if [ "$wf_name" = "$target_name" ]; then
            found_file="$file"
            break
        fi
    done < <(compgen -G "$LOCAL_WORKFLOW_DIR/*.json")

    if [ -z "$found_file" ]; then
        log_error "Workflow file not found in local dir: $LOCAL_WORKFLOW_DIR ($target_name)"
        exit 1
    fi

    log_info "Updating from file: $(basename "$found_file")"
    local result
    result=$(api_update_workflow "$workflow_id" "$found_file")

    if echo "$result" | grep -q '"id"'; then
        log_success "Workflow updated successfully"
    else
        local error_msg
        error_msg=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','Unknown error'))" 2>/dev/null)
        log_error "Update failed: $error_msg"
        exit 1
    fi
}

update_all() {
    check_api_key
    check_container

    log_step "Updating all existing workflows"
    echo ""

    local existing_result
    existing_result=$(api_list_workflows)

    local success=0
    local failed=0
    local skipped=0

    while IFS= read -r file; do
        [ -z "$file" ] && continue
        local filename
        filename=$(basename "$file")
        [[ "$filename" == "00-config.json" ]] && continue

        local wf_name
        wf_name=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8')).get('name',''))" "$file" 2>/dev/null)
        [ -z "$wf_name" ] && continue

        local workflow_id
        workflow_id=$(echo "$existing_result" | python3 -c "
import sys, json
name = '$wf_name'
try:
    data = json.load(sys.stdin)
    for workflow in data.get('data', []):
        if workflow.get('name') == name:
            print(workflow.get('id', ''))
            break
except Exception:
    pass
" 2>/dev/null)

        if [ -z "$workflow_id" ]; then
            log_warn "Skipping (not in n8n): $wf_name"
            ((skipped++)) || true
            continue
        fi

        log_info "Updating: $wf_name ($filename)"
        local result
        result=$(api_update_workflow "$workflow_id" "$file")

        if echo "$result" | grep -q '"id"'; then
            log_success "Updated"
            ((success++)) || true
        else
            local error_msg
            error_msg=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','Unknown error'))" 2>/dev/null)
            log_error "$error_msg"
            ((failed++)) || true
        fi
    done < <(compgen -G "$LOCAL_WORKFLOW_DIR/*.json")

    echo ""
    log_info "Update completed: $success updated, $skipped skipped"
    [ $failed -gt 0 ] && log_warn "$failed failed"
}

activate_workflow() {
    local target_name="$1"
    check_api_key
    check_container

    local workflow_id
    workflow_id=$(get_workflow_id_by_name "$target_name")
    [ -z "$workflow_id" ] && log_error "Workflow not found: $target_name" && exit 1

    log_info "Activating: $target_name"
    local result
    result=$(api_toggle_workflow "$workflow_id" "true")
    echo "$result" | grep -q '"active":true' && log_success "Activated" || { log_error "Activation failed"; exit 1; }
}

deactivate_workflow() {
    local target_name="$1"
    check_api_key
    check_container

    local workflow_id
    workflow_id=$(get_workflow_id_by_name "$target_name")
    [ -z "$workflow_id" ] && log_error "Workflow not found: $target_name" && exit 1

    log_info "Deactivating: $target_name"
    local result
    result=$(api_toggle_workflow "$workflow_id" "false")
    echo "$result" | grep -q '"active":false' && log_success "Deactivated" || { log_error "Deactivation failed"; exit 1; }
}

delete_workflow() {
    local target_name="$1"
    check_api_key
    check_container

    local workflow_id
    workflow_id=$(get_workflow_id_by_name "$target_name")
    [ -z "$workflow_id" ] && log_error "Workflow not found: $target_name" && exit 1

    log_warn "Deleting: $target_name (ID: $workflow_id)"
    local result
    result=$(call_n8n_api "DELETE" "/workflows/${workflow_id}")

    if echo "$result" | grep -q '"id"'; then
        log_success "Deleted"
    else
        log_error "Deletion failed"
        exit 1
    fi
}

show_help() {
    echo -e "${BLUE}n8n Workflow Management${NC}"
    echo ""
    echo "Usage: ./spool.sh n8n <command>"
    echo ""
    echo "Commands:"
    echo "  list                List workflow files (local + remote + n8n)"
    echo "  import              Import NEW workflows to n8n via API"
    echo "  update [name]       Update EXISTING workflows (all or by name)"
    echo "  export              Export all workflows from n8n to local backup"
    echo "  push-import         Push local files to remote and import NEW"
    echo "  push-update [name]  Push local files to remote and update EXISTING"
    echo "  activate <name>     Activate a workflow"
    echo "  deactivate <name>   Deactivate a workflow"
    echo "  delete <name>       Delete a workflow from n8n"
    echo ""
    echo "API key path:"
    echo "  Preferred: hosts/${N8N_HOST}/.env -> N8N_API_KEY=..."
    echo "  Fallback:  config.ini -> N8N_API_KEY=... (migration only)"
    echo ""
    echo "Typical workflow:"
    echo "  1. Edit local hosts/${N8N_HOST}/n8n-workflows/*.json"
    echo "  2. First time:   ./spool.sh n8n push-import"
    echo "  3. Update later: ./spool.sh n8n push-update"
    echo ""
    echo "Current config:"
    echo "  N8N_HOST:          ${N8N_HOST}"
    echo "  N8N_WORKFLOW_DIR:  ${N8N_WORKFLOW_DIR}"
    echo "  N8N_API_URL:       ${N8N_API_URL}"
    if [ -n "$N8N_API_KEY" ]; then
        if [ "$LEGACY_N8N_API_KEY_USED" -eq 1 ]; then
            echo "  N8N_API_KEY:       Configured (legacy config.ini fallback)"
        else
            echo "  N8N_API_KEY:       Configured (hosts/${N8N_HOST}/.env)"
        fi
    else
        echo "  N8N_API_KEY:       Not configured"
    fi
}

main() {
    local cmd="${1:-help}"

    case "$cmd" in
        list)
            list_local_workflows
            [ -n "$HOST_CONN" ] && list_remote_workflows
            [ -n "$N8N_API_KEY" ] && check_container && list_n8n_workflows
            ;;
        import)
            import_all
            ;;
        update)
            shift
            if [ -n "$1" ]; then
                update_workflow "$1"
            else
                update_all
            fi
            ;;
        export)
            export_all
            ;;
        push-import)
            push_and_import
            ;;
        push-update)
            shift
            log_step "Pushing workflow files to remote server"
            bash "$BASE_DIR/lib/core/sync.sh" push "$N8N_HOST"
            echo ""
            if [ -n "$1" ]; then
                update_workflow "$1"
            else
                update_all
            fi
            ;;
        activate)
            shift
            [ -z "$1" ] && log_error "Usage: n8n activate <workflow-name>" && exit 1
            activate_workflow "$1"
            ;;
        deactivate)
            shift
            [ -z "$1" ] && log_error "Usage: n8n deactivate <workflow-name>" && exit 1
            deactivate_workflow "$1"
            ;;
        delete)
            shift
            [ -z "$1" ] && log_error "Usage: n8n delete <workflow-name>" && exit 1
            delete_workflow "$1"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "Unknown command: $cmd"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
