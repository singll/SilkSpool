#!/bin/bash
# ==============================================================================
#  工具函数库
# ==============================================================================

# 颜色定义
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err() { echo -e "${RED}[ERR]${NC} $1"; }
log_step() { echo -e "\n${BLUE}=== $1 ===${NC}"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }

# --- 获取容器前缀 ---
# 从 config.ini 的 HOST_META 中解析 APP_PREFIX
get_prefix() {
    local host=$1
    local meta=$(get_host_meta "$host")
    # 使用 grep 提取 APP_PREFIX=xxx 后的内容
    local prefix=$(echo "$meta" | grep -oP 'APP_PREFIX=\K[^ ]+')

    # 逻辑:
    # 1. 如果没定义 APP_PREFIX，默认返回 "sp-"
    # 2. 如果定义了且为空 (APP_PREFIX=)，返回空字符串
    # 3. 如果定义了具体值，返回具体值
    if [ -z "$prefix" ] && [[ "$meta" != *"APP_PREFIX="* ]]; then
        echo "sp-"
    else
        echo "$prefix"
    fi
}

# --- 检查并自动安装 yq ---
# 因为 Bundle 需要合并 YAML，所以本地必须有 yq 工具
ensure_local_yq() {
    if command -v yq >/dev/null 2>&1; then
        local ver=$(yq --version 2>&1)
        # 简单检查版本是否为 v4
        [[ "$ver" == *"version 4."* || "$ver" == *"version v4."* ]] && return 0
    fi

    log_step "yq not found, installing (v4)..."
    local OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    local ARCH=$(uname -m)
    # 架构名称映射
    [[ "$ARCH" == "x86_64" ]] && ARCH="amd64"
    [[ "$ARCH" == "aarch64" ]] && ARCH="arm64"

    local URL="https://github.com/mikefarah/yq/releases/latest/download/yq_${OS}_${ARCH}"
    # 尝试下载并安装到 /usr/local/bin
    if sudo wget "$URL" -O /usr/local/bin/yq && sudo chmod +x /usr/local/bin/yq; then
        log_success "yq installed"
    else
        log_err "yq install failed, manual install: https://github.com/mikefarah/yq"
        exit 1
    fi
}

# ==============================================================================
#  通用资产下载器 (支持 GitHub/GitLab)
#  原理: 输出一段 Bash 函数代码，这段代码会被 runner.sh 注入到远程服务器执行
#  优势:
#    1. 自动识别远程架构 (amd64/arm64)
#    2. 统一处理 Version (latest 或 tag)
#    3. 统一处理 GitHub API 逻辑
# ==============================================================================
gen_download_func() {
    cat << 'EOF'
download_asset() {
    local REPO_RAW=$1   # 例如: gitlab:famedly/conduit 或 caddyserver/caddy
    local PATTERN=$2    # 例如: linux_{ARCH}.tar.gz
    local OUTPUT=$3     # 例如: /usr/local/bin/conduit
    local VERSION=$4    # 例如: latest 或 v1.0.0

    # 1. 架构识别与修正
    local ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) ARCH="amd64" ;;
        aarch64) ARCH="arm64" ;;
    esac
    # 替换 Pattern 中的 {ARCH} 占位符
    PATTERN=${PATTERN//\{ARCH\}/$ARCH}

    echo "[*] Resolving download URL: $REPO_RAW ($VERSION)..."

    # 2. 识别提供商 (Provider)
    local PROVIDER="github"
    local REPO="$REPO_RAW"

    if [[ "$REPO_RAW" == "gitlab:"* ]]; then
        PROVIDER="gitlab"
        REPO=${REPO_RAW#gitlab:}
    elif [[ "$REPO_RAW" == "github:"* ]]; then
        PROVIDER="github"
        REPO=${REPO_RAW#github:}
    fi

    local DOWNLOAD_URL=""

    # 3. 分发下载逻辑
    if [ "$PROVIDER" == "github" ]; then
        # --- GitHub Logic ---
        local API_URL="https://api.github.com/repos/$REPO/releases/latest"
        [ "$VERSION" != "latest" ] && [ -n "$VERSION" ] && API_URL="https://api.github.com/repos/$REPO/releases/tags/$VERSION"

        # 使用 grep/cut 提取 browser_download_url
        DOWNLOAD_URL=$(curl -sL "$API_URL" | grep "browser_download_url" | grep -i "$PATTERN" | cut -d '"' -f 4 | head -1)

    elif [ "$PROVIDER" == "gitlab" ]; then
        # --- GitLab Logic ---
        local ENCODED_REPO=${REPO//\//%2F}
        local API_BASE="https://gitlab.com/api/v4/projects/$ENCODED_REPO/releases"

        local JSON_CONTENT=""
        if [ "$VERSION" == "latest" ] || [ -z "$VERSION" ]; then
            JSON_CONTENT=$(curl -sL "$API_BASE" | grep -oE '"assets":\{"links":\[.*?\]\}' | head -1)
        else
            JSON_CONTENT=$(curl -sL "$API_BASE/$VERSION" | grep -oE '"assets":\{"links":\[.*?\]\}')
        fi

        DOWNLOAD_URL=$(echo "$JSON_CONTENT" | grep -oE '\{"name":"[^"]*","url":"[^"]*"' | grep -i "$PATTERN" | grep -oE 'https://[^"]*')
    fi

    # 4. 验证与下载
    if [ -z "$DOWNLOAD_URL" ]; then
        echo "[ERR] No asset matching '$PATTERN' found on $PROVIDER"
        echo "      Repo: $REPO | Version: $VERSION"
        return 1
    fi

    echo "[*] URL: $DOWNLOAD_URL"
    local TMP_FILE="/tmp/$(basename "$DOWNLOAD_URL")"

    # 使用 curl -L 跟随重定向 (GitLab 下载链接通常会重定向)
    curl -sL -o "$TMP_FILE" "$DOWNLOAD_URL"

    # 5. 解压与安装
    if [[ "$DOWNLOAD_URL" == *".tar.gz" ]] || [[ "$DOWNLOAD_URL" == *".zip" ]]; then
        echo "[*] Extracting..."
        local EXTRACT_DIR="/tmp/extract_$(date +%s)"
        mkdir -p "$EXTRACT_DIR"

        [[ "$DOWNLOAD_URL" == *".tar.gz" ]] && tar -xzf "$TMP_FILE" -C "$EXTRACT_DIR"
        [[ "$DOWNLOAD_URL" == *".zip" ]] && unzip -q "$TMP_FILE" -d "$EXTRACT_DIR"

        # 查找最大的可执行文件
        local BIN_FILE=$(find "$EXTRACT_DIR" -type f -not -name "*.*" | xargs ls -S | head -1)
        if [ -n "$BIN_FILE" ]; then
            sudo mv "$BIN_FILE" "$OUTPUT"
        else
            echo "[ERR] Extract failed: no binary found"
            return 1
        fi
        rm -rf "$EXTRACT_DIR" "$TMP_FILE"
    else
        # 纯二进制文件
        sudo mv "$TMP_FILE" "$OUTPUT"
    fi

    sudo chmod +x "$OUTPUT"
    echo "[OK] Installed: $OUTPUT"
}
EOF
}
