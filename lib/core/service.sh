#!/bin/bash
# ==============================================================================
#  服务状态管理模块 (Service Manager)
#  功能: 统一管理 Systemd, Docker, OpenWrt, init.d 服务
#
#  支持的服务类型:
#    - systemd   : Linux systemd 服务 (systemctl)
#    - docker    : Docker 容器 (docker start/stop/restart)
#    - openwrt   : OpenWrt procd 服务 (/etc/init.d/xxx)
#    - initd     : 通用 init.d 服务 (/etc/init.d/xxx)
#    - docker-exec: Docker 内执行命令 (格式: container:command)
#
#  支持的操作:
#    - status    : 查看服务状态
#    - start     : 启动服务
#    - stop      : 停止服务
#    - restart   : 重启服务
#    - reload    : 重载配置 (不中断服务)
# ==============================================================================

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
source "$LIB_DIR/../../config.ini"
source "$LIB_DIR/utils.sh"

ACTION=$1
HOST=$2
SVC=$3
SSH_OPT="-i $SSH_KEY_PATH"

[ -z "$HOST" ] && log_err "Usage: ./spool.sh <status|restart|reload|start|stop> <host> [service]" && exit 1

LOGIN=${HOST_INFO[$HOST]}
USER="${LOGIN%%@*}"
SERVICES_STR=$(get_host_services "$HOST")
read -r -a SERVICES <<< "$SERVICES_STR"

# ==============================================================================
#  核心执行函数
#  参数: $1=服务类型, $2=服务名/容器名, $3=操作(可选,默认使用全局ACTION)
# ==============================================================================
perform() {
    local type=$1
    local name=$2
    local action=${3:-$ACTION}
    local cmd=""
    local sudo_prefix=""

    # 非 root 用户操作系统服务需要 sudo
    [ "$USER" != "root" ] && [[ "$type" =~ ^(systemd|initd)$ ]] && sudo_prefix="sudo"

    case "$type" in
        "systemd")
            case "$action" in
                status)  cmd="$sudo_prefix systemctl status $name --no-pager -l" ;;
                start)   cmd="$sudo_prefix systemctl start $name" ;;
                stop)    cmd="$sudo_prefix systemctl stop $name" ;;
                restart) cmd="$sudo_prefix systemctl restart $name" ;;
                reload)  cmd="$sudo_prefix systemctl reload $name 2>/dev/null || $sudo_prefix systemctl restart $name" ;;
            esac
            ;;

        "docker")
            case "$action" in
                status)  cmd="docker ps -a --filter name=^${name}$ --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'" ;;
                start)   cmd="docker start $name" ;;
                stop)    cmd="docker stop $name" ;;
                restart) cmd="docker restart $name" ;;
                reload)  cmd="docker restart $name" ;; # Docker 容器无原生 reload，降级为 restart
            esac
            ;;

        "openwrt"|"initd")
            # OpenWrt 和通用 init.d 使用相同的命令格式
            case "$action" in
                status)  cmd="/etc/init.d/$name status 2>/dev/null || echo 'Status not available'" ;;
                start)   cmd="/etc/init.d/$name start" ;;
                stop)    cmd="/etc/init.d/$name stop" ;;
                restart) cmd="/etc/init.d/$name restart" ;;
                reload)  cmd="/etc/init.d/$name reload 2>/dev/null || /etc/init.d/$name restart" ;;
            esac
            ;;

        "docker-exec")
            # 格式: container:command (如 sp-caddy:caddy reload --config /etc/caddy/Caddyfile)
            local container="${name%%:*}"
            local exec_cmd="${name#*:}"
            cmd="docker exec $container $exec_cmd"
            ;;

        *)
            log_warn "Unknown service type: $type"
            return 1
            ;;
    esac

    echo -e "${BLUE}> $name${NC} ($type)"
    ssh -q $SSH_OPT "$LOGIN" "$cmd"
    local ret=$?

    if [ $ret -eq 0 ]; then
        [ "$action" != "status" ] && log_success "$name $action done"
    else
        [ "$action" != "status" ] && log_warn "$name $action may have failed (exit: $ret)"
    fi

    return $ret
}

# ==============================================================================
#  批量服务操作
#  用法: batch_service_action <host> <action> <service1> [service2] ...
# ==============================================================================
batch_service_action() {
    local host=$1
    local action=$2
    shift 2
    local services=("$@")

    local login=${HOST_INFO[$host]}
    local services_str=$(get_host_services "$host")
    read -r -a all_services <<< "$services_str"

    for svc_alias in "${services[@]}"; do
        local found=0
        for s in "${all_services[@]}"; do
            IFS=':' read -r alias type name <<< "$s"
            if [ "$alias" == "$svc_alias" ]; then
                perform "$type" "$name" "$action"
                found=1
                break
            fi
        done
        [ $found -eq 0 ] && log_warn "Service $svc_alias not registered in SERVICES_${host^^}"
    done
}

# ==============================================================================
#  可导出函数 (供其他模块调用)
# ==============================================================================

# 重启指定服务
# 用法: restart_service <host> <service_alias>
restart_service() {
    local host=$1
    local svc=$2
    batch_service_action "$host" "restart" "$svc"
}

# 批量重启服务
# 用法: restart_services <host> <service1> [service2] ...
restart_services() {
    local host=$1
    shift
    batch_service_action "$host" "restart" "$@"
}

# 重载指定服务
# 用法: reload_service <host> <service_alias>
reload_service() {
    local host=$1
    local svc=$2
    batch_service_action "$host" "reload" "$svc"
}

# 批量重载服务
# 用法: reload_services <host> <service1> [service2] ...
reload_services() {
    local host=$1
    shift
    batch_service_action "$host" "reload" "$@"
}

# ==============================================================================
#  主执行逻辑
# ==============================================================================

# 验证操作类型
if [[ ! "$ACTION" =~ ^(status|start|stop|restart|reload)$ ]]; then
    log_err "Invalid action: $ACTION"
    echo "Supported actions: status, start, stop, restart, reload"
    exit 1
fi

# 遍历并执行
if [ -n "$SVC" ]; then
    # 指定了具体服务
    for s in "${SERVICES[@]}"; do
        IFS=':' read -r alias type name <<< "$s"
        [ "$alias" == "$SVC" ] && perform "$type" "$name" && exit 0
    done
    log_err "Service $SVC not registered in SERVICES_${HOST^^}"
    exit 1
else
    # 遍历所有服务
    for s in "${SERVICES[@]}"; do
        IFS=':' read -r alias type name <<< "$s"
        perform "$type" "$name"
    done
fi
