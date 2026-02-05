#!/bin/bash
# ==============================================================================
#  配置文件同步模块 (Sync Module)
#  功能:
#    1. 读取 config.ini 中的 RULES_XXX 规则
#    2. 使用 rsync 在本地 hosts/ 目录与远程服务器之间同步文件
#    3. 自动处理非 root 用户的 sudo 提权 (rsync --rsync-path)
#    4. 支持 post-push hooks (推送后执行自定义命令)
# ==============================================================================

# --- 1. 环境加载 ---
LIB_DIR=$(cd "$(dirname "$0")" && pwd)

if [ -f "$LIB_DIR/../../config.ini" ]; then
    source "$LIB_DIR/../../config.ini"
else
    echo "[ERR] config.ini not found"
    exit 1
fi
source "$LIB_DIR/utils.sh"

# --- 2. 参数解析 ---
CMD=$1   # 操作指令: pull (拉取) 或 push (推送)
HOST=$2  # 目标主机: host_alias 或 all
SSH_OPT="-i $SSH_KEY_PATH"

# ==============================================================================
#  函数: run_post_push_hooks
#  描述: 检查并执行 post-push hooks
#  参数: $1 - 主机别名, $2 - 已推送的本地文件路径
# ==============================================================================
run_post_push_hooks() {
    local host=$1
    local pushed_file=$2

    # 获取该主机的 hooks
    local hooks_str=$(get_post_push_hooks "$host")
    [ -z "$hooks_str" ] && return 0

    read -r -a hooks <<< "$hooks_str"
    local login=${HOST_INFO[$host]}

    for hook in "${hooks[@]}"; do
        local pattern="${hook%%:*}"   # 匹配模式
        local command="${hook#*:}"    # 执行命令

        # 检查推送的文件是否匹配 hook 模式
        if [[ "$pushed_file" == *"$pattern"* ]]; then
            log_info "Running post-push hook: $pattern"
            ssh -q $SSH_OPT "$login" "$command" 2>/dev/null
            if [ $? -eq 0 ]; then
                log_success "Hook succeeded: $command"
            else
                log_warn "Hook failed: $command"
            fi
        fi
    done
}

# ==============================================================================
#  函数: sync_host
#  描述: 处理单个主机的同步逻辑
#  参数: $1 - 主机别名 (host alias)
# ==============================================================================
sync_host() {
    local h=$1

    # 从 config.ini 的 HOST_INFO 中获取登录信息 (user@ip)
    local login=${HOST_INFO[$h]}

    # 如果主机未定义，直接返回
    if [ -z "$login" ]; then
        log_warn "Host $h not defined in HOST_INFO, skipping."
        return
    fi

    # 定义本地存储基准目录: SilkSpool/hosts/<host_alias>
    local HOST_BASE="$LIB_DIR/../../hosts/$h"

    # --- 构造 rsync 命令 ---
    local rsync_cmd="rsync -azc -e 'ssh $SSH_OPT' --out-format='%n'"

    # [关键优化] 权限提升处理
    local user="${login%%@*}"
    if [[ "$user" != "root" ]]; then
        rsync_cmd="$rsync_cmd --rsync-path='sudo rsync'"
    fi

    log_step "Syncing config: $h ($CMD)"

    # --- 读取同步规则 ---
    local rules_str=$(get_host_rules "$h")
    read -r -a rules <<< "$rules_str"

    if [ ${#rules[@]} -eq 0 ]; then
        log_warn "Host $h has no sync rules defined (RULES_${h^^} is empty)"
        return
    fi

    # 记录已推送的文件 (用于触发 hooks)
    local pushed_files=()

    # --- 遍历规则 ---
    for rule in "${rules[@]}"; do
        local loc="${rule%%:*}" # 冒号左边: 本地路径 (相对于 hosts/xxx/)
        local rem="${rule#*:}"  # 冒号右边: 远程绝对路径
        local loc_full="$HOST_BASE/$loc"

        # --- 分支: 拉取 (Pull) ---
        if [ "$CMD" == "pull" ]; then
            mkdir -p "$(dirname "$loc_full")"

            if eval $rsync_cmd "$login:$rem" "$loc_full"; then
                echo -e "  [v] Pulled: $loc"
            else
                echo -e "  [x] Pull failed: $loc (check remote path or rsync installation)"
            fi

        # --- 分支: 推送 (Push) ---
        else
            if [ -e "$loc_full" ]; then
                # 确保远程父目录存在 (通过 ssh 提前创建)
                local rem_dir=$(dirname "$rem")
                ssh -q $SSH_OPT "$login" "sudo mkdir -p '$rem_dir' && sudo chown \$(id -u):\$(id -g) '$rem_dir'" 2>/dev/null

                if eval $rsync_cmd "$loc_full" "$login:$rem"; then
                    echo -e "  [^] Pushed: $loc"
                    pushed_files+=("$loc")
                else
                    echo -e "  [x] Push failed: $loc"
                fi
            else
                log_warn "Local file missing, skipping push: $loc_full"
            fi
        fi
    done

    # --- 执行 post-push hooks ---
    if [ "$CMD" == "push" ] && [ ${#pushed_files[@]} -gt 0 ]; then
        for pf in "${pushed_files[@]}"; do
            run_post_push_hooks "$h" "$pf"
        done
    fi
}

# ==============================================================================
#  可导出函数 (供其他模块调用)
# ==============================================================================

# 同步单个文件
# 用法: sync_single_file <host> <cmd> <local_path>
# 参数:
#   host       - 主机别名
#   cmd        - pull 或 push
#   local_path - 本地相对路径 (相对于 hosts/<host>/)
sync_single_file() {
    local host=$1
    local cmd=$2
    local local_path=$3

    local login=${HOST_INFO[$host]}
    [ -z "$login" ] && log_err "Host $host not defined" && return 1

    local HOST_BASE="$LIB_DIR/../../hosts/$host"
    local loc_full="$HOST_BASE/$local_path"

    # 从 RULES 中查找对应的远程路径
    local rules_str=$(get_host_rules "$host")
    read -r -a rules <<< "$rules_str"

    local remote_path=""
    for rule in "${rules[@]}"; do
        local loc="${rule%%:*}"
        local rem="${rule#*:}"
        if [ "$loc" == "$local_path" ]; then
            remote_path="$rem"
            break
        fi
    done

    if [ -z "$remote_path" ]; then
        log_err "No sync rule found for $local_path"
        return 1
    fi

    # 构造 rsync 命令
    local rsync_cmd="rsync -azc -e 'ssh $SSH_OPT' --out-format='%n'"
    local user="${login%%@*}"
    [[ "$user" != "root" ]] && rsync_cmd="$rsync_cmd --rsync-path='sudo rsync'"

    if [ "$cmd" == "pull" ]; then
        mkdir -p "$(dirname "$loc_full")"
        eval $rsync_cmd "$login:$remote_path" "$loc_full"
    else
        [ ! -e "$loc_full" ] && log_err "Local file not found: $loc_full" && return 1
        eval $rsync_cmd "$loc_full" "$login:$remote_path"
        # 执行 hook
        run_post_push_hooks "$host" "$local_path"
    fi
}

# ==============================================================================
#  主调度逻辑
# ==============================================================================

if [ "$HOST" == "all" ]; then
    for h in "${!HOST_INFO[@]}"; do
        sync_host "$h"
    done
elif [ -n "$HOST" ]; then
    sync_host "$HOST"
else
    log_err "Usage: ./spool.sh sync <pull|push> <host|all>"
    exit 1
fi
