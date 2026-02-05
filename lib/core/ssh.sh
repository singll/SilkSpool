#!/bin/bash
# ==============================================================================
#  SSH 初始化模块 (灵魂绑定 - 增强版)
#  功能: 自动创建运维专用用户 (silkspool) 并配置免密和权限
# ==============================================================================

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
source "$LIB_DIR/../../config.ini"
source "$LIB_DIR/utils.sh"

TARGET_KEY="$SSH_KEY_PATH"
PUB_KEY_FILE="${TARGET_KEY}.pub"

# --- 1. 本地密钥准备 ---
if [ ! -f "$TARGET_KEY" ]; then
    log_warn "No local key found, generating: $TARGET_KEY"
    mkdir -p "$(dirname "$TARGET_KEY")"
    ssh-keygen -t ed25519 -f "$TARGET_KEY" -N "" -C "silkspool-admin"
    chmod 600 "$TARGET_KEY"
fi
[ ! -f "$PUB_KEY_FILE" ] && ssh-keygen -y -f "$TARGET_KEY" > "$PUB_KEY_FILE"
PUB_KEY_CONTENT=$(cat "$PUB_KEY_FILE")

# --- 2. 远程初始化逻辑 (核心) ---
provision_remote() {
    local ip=$1
    local target_user=$2  # config.ini 里定义的目标用户 (如 silkspool)

    echo -e "${YELLOW}>>> Cannot connect directly to $target_user@$ip${NC}"
    echo -e "${BLUE}Please enter the existing admin username for this server (e.g. root, ubuntu, debian):${NC}"
    read -p "Admin User: " admin_user
    [ -z "$admin_user" ] && admin_user="root" # 默认尝试 root

    echo -e "${BLUE}Please enter password for $admin_user@$ip to create user $target_user:${NC}"

    # 远程脚本: 创建用户、配置sudo、配置docker、写入key
    REMOTE_SCRIPT="
        set -e
        # 0. 提权检测
        SUDO=''; [ \"\$(id -u)\" -ne 0 ] && command -v sudo >/dev/null && SUDO='sudo'

        # 1. 创建目标用户 ($target_user)
        if ! id -u $target_user >/dev/null 2>&1; then
            echo 'Creating user $target_user...'
            if command -v useradd >/dev/null; then
                # Linux 标准创建
                \$SUDO useradd -m -s /bin/bash $target_user
                echo '$target_user:$target_user' | \$SUDO chpasswd || true

                # 配置 sudo 免密 (用于 rsync 和 systemctl)
                echo '$target_user ALL=(ALL) NOPASSWD: ALL' | \$SUDO tee /etc/sudoers.d/$target_user >/dev/null
                \$SUDO chmod 440 /etc/sudoers.d/$target_user
            else
                echo '[WARN] useradd not found, skipping creation (OpenWrt?)'
            fi
        fi

        # 2. 修正 Docker 权限
        if command -v docker >/dev/null 2>&1; then
            if getent group docker >/dev/null; then
                \$SUDO usermod -aG docker $target_user || true
            fi
        fi

        # 3. 部署 SSH 公钥
        # 获取目标用户的 Home 目录
        TARGET_HOME=\$(eval echo ~$target_user)
        # 如果是 root 或特殊情况，兜底
        [ -z \"\$TARGET_HOME\" ] && TARGET_HOME='/home/$target_user'
        [ \"$target_user\" = \"root\" ] && TARGET_HOME='/root'

        \$SUDO mkdir -p \$TARGET_HOME/.ssh
        echo '$PUB_KEY_CONTENT' | \$SUDO tee -a \$TARGET_HOME/.ssh/authorized_keys >/dev/null
        \$SUDO chmod 600 \$TARGET_HOME/.ssh/authorized_keys
        \$SUDO chown -R $target_user:$target_user \$TARGET_HOME/.ssh

        echo '[OK] User $target_user initialized successfully!'
    "

    # 使用管理员账号执行初始化
    ssh -t -o StrictHostKeyChecking=no -o PubkeyAuthentication=no "$admin_user@$ip" "$REMOTE_SCRIPT"
}

# --- 3. 批量检查 ---
log_step "Checking nodes (target user: silkspool)..."

for host in "${!HOST_INFO[@]}"; do
    login=${HOST_INFO[$host]}
    target_user="${login%%@*}"
    ip="${login#*@}"

    echo -n "Probing $host ($target_user@$ip)... "

    # 1. 尝试直接用 Key 登录目标用户
    if ssh -q -i "$TARGET_KEY" -o BatchMode=yes -o ConnectTimeout=3 "$login" "exit"; then
        echo -e "${GREEN}OK (configured)${NC}"
    else
        # 2. 失败则调用初始化流程
        echo -e "${RED}Not connected${NC}"
        provision_remote "$ip" "$target_user"
    fi
done
