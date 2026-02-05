#!/bin/bash
# bundles/server/remote.sh
# 这是一个【完全通用】的二进制栈管理器
# 它不包含任何硬编码的软件名，所有数据由 runner.sh 注入的 $BATCH_INSTALL_DATA 提供

set -e
BASE_DIR="{{DEPLOY_PATH}}" # 通常是 /opt/silkspool/server
ACTION=$1

mkdir -p "$BASE_DIR"
cd "$BASE_DIR"

# --- 辅助函数: 配置 Systemd ---
setup_service() {
    local NAME=$1
    local SERVICE_TEMPLATE="$BASE_DIR/$NAME.service"

    # 检查是否有对应的模板文件传过来
    if [ -f "$SERVICE_TEMPLATE" ]; then
        echo "[*] Configuring Systemd: $NAME"
        # 替换模板中的 {{BASE_DIR}} 占位符
        sed -i "s|{{BASE_DIR}}|$BASE_DIR|g" "$SERVICE_TEMPLATE"

        # 移动到系统目录
        sudo mv "$SERVICE_TEMPLATE" "/etc/systemd/system/$NAME.service"
        sudo systemctl daemon-reload
        sudo systemctl enable $NAME
        sudo systemctl restart $NAME
    else
        echo "[!] $NAME.service template not found, attempting to restart existing service..."
        # 尝试重启
        if systemctl list-unit-files | grep -q "$NAME.service"; then
            sudo systemctl restart $NAME
        fi
    fi
}

case "$ACTION" in
    setup)
        echo ">>> [Server Bundle] Starting batch deployment..."

        # 检查是否有注入的数据
        if [ -z "$BATCH_INSTALL_DATA" ]; then
            echo "[!] No stack data injection detected, please check STACK_XXX configuration in config.ini"
            exit 0
        fi

        # 逐行读取注入的数据
        # 数据格式: REPO|PATTERN|SERVICE_NAME|VERSION
        while IFS='|' read -r REPO PATTERN SVC_NAME VER; do
            # 跳过空行
            [ -z "$REPO" ] && continue

            echo "---------------------------------------------------"
            echo "[*] Processing app: $SVC_NAME ($VER)"

            # 1. 调用通用下载函数 (来自 utils.sh 注入)
            # 输出路径固定为 /usr/local/bin/服务名
            download_asset "$REPO" "$PATTERN" "/usr/local/bin/$SVC_NAME" "$VER"

            # 2. 配置服务
            setup_service "$SVC_NAME"

        done <<< "$BATCH_INSTALL_DATA"

        echo "---------------------------------------------------"
        echo "[OK] All base services deployed successfully"
        ;;

    up|restart)
        echo ">>> Restarting services..."
        # 同样遍历数据来重启
        while IFS='|' read -r REPO PATTERN SVC_NAME VER; do
            [ -z "$SVC_NAME" ] && continue
            echo "[*] Restarting $SVC_NAME..."
            sudo systemctl restart "$SVC_NAME" || echo "   (service not running)"
        done <<< "$BATCH_INSTALL_DATA"
        ;;

    status)
        echo ">>> Checking service status..."
        while IFS='|' read -r REPO PATTERN SVC_NAME VER; do
            [ -z "$SVC_NAME" ] && continue
            echo "> $SVC_NAME:"
            systemctl status "$SVC_NAME" --no-pager | grep "Active:" || echo "   Not running"
        done <<< "$BATCH_INSTALL_DATA"
        ;;

    down)
        echo ">>> Stopping services..."
        while IFS='|' read -r REPO PATTERN SVC_NAME VER; do
            [ -z "$SVC_NAME" ] && continue
            echo "[*] Stopping $SVC_NAME..."
            sudo systemctl stop "$SVC_NAME" || true
        done <<< "$BATCH_INSTALL_DATA"
        ;;
esac
