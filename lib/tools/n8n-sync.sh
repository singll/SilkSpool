#!/bin/bash
# ==============================================================================
#  n8n 工作流同步脚本 (REST API 版本)
#  用途: 通过 n8n REST API 导入/导出工作流
#  位置: 可通过 ./spool.sh n8n-sync 调用
#
#  使用前提: 需要在 n8n UI 中创建 API Key
#    1. 访问 n8n Web UI
#    2. 点击右上角头像 -> Settings -> API Keys
#    3. 创建新的 API Key，复制保存
#    4. 在 config.ini 中设置 N8N_API_KEY="your-key"
# ==============================================================================

set -e

# 获取脚本所在目录，定位项目根目录
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BASE_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
CONFIG_FILE="$BASE_DIR/config.ini"

# 加载配置
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

# 从配置获取设置
N8N_HOST="${N8N_HOST:-knowledge}"
N8N_CONTAINER="${N8N_CONTAINER:-sp-n8n}"
N8N_WORKFLOW_DIR="${N8N_WORKFLOW_DIR:-/opt/silkspool/knowledge/n8n-workflows}"
N8N_API_KEY="${N8N_API_KEY:-}"
N8N_API_URL="${N8N_API_URL:-http://localhost:5678}"

# 本地工作流目录
LOCAL_WORKFLOW_DIR="$BASE_DIR/hosts/${N8N_HOST}/n8n-workflows"

# SSH 配置
SSH_KEY="${SSH_KEY_PATH:-$BASE_DIR/keys/id_silkspool}"
if [[ "$SSH_KEY" == ./* ]]; then
    SSH_KEY="$BASE_DIR/${SSH_KEY#./}"
fi

# 获取主机信息
get_host_conn() {
    local host=$1
    local conn="${HOST_INFO[$host]}"
    [ -z "$conn" ] && conn="${HOST_INFO[${host//_/-}]}"
    echo "$conn"
}

HOST_CONN=$(get_host_conn "$N8N_HOST")
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
[ -f "$SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# 执行远程命令
remote_exec() {
    if [ -n "$HOST_CONN" ]; then
        ssh -n $SSH_OPTS "$HOST_CONN" "$@"
    else
        eval "$@"
    fi
}

# 检查 API Key 是否配置
check_api_key() {
    if [ -z "$N8N_API_KEY" ]; then
        log_error "n8n API Key not configured"
        echo ""
        echo "Please follow these steps to create an API Key:"
        echo "  1. Open n8n Web UI"
        echo "  2. Click avatar (top right) -> Settings -> API Keys"
        echo "  3. Click 'Create an API key'"
        echo "  4. Copy the generated key"
        echo "  5. Add to config.ini: N8N_API_KEY=\"your-key-here\""
        echo ""
        exit 1
    fi
}

# 检查容器是否运行
check_container() {
    log_step "Checking n8n container status..."
    if ! remote_exec "docker ps --format '{{.Names}}' | grep -q '^${N8N_CONTAINER}$'"; then
        log_error "n8n container ${N8N_CONTAINER} not running"
        exit 1
    fi
    log_info "n8n container ${N8N_CONTAINER} is running"
}

# 调用 n8n API (通过远程主机)
call_n8n_api() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    local curl_cmd="curl -s -X $method '${N8N_API_URL}/api/v1${endpoint}' \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -H 'X-N8N-API-KEY: ${N8N_API_KEY}'"

    if [ -n "$data" ]; then
        curl_cmd="$curl_cmd -d '$data'"
    fi

    remote_exec "$curl_cmd"
}

# 通过 API 获取所有工作流
api_list_workflows() {
    call_n8n_api "GET" "/workflows"
}

# 通过 API 创建工作流
api_create_workflow() {
    local json_file="$1"
    local json_content
    json_content=$(remote_exec "cat '$json_file'")

    # n8n API 只接受特定字段: name, nodes, connections, settings
    # 参考: https://community.n8n.io/t/request-body-should-not-have-additional-properties/18235
    local clean_json
    clean_json=$(echo "$json_content" | python3 -c "
import sys, json
data = json.load(sys.stdin)

# 只保留 API 允许的字段
allowed_keys = ['name', 'nodes', 'connections', 'settings']
clean_data = {k: data[k] for k in allowed_keys if k in data}

# 确保必要字段存在
if 'name' not in clean_data:
    clean_data['name'] = 'Unnamed Workflow'
if 'nodes' not in clean_data:
    clean_data['nodes'] = []
if 'connections' not in clean_data:
    clean_data['connections'] = {}
if 'settings' not in clean_data:
    clean_data['settings'] = {'executionOrder': 'v1'}

# 清理 settings 中的多余字段
allowed_settings = ['executionOrder', 'saveManualExecutions', 'callerPolicy', 'errorWorkflow', 'timezone']
clean_data['settings'] = {k: v for k, v in clean_data.get('settings', {}).items() if k in allowed_settings}
if not clean_data['settings']:
    clean_data['settings'] = {'executionOrder': 'v1'}

print(json.dumps(clean_data))
" 2>/dev/null)

    if [ -z "$clean_json" ]; then
        return 1
    fi

    # 创建工作流 - 将 JSON 写入临时文件避免 shell 转义问题
    local result
    result=$(remote_exec "echo '$clean_json' > /tmp/wf-import.json && curl -s -X POST '${N8N_API_URL}/api/v1/workflows' \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -H 'X-N8N-API-KEY: ${N8N_API_KEY}' \
        -d @/tmp/wf-import.json && rm -f /tmp/wf-import.json")

    echo "$result"
}

# 列出本地工作流文件
list_local_workflows() {
    log_info "Local workflow files (${LOCAL_WORKFLOW_DIR}):"
    echo ""

    if [ ! -d "$LOCAL_WORKFLOW_DIR" ]; then
        log_error "Local workflow directory not found: $LOCAL_WORKFLOW_DIR"
        exit 1
    fi

    ls -1 "${LOCAL_WORKFLOW_DIR}"/*.json 2>/dev/null | while read f; do
        name=$(basename "$f")
        if [[ "$name" == "00-config.json" ]]; then
            echo "  - $name (config reference, skip import)"
        else
            echo "  - $name"
        fi
    done
    echo ""
}

# 列出远程服务器上的工作流文件
list_remote_workflows() {
    log_info "Remote workflow files (${N8N_WORKFLOW_DIR}):"
    echo ""
    remote_exec "ls -1 '${N8N_WORKFLOW_DIR}'/*.json 2>/dev/null" | while read f; do
        name=$(basename "$f")
        if [[ "$name" == "00-config.json" ]]; then
            echo "  - $name (config reference, skip import)"
        else
            echo "  - $name"
        fi
    done
    echo ""
}

# 列出 n8n 中已存在的工作流
list_n8n_workflows() {
    log_info "Existing workflows in n8n:"
    echo ""

    local result
    result=$(api_list_workflows)

    if echo "$result" | grep -q '"message"'; then
        log_error "API call failed: $(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("message","Unknown error"))' 2>/dev/null)"
        return 1
    fi

    echo "$result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    workflows = data.get('data', [])
    if not workflows:
        print('  (No workflows)')
    for w in workflows:
        status = 'Active' if w.get('active') else 'Inactive'
        print(f\"  - {w.get('name')} ({status})\")
except Exception as e:
    print(f'  Parse failed: {e}')
" 2>/dev/null
    echo ""
}

# 通过 API 导入所有工作流
import_all() {
    check_api_key
    check_container

    log_step "Starting API workflow import..."
    echo ""

    # 获取已存在的工作流名称
    log_info "Checking existing workflows in n8n..."
    local existing_result
    existing_result=$(api_list_workflows)

    local existing_names=""
    if ! echo "$existing_result" | grep -q '"message"'; then
        existing_names=$(echo "$existing_result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for w in data.get('data', []):
        print(w.get('name', ''))
except:
    pass
" 2>/dev/null)
    fi

    # 获取远程文件列表
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

        local filename=$(basename "$file")

        # 跳过配置参考
        if [[ "$filename" == "00-config.json" ]]; then
            log_warn "Skipping config reference: $filename"
            continue
        fi

        # 获取工作流名称
        local wf_name
        wf_name=$(remote_exec "python3 -c \"import json; print(json.load(open('$file')).get('name',''))\"" 2>/dev/null)

        # 检查是否已存在
        if echo "$existing_names" | grep -qxF "$wf_name"; then
            log_warn "Skipping existing: $wf_name ($filename)"
            ((skipped++)) || true
            continue
        fi

        log_info "Importing workflow: $wf_name ($filename)"

        # 调用 API 创建
        local result
        result=$(api_create_workflow "$file")

        if echo "$result" | grep -q '"id"'; then
            local new_id
            new_id=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
            log_info "  [OK] Created (id: $new_id)"
            ((success++)) || true
        else
            local error_msg
            error_msg=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','Unknown error'))" 2>/dev/null)
            log_error "  [FAIL] Creation failed: $error_msg"
            ((failed++)) || true
        fi
    done

    echo ""
    log_info "Import completed: $success succeeded, $skipped skipped"
    [ $failed -gt 0 ] && log_warn "$failed failed"

    if [ $success -gt 0 ]; then
        log_warn "Note: Newly imported workflows are inactive by default. Activate them in n8n UI"
    fi
}

# 从 n8n 导出所有工作流
export_all() {
    check_api_key
    check_container

    log_step "Exporting all workflows from n8n..."

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

for w in workflows:
    name = w.get('name', 'unnamed').replace('/', '-')
    filename = os.path.join(backup_dir, f\"{name}.json\")
    with open(filename, 'w') as f:
        json.dump(w, f, ensure_ascii=False, indent=2)
    print(f'  [OK] {name}.json')
" 2>/dev/null

    log_info "Export completed: $backup_dir"
}

# 推送并导入
push_and_import() {
    log_step "Pushing workflow files to remote server..."
    bash "$BASE_DIR/lib/core/sync.sh" push "$N8N_HOST"

    echo ""
    import_all
}

# 显示帮助
show_help() {
    echo -e "${BLUE}n8n Workflow Sync Script (REST API Version)${NC}"
    echo ""
    echo "Usage: ./spool.sh n8n-sync <command>"
    echo ""
    echo "Commands:"
    echo "  list        List workflow files (local + remote + n8n)"
    echo "  import      Import all workflows to n8n via API"
    echo "  export      Export all workflows from n8n to local backup"
    echo "  push-import Push local files to remote and import to n8n"
    echo ""
    echo "First-time setup - create API Key:"
    echo "  1. Open n8n Web UI -> Settings -> API Keys"
    echo "  2. Create API Key and copy it"
    echo "  3. Add to config.ini: N8N_API_KEY=\"your-key\""
    echo ""
    echo "Typical workflow:"
    echo "  1. Edit local hosts/${N8N_HOST}/n8n-workflows/*.json"
    echo "  2. ./spool.sh sync push ${N8N_HOST}  (push to server)"
    echo "  3. ./spool.sh n8n-sync import        (import to n8n)"
    echo "  Or: ./spool.sh n8n-sync push-import  (one-click)"
    echo ""
    echo "Current config:"
    echo "  N8N_HOST:     ${N8N_HOST}"
    echo "  N8N_API_URL:  ${N8N_API_URL}"
    if [ -n "$N8N_API_KEY" ]; then
        echo "  N8N_API_KEY:  Configured"
    else
        echo "  N8N_API_KEY:  Not configured"
    fi
}

# 主函数
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
        export)
            export_all
            ;;
        push-import)
            push_and_import
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
