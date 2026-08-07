#!/usr/bin/env bash
# ==============================================================================
# CyberStrikeAI 幂等安装/接管脚本（spool bundle csai setup 调用，可重复运行）
# 职责：依赖( Go/Python ) → 接管既有安装或克隆 → venv → 构建 → 配置 → 服务状态
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/CyberStrikeAI"
REPO="https://github.com/Ed1s0nZ/CyberStrikeAI.git"
GO_MIN_MAJOR=1
GO_MIN_MINOR=25

log()  { echo "[setup] $*"; }
warn() { echo "[setup][WARN] $*"; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then SUDO='sudo'; fi

# -------------------- 1. 系统依赖 --------------------
ensure_apt_deps() {
    command -v apt-get >/dev/null 2>&1 || { warn "非 apt 系统，请手动确认 git/curl/python3/venv 已安装"; return; }
    local missing=()
    for pkg in git curl python3 python3-venv python3-pip build-essential; do
        dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        log "安装系统依赖: ${missing[*]}"
        $SUDO apt-get update -qq
        $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
    else
        log "系统依赖已就绪"
    fi
}

# -------------------- 2. Go 工具链 (>= 1.25) --------------------
go_ok() {
    local bin="$1"
    [ -x "$bin" ] || return 1
    local ver
    ver=$("$bin" version 2>/dev/null | awk '{print $3}' | sed 's/^go//')
    [ -n "$ver" ] || return 1
    local major minor
    major=${ver%%.*}; minor=$(echo "$ver" | cut -d. -f2)
    [ "$major" -gt "$GO_MIN_MAJOR" ] && return 0
    [ "$major" -eq "$GO_MIN_MAJOR" ] && [ "$minor" -ge "$GO_MIN_MINOR" ] && return 0
    return 1
}

ensure_go() {
    export PATH=/usr/local/go/bin:$PATH
    if go_ok "$(command -v go 2>/dev/null || echo /nonexistent)"; then
        log "Go 已就绪: $(go version | awk '{print $3}')"
        return
    fi
    local latest arch
    latest=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1)
    [ -n "$latest" ] || { warn "无法获取 Go 最新版本"; return 1; }
    case "$(uname -m)" in
        x86_64)  arch=amd64 ;;
        aarch64) arch=arm64 ;;
        *) warn "不支持的架构: $(uname -m)"; return 1 ;;
    esac
    log "安装 Go $latest ($arch)"
    curl -fsSL "https://go.dev/dl/${latest}.linux-${arch}.tar.gz" -o /tmp/go.tgz
    $SUDO rm -rf /usr/local/go
    $SUDO tar -C /usr/local -xzf /tmp/go.tgz
    rm -f /tmp/go.tgz
    log "Go 安装完成: $(/usr/local/go/bin/go version | awk '{print $3}')"
}

# -------------------- 3. 克隆（默认全新安装到纳管目录） --------------------
adopt_or_clone() {
    if [ -d "$APP_DIR" ]; then
        log "应用目录已存在: $APP_DIR"
        if [ -d "$APP_DIR/.git" ]; then
            log "拉取最新代码 (git pull --ff-only)"
            git -C "$APP_DIR" pull --ff-only || warn "git pull 失败（可能有本地修改），沿用当前代码构建"
        fi
        return
    fi

    # 接管模式：仅当显式指定 CSAI_ADOPT_DIR 时移动既有安装（保留 data/config/venv）；
    # 默认不接管 —— 手动安装（如 /root 下）权限不符，直接全新克隆到纳管目录
    if [ -n "${CSAI_ADOPT_DIR:-}" ] && [ -d "$CSAI_ADOPT_DIR" ] && [ -f "$CSAI_ADOPT_DIR/go.mod" ]; then
        log "接管既有安装: $CSAI_ADOPT_DIR → $APP_DIR"
        $SUDO mkdir -p "$BASE_DIR"
        $SUDO mv "$CSAI_ADOPT_DIR" "$APP_DIR"
    else
        log "克隆仓库: $REPO → $APP_DIR"
        $SUDO mkdir -p "$BASE_DIR"
        git clone --depth 1 "$REPO" "$APP_DIR" 2>/dev/null || $SUDO git clone --depth 1 "$REPO" "$APP_DIR"
    fi

    # 归属当前执行用户（systemd 以 root 运行，此处保证 silkspool 可维护文件）
    $SUDO chown -R "$(id -u):$(id -g)" "$APP_DIR"
}

# -------------------- 4. Python venv --------------------
ensure_venv() {
    cd "$APP_DIR"
    if [ ! -d venv ]; then
        log "创建 Python 虚拟环境"
        python3 -m venv venv
    fi
    if [ -f requirements.txt ]; then
        log "安装 Python 依赖"
        ./venv/bin/pip install -q --upgrade pip
        ./venv/bin/pip install -q -r requirements.txt
    fi
}

# -------------------- 5. 构建 --------------------
build_app() {
    cd "$APP_DIR"
    export PATH=/usr/local/go/bin:$PATH
    log "构建 cyberstrike-ai"
    go build -o cyberstrike-ai cmd/server/main.go
    log "构建完成: $APP_DIR/cyberstrike-ai"
}

# -------------------- 6. 配置 --------------------
ensure_config() {
    cd "$APP_DIR"
    if [ ! -f config.yaml ]; then
        if [ -f config.example.yaml ]; then
            log "生成 config.yaml (from config.example.yaml)"
            cp config.example.yaml config.yaml
        else
            warn "缺少 config.example.yaml，请手工准备 config.yaml"
            return
        fi
    else
        log "config.yaml 已存在（接管保留），不覆盖"
    fi
    # 服务监听 0.0.0.0（Caddy 反代需要跨机访问）；HTTP 模式由 unit 的 --http 决定
    if grep -qE '^\s*host:\s*"127\.0\.0\.1"' config.yaml; then
        log "调整 server.host: 127.0.0.1 → 0.0.0.0（备份 config.yaml.spool-bak）"
        [ -f config.yaml.spool-bak ] || cp config.yaml config.yaml.spool-bak
        sed -i 's/^\(\s*host:\s*\)"127\.0\.0\.1"/\1"0.0.0.0"/' config.yaml
    fi
}

# -------------------- 7. 服务状态 --------------------
reconcile_service() {
    # 若 systemd 已在运行（升级场景）→ 重启加载新二进制
    if systemctl is-active --quiet cyberstrikeai 2>/dev/null; then
        log "服务运行中，重启以加载新构建"
        $SUDO systemctl restart cyberstrikeai
        return
    fi
    # 接管场景：存在游离的手动进程（非 systemd 管理）→ 终止，交由 systemd 接管
    local pids
    pids=$(pgrep -f 'cyberstrike-ai' | grep -v "^$$\$" || true)
    if [ -n "$pids" ]; then
        warn "检测到手动运行的 cyberstrike-ai 进程 (PID: $(echo $pids | tr '\n' ' '))，终止以交由 systemd 接管"
        $SUDO pkill -f 'cyberstrike-ai' || true
    fi
    log "完成。启动服务: spool bundle csai up <host>（或 systemctl start cyberstrikeai）"
}

# -------------------- 主流程 --------------------
log "BASE_DIR=$BASE_DIR APP_DIR=$APP_DIR"
ensure_apt_deps
ensure_go
adopt_or_clone
ensure_venv
build_app
ensure_config
reconcile_service
log "setup 完成"
