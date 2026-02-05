#!/bin/bash
# ==============================================================================
#  SilkSpool Bundle Generic Runner (核心运行器)
#  功能:
#    1. 智能解析部署路径 (DEPLOY_PATH)
#    2. 动态生成 Stack 安装清单 (BATCH_INSTALL_DATA)
#    3. 准备注入代码 (版本号 + 下载函数)
#    4. 合并 YAML 模板 & 推送 Service 文件
#    5. 流式执行远程脚本 (注入代码 + 替换占位符 -> SSH)
# ==============================================================================

# ==============================================================================
#  函数: init_bundle_defaults
#  描述: 从远程源下载 bundle 所需的默认配置文件到 hosts/<host>/ 目录
#        仅在本地文件不存在时才下载，不覆盖已有配置
#  参数: $1 - bundle 名称, $2 - 主机别名
# ==============================================================================
init_bundle_defaults() {
    local NAME=$1
    local HOST=$2
    local BUNDLE_ROOT="$BASE_DIR/bundles/$NAME"
    local DEFAULTS_SCRIPT="$BUNDLE_ROOT/defaults.sh"
    local HOST_DIR="$BASE_DIR/hosts/$HOST"

    # 如果 bundle 没有 defaults.sh，跳过
    if [ ! -f "$DEFAULTS_SCRIPT" ]; then
        return 0
    fi

    # 加载 defaults.sh 中的 CONFIG_DEFAULTS 和 CONFIG_HINTS
    source "$DEFAULTS_SCRIPT"

    if [ ${#CONFIG_DEFAULTS[@]} -eq 0 ]; then
        return 0
    fi

    log_step "Initializing default config: $NAME -> $HOST"

    local any_downloaded=false

    for entry in "${CONFIG_DEFAULTS[@]}"; do
        IFS='|' read -r local_path url mode <<< "$entry"
        [ -z "$mode" ] && mode="download"

        local target="$HOST_DIR/$local_path"

        # 如果文件已存在，跳过
        if [ -f "$target" ]; then
            log_info "Already exists, skipping: $local_path"
            continue
        fi

        # 确保本地目录存在
        mkdir -p "$(dirname "$target")"

        log_info "Generating default config: $local_path"

        # 支持 LOCAL_TEMPLATE: 调用 defaults.sh 中的 generate_local_template 函数
        if [ "$url" == "LOCAL_TEMPLATE" ]; then
            if type generate_local_template &>/dev/null; then
                if generate_local_template "$target" "$local_path"; then
                    log_success "Generated: $local_path"
                    any_downloaded=true
                    local hint="${CONFIG_HINTS[$local_path]}"
                    if [ -n "$hint" ]; then
                        echo -e "  ${YELLOW}$hint${NC}"
                    fi
                    if [ "$mode" == "template" ]; then
                        echo -e "  ${YELLOW}[!] Template config - please edit before pushing: hosts/$HOST/$local_path${NC}"
                    fi
                else
                    log_err "Template generation failed: $local_path"
                fi
            else
                log_err "defaults.sh missing generate_local_template function"
            fi
            continue
        fi

        log_info "  Source: $url"

        # 下载配置文件 (支持重定向，超时 30 秒)
        if curl -fsSL --connect-timeout 10 --max-time 30 -o "$target" "$url" 2>/dev/null; then
            log_success "Downloaded: $local_path"
            any_downloaded=true

            # 显示配置提示
            local hint="${CONFIG_HINTS[$local_path]}"
            if [ -n "$hint" ]; then
                echo -e "  ${YELLOW}$hint${NC}"
            fi

            if [ "$mode" == "template" ]; then
                echo -e "  ${YELLOW}[!] Template config - please edit before pushing: hosts/$HOST/$local_path${NC}"
            fi
        else
            log_warn "Download failed: $url"
            log_info "  Trying ghproxy mirror..."
            # 国内 GitHub 加速镜像回退
            local proxy_url="https://mirror.ghproxy.com/$url"
            if curl -fsSL --connect-timeout 10 --max-time 30 -o "$target" "$proxy_url" 2>/dev/null; then
                log_success "Downloaded (via proxy): $local_path"
                any_downloaded=true

                local hint="${CONFIG_HINTS[$local_path]}"
                if [ -n "$hint" ]; then
                    echo -e "  ${YELLOW}$hint${NC}"
                fi
            else
                log_err "Download failed, please obtain config manually: $local_path"
                log_info "  Official URL: $url"
            fi
        fi
    done

    if [ "$any_downloaded" = true ]; then
        echo ""
        log_info "Default configs downloaded to hosts/$HOST/"
        log_info "   Please review and edit configs, then run: ./spool.sh sync push $HOST"
    fi
}

run_bundle_generic() {
    local NAME=$1
    local ACTION=$2
    local HOST=$3
    local BUNDLE_ROOT=$4

    local LOGIN=${HOST_INFO[$HOST]}
    local APP_PREFIX=$(get_prefix "$HOST")
    local SSH_OPT="-i $SSH_KEY_PATH"

    local REMOTE_SCRIPT="$BUNDLE_ROOT/remote.sh"
    local TEMPLATE_DIR="$BUNDLE_ROOT/templates"

    # --- 处理 init 动作 (仅初始化默认配置，不执行远程脚本) ---
    if [ "$ACTION" == "init" ]; then
        init_bundle_defaults "$NAME" "$HOST"
        return $?
    fi

    if [ ! -f "$REMOTE_SCRIPT" ]; then
        log_err "Bundle corrupted: missing remote.sh ($BUNDLE_ROOT)"
        exit 1
    fi

    # =========================================================
    # --- 1. 智能解析部署路径 (DEPLOY_PATH) ---
    # =========================================================
    # 默认值: /opt/silkspool/<bundle_name>
    local DEPLOY_PATH="/opt/silkspool/$NAME"

    # 读取该主机的同步规则，尝试从规则中推导真实路径
    local RULES_STR=$(get_host_rules "$HOST")
    read -r -a RULES <<< "$RULES_STR"

    for rule in "${RULES[@]}"; do
        # 规则格式 local:remote，提取冒号后面的 remote
        local rem="${rule#*:}"
        # 如果远程路径包含 bundle 名字 (例如 .../knowledge/...)
        if [[ "$rem" == *"$NAME"* ]]; then
            # 取该文件的父目录作为部署目录
            DEPLOY_PATH=$(dirname "$rem")
            break
        fi
    done

    log_step "Running Bundle: $NAME | Host: $HOST | Path: $DEPLOY_PATH"

    # =========================================================
    # --- 2. 动态生成 Stack 安装清单 (用于 Server Bundle) ---
    # =========================================================
    # 只有当该主机配置了 STACK_XXX 时，才会生成此数据

    local STACK_LIST_STR=$(get_host_stack "$HOST")
    read -r -a STACK_APPS <<< "$STACK_LIST_STR"
    local BATCH_INSTALL_DATA=""

    if [ ${#STACK_APPS[@]} -gt 0 ]; then
        log_info "Resolving host stack config: ${STACK_APPS[*]}"

        for APP in "${STACK_APPS[@]}"; do
            # 2.1 从 INSTALL_SOURCES 查找定义
            local FOUND=0
            local REPO=""
            local PATTERN=""
            local SVC_NAME=""

            for src in "${INSTALL_SOURCES[@]}"; do
                IFS=':' read -r alias r p n <<< "$src"
                if [ "$alias" == "$APP" ]; then
                    REPO="$r"; PATTERN="$p"; SVC_NAME="$n"
                    FOUND=1
                    break
                fi
            done

            if [ $FOUND -eq 0 ]; then
                log_warn "Stack app '$APP' not defined in INSTALL_SOURCES, skipping."
                continue
            fi

            # 2.2 从 APP_VERSIONS 获取版本 (默认为 latest)
            local VER="${APP_VERSIONS[$APP]}"
            [ -z "$VER" ] && VER="latest"

            # 2.3 追加到清单变量 (用 | 分隔: REPO|PATTERN|SVC|VER)
            BATCH_INSTALL_DATA+="${REPO}|${PATTERN}|${SVC_NAME}|${VER}"$'\n'
        done
    fi

    # =========================================================
    # --- 3. 准备注入代码 (Injection Preparation) ---
    # =========================================================

    # A. 注入版本变量 (来自 config.ini 的 APP_VERSIONS)
    # 结果示例: export VER_CADDY="latest"; export VER_HEADSCALE="v0.22.3";
    local VERSION_INJECT=""
    for app in "${!APP_VERSIONS[@]}"; do
        local ver="${APP_VERSIONS[$app]}"
        VERSION_INJECT+="export VER_${app^^}=\"$ver\"; "
    done

    # B. 注入工具函数 (来自 utils.sh)
    # 这将把 download_asset 函数的代码文本放入变量
    local FUNC_INJECT=$(gen_download_func)

    # =========================================================
    # --- 4. 模板处理 (YAML & Service 推送) ---
    # =========================================================
    if [[ "$ACTION" == "setup" || "$ACTION" == "up" ]]; then
        # 确保远程目录存在 (使用 sudo 确保 /opt 权限)
        # 注意: 假设远程用户有 sudo 权限
        ssh $SSH_OPT "$LOGIN" "sudo mkdir -p $DEPLOY_PATH && sudo chown \$(id -u):\$(id -g) $DEPLOY_PATH"

        # --- 4.0 初始化默认配置并推送 (仅 setup 时自动执行) ---
        if [ "$ACTION" == "setup" ]; then
            init_bundle_defaults "$NAME" "$HOST"
            # 推送配置文件到远程 (sync push 会自动创建远程目录)
            log_info "Pushing config files..."
            bash "$LIB_DIR/sync.sh" push "$HOST"
        fi

        if [ -d "$TEMPLATE_DIR" ]; then
            # 4.1 处理 Docker Compose YAML
            # 检查目录下是否有 .yaml 文件
            if ls "$TEMPLATE_DIR"/*.yaml 1> /dev/null 2>&1; then
                local TEMP_YAML="/tmp/spool_${NAME}_$(date +%s).yaml"
                log_info "Merging YAML templates..."
                yq eval-all '. as $item ireduce ({}; . * $item)' "$TEMPLATE_DIR"/*.yaml > "$TEMP_YAML"

                log_info "Pushing docker-compose.yaml -> $DEPLOY_PATH"
                scp $SSH_OPT -q "$TEMP_YAML" "$LOGIN:$DEPLOY_PATH/docker-compose.yaml"
                rm -f "$TEMP_YAML"
            fi

            # 4.2 处理 Systemd Service 文件 (针对 Server Bundle)
            # 检查目录下是否有 .service 文件
            if ls "$TEMPLATE_DIR"/*.service 1> /dev/null 2>&1; then
                log_info "Pushing Systemd service templates..."
                scp $SSH_OPT -q "$TEMPLATE_DIR"/*.service "$LOGIN:$DEPLOY_PATH/"
            fi
        fi
    fi

    # =========================================================
    # --- 5. 流式执行远程脚本 (Stream Execution) ---
    # =========================================================
    log_info "Executing remote script (injecting: Prefix, Path, Utils, StackData)..."

    # 组合流:
    # 1. 版本变量定义
    # 2. 下载函数定义
    # 3. Stack 数据变量定义 (使用 heredoc 防止转义)
    # 4. 远程脚本本身 (同时替换 {{APP_PREFIX}} 和 {{DEPLOY_PATH}})

    {
        echo "$VERSION_INJECT"
        echo "$FUNC_INJECT"

        echo "read -r -d '' BATCH_INSTALL_DATA << 'EOF_BATCH'"
        echo "$BATCH_INSTALL_DATA"
        echo "EOF_BATCH"

        sed -e "s|{{APP_PREFIX}}|$APP_PREFIX|g" \
            -e "s|{{DEPLOY_PATH}}|$DEPLOY_PATH|g" \
            "$REMOTE_SCRIPT"

    } | ssh -t $SSH_OPT "$LOGIN" "bash -s -- $ACTION"
}
