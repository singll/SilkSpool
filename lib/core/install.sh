#!/bin/bash
# ==============================================================================
#  二进制安装模块 (升级版)
#  功能:
#    1. 读取 config.ini 中的 INSTALL_SOURCES
#    2. 注入 utils.sh 中的通用下载函数 (gen_download_func)
#    3. 自动处理 {ARCH} 替换和版本控制
# ==============================================================================

LIB_DIR=$(cd "$(dirname "$0")" && pwd); source "$LIB_DIR/../../config.ini"; source "$LIB_DIR/utils.sh"
HOST=$1; APP=$2; SSH_OPT="-i $SSH_KEY_PATH"

[ -z "$HOST" ] || [ -z "$APP" ] && { log_err "Usage: install <host> <app>"; exit 1; }
LOGIN=${HOST_INFO[$HOST]}

SOURCES_STR="${INSTALL_SOURCES[*]}"
REPO=""; PATTERN=""; NAME=""
for s in $SOURCES_STR; do
    IFS=':' read -r a r p n <<< "$s"
    if [ "$a" == "$APP" ]; then REPO="$r"; PATTERN="$p"; NAME="$n"; break; fi
done

[ -z "$REPO" ] && log_err "Unknown app: $APP" && exit 1
VERSION="${APP_VERSIONS[$APP]:-latest}"

log_info "Installing $APP ($VERSION) on $HOST..."

# 注入代码
FUNC_INJECT=$(gen_download_func)

REMOTE_SCRIPT="
set -e
# 使用新的通用下载函数
download_asset \"$REPO\" \"$PATTERN\" \"/usr/local/bin/$NAME\" \"$VERSION\"

echo '[*] Checking service status...'
if systemctl list-unit-files | grep -q $NAME.service; then
    sudo systemctl restart $NAME
    echo '[OK] Service restarted'
fi
"

{
    echo "$FUNC_INJECT"
    echo "$REMOTE_SCRIPT"
} | ssh -t $SSH_OPT "$LOGIN" "bash"
