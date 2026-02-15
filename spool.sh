#!/bin/bash
# ==============================================================================
#  SilkSpool (丝轴) - CLI 主程序 (修复版)
#  功能: 修复 sync 参数传递错位问题
# ==============================================================================

BASE_DIR=$(cd "$(dirname "$0")" && pwd)
LIB_DIR="$BASE_DIR/lib/core"
CONFIG_FILE="$BASE_DIR/config.ini"

# --- 1. 环境自检 ---
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: config.ini not found"
    echo "Hint: Run 'cp config.ini.example config.ini' and edit as needed"
    exit 1
fi

source "$CONFIG_FILE"
source "$LIB_DIR/utils.sh"
source "$LIB_DIR/runner.sh"

# --- 2. 修正 SSH 密钥路径 ---
if [[ "$SSH_KEY_PATH" == ./* ]]; then
    export SSH_KEY_PATH="$BASE_DIR/${SSH_KEY_PATH#./}"
fi

# --- 3. 帮助信息 ---
usage() {
    echo -e "${BLUE}========= SilkSpool Ops Tool =========${NC}"
    echo "Usage: ./spool.sh <command> [args]"
    echo ""
    echo "Core Commands:"
    echo "  init                  -> Initialize node (SSH trust + Docker perms)"
    echo "  sync pull <host|all>  -> Pull config (remote -> local)"
    echo "  sync push <host|all>  -> Push config (local -> remote)"
    echo "  backup <host>         -> Backup data (remote -> local)"
    echo ""
    echo "DNS Management:"
    echo "  dns list              -> List internal DNS records"
    echo "  dns add <domain> [ip] -> Add domain (default: gateway IP)"
    echo "  dns remove <domain>   -> Remove domain"
    echo "  dns sync-caddy        -> Sync domains from Caddyfile"
    echo "  dns push              -> Push and reload DNS"
    echo ""
    echo "Site Management:"
    echo "  site list             -> List all sites"
    echo "  site add <domain> <backend> <name> [desc] [icon]"
    echo "                        -> Add site (DNS + Caddy + Homepage)"
    echo "  site remove <domain>  -> Remove site"
    echo "  site push             -> Push all site configs"
    echo ""
    echo "Bundle Orchestration:"
    echo "  bundle <name> <cmd> <host> [args]"
    echo "      <name>: Bundle name (e.g. knowledge, bili)"
    echo "      <cmd> : init | setup | up | down | status | service"
    echo "      init  : Download default configs to hosts/<host>/"
    echo "      service: Manage single service (bundle <name> service <host> <svc> <action>)"
    echo "               Example: bundle knowledge service knowledge bellkeeper up"
    echo ""
    echo "Service Management:"
    echo "  stack  <host>         -> Install binary stack"
    echo "  status <host> [svc]   -> View service status"
    echo "  restart <host> [svc]  -> Restart service"
    echo "  reload <host> [svc]   -> Reload service config"
    echo "  start/stop <host> [svc] -> Start/stop service"
    echo "  logs <host> <svc> [N] -> View container logs (default 50 lines)"
    echo "  install <host> <app>  -> Install single binary tool"
    echo ""
    echo "Ops Tools:"
    echo "  exec <host> <cmd...>  -> Execute command on remote host"
    echo "  test-url <domain>     -> Test domain reverse proxy"
    echo ""
    echo "n8n Workflow Management:"
    echo "  n8n-sync list         -> List workflow files (local+remote+n8n)"
    echo "  n8n-sync import       -> Import workflows to n8n via API"
    echo "  n8n-sync export       -> Export workflows from n8n to local"
    echo "  n8n-sync push-import  -> Push and import (one-click)"
    exit 1
}

CMD=$1; shift

# --- 4. 指令分发 ---
case "$CMD" in
    # 初始化
    init) bash "$LIB_DIR/ssh.sh" "$@" ;;

    # [修复点] 同步指令分流
    # 如果用户输入: ./spool.sh sync pull all
    # shift 后 $@ 为 "pull all"
    # 我们直接把 $@ 传给 sync.sh，让它接收到的 $1=pull, $2=all
    sync)
        if [ -z "$1" ]; then usage; fi
        bash "$LIB_DIR/sync.sh" "$@"
        ;;

    # 兼容快捷方式: ./spool.sh pull all
    pull|push)
        bash "$LIB_DIR/sync.sh" "$CMD" "$@"
        ;;

    # DNS 管理
    dns)
        bash "$LIB_DIR/dns.sh" "$@"
        ;;

    # 站点管理 (DNS + Caddy + Homepage)
    site)
        SUB_CMD=$1; shift
        bash "$LIB_DIR/dns.sh" "site-$SUB_CMD" "$@"
        ;;

    # 备份
    backup|restore) bash "$LIB_DIR/backup.sh" "$CMD" "$@" ;;

    # 服务状态
    status|restart|reload|start|stop) bash "$LIB_DIR/service.sh" "$CMD" "$@" ;;

    # 安装
    install) bash "$LIB_DIR/install.sh" "$@" ;;

    # Bundle 编排
    bundle)
        NAME=$1; ACTION=$2; HOST=$3
        shift 3 2>/dev/null || true
        EXTRA_ARGS="$*"  # 额外参数 (用于 service 命令)
        [ -z "$HOST" ] && log_err "Usage: bundle <name> <action> <host> [extra_args]" && exit 1

        BUNDLE_ROOT="$BASE_DIR/bundles/$NAME"
        if [ ! -d "$BUNDLE_ROOT" ]; then
            log_err "Bundle not found: bundles/$NAME"
            exit 1
        fi

        [[ "$ACTION" =~ ^(setup|up)$ ]] && ensure_local_yq
        # init 不需要远程脚本，直接由 runner 处理
        run_bundle_generic "$NAME" "$ACTION" "$HOST" "$BUNDLE_ROOT" "$EXTRA_ARGS"
        ;;

    # Stack 基础栈
    stack)
        HOST=$1
        [ -z "$HOST" ] && log_err "Usage: stack <host>" && exit 1

        STACK_LIST=$(get_host_stack "$HOST")
        read -r -a APPS <<< "$STACK_LIST"
        [ ${#APPS[@]} -eq 0 ] && log_err "No stack defined for host $HOST" && exit 1

        log_step "Installing stack on $HOST: ${APPS[*]}"

        # 1. 安装二进制 (复用 install.sh)
        for app in "${APPS[@]}"; do bash "$LIB_DIR/install.sh" "$HOST" "$app"; done
        # 2. 推送配置
        bash "$LIB_DIR/sync.sh" "push" "$HOST"
        # 3. 重启服务
        for app in "${APPS[@]}"; do bash "$LIB_DIR/service.sh" "restart" "$HOST" "$app"; done
        ;;

    # n8n 工作流同步
    n8n-sync)
        bash "$BASE_DIR/lib/tools/n8n-sync.sh" "$@"
        ;;

    # 远程执行命令
    exec)
        HOST=$1; shift
        [ -z "$HOST" ] && log_err "Usage: exec <host> <command...>" && exit 1
        LOGIN=${HOST_INFO[$HOST]}
        [ -z "$LOGIN" ] && log_err "Unknown host: $HOST" && exit 1
        ssh -i "$SSH_KEY_PATH" -o ConnectTimeout=10 "$LOGIN" "$@"
        ;;

    # 查看容器日志
    logs)
        HOST=$1; SVC=$2; LINES=${3:-50}
        [ -z "$SVC" ] && log_err "Usage: logs <host> <service> [lines]" && exit 1
        LOGIN=${HOST_INFO[$HOST]}
        [ -z "$LOGIN" ] && log_err "Unknown host: $HOST" && exit 1
        # 从服务注册表中查找容器名
        SERVICES_STR=$(get_host_services "$HOST")
        read -r -a SERVICES <<< "$SERVICES_STR"
        CONTAINER=""
        for s in "${SERVICES[@]}"; do
            IFS=':' read -r alias type name <<< "$s"
            if [ "$alias" == "$SVC" ]; then
                CONTAINER="$name"
                break
            fi
        done
        [ -z "$CONTAINER" ] && log_err "Service $SVC not registered in SERVICES_${HOST^^}" && exit 1
        log_info "Viewing last $LINES lines of $CONTAINER"
        ssh -i "$SSH_KEY_PATH" -o ConnectTimeout=10 "$LOGIN" "docker logs --tail $LINES $CONTAINER 2>&1"
        ;;

    # 测试域名反向代理
    test-url)
        DOMAIN=$1
        [ -z "$DOMAIN" ] && log_err "Usage: test-url <domain>" && exit 1
        # 确保域名不含协议前缀
        DOMAIN=${DOMAIN#https://}
        DOMAIN=${DOMAIN#http://}
        DOMAIN=${DOMAIN%%/*}
        # 从网关测试 HTTPS 访问
        GW_HOST=${DNS_GATEWAY_HOST:-istoreos}
        GW_LOGIN=${HOST_INFO[$GW_HOST]}
        echo -e "${BLUE}=== Testing $DOMAIN ===${NC}"
        echo -n "HTTPS Status: "
        ssh -i "$SSH_KEY_PATH" -o ConnectTimeout=10 "$GW_LOGIN" \
            "curl -sk -o /dev/null -w '%{http_code}' https://$DOMAIN" 2>/dev/null
        echo ""
        echo -n "Page Title: "
        ssh -i "$SSH_KEY_PATH" -o ConnectTimeout=10 "$GW_LOGIN" \
            "curl -sk https://$DOMAIN 2>/dev/null | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' | head -1" 2>/dev/null
        echo ""
        # 检查 Caddy 配置中该域名的后端地址
        CADDY_FILE="$BASE_DIR/hosts/$GW_HOST/caddy/Caddyfile"
        if [ -f "$CADDY_FILE" ]; then
            BACKEND=$(grep -A5 "^${DOMAIN}" "$CADDY_FILE" | grep "reverse_proxy" | head -1 | awk '{print $2}')
            if [ -n "$BACKEND" ]; then
                echo -n "Caddy Backend: $BACKEND -> "
                ssh -i "$SSH_KEY_PATH" -o ConnectTimeout=10 "$GW_LOGIN" \
                    "curl -s -o /dev/null -w '%{http_code}' $BACKEND" 2>/dev/null
                echo ""
                echo -n "Backend Title: "
                ssh -i "$SSH_KEY_PATH" -o ConnectTimeout=10 "$GW_LOGIN" \
                    "curl -s $BACKEND 2>/dev/null | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' | head -1" 2>/dev/null
                echo ""
            fi
        fi
        ;;

    *) usage ;;
esac
