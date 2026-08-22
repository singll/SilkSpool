#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent (DSH) 幂等安装脚本（spool bundle dsh setup 调用，可重复运行）
# 职责：依赖 → Node LTS → DSH(pin 版本, npm 安装) → 数据目录 → 服务状态
# 设计原则：程序目录 (app/) 与数据目录 (data/) 分离；已存在配置不覆盖
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="$BASE_DIR/data"
DSH_VERSION="0.1.0-rc.7"          # pin：升级只走 dsh-upgrade.sh
NODE_MAJOR=22

log()  { echo "[setup] $*"; }
warn() { echo "[setup][WARN] $*"; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then SUDO='sudo'; fi

# -------------------- 1. 系统依赖 --------------------
ensure_apt_deps() {
    command -v apt-get >/dev/null 2>&1 || { warn "非 apt 系统，请手动确认 git/curl 已安装"; return; }
    local missing=()
    for pkg in git curl tar xz-utils ca-certificates bubblewrap; do
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

# -------------------- 2. Node LTS + pnpm --------------------
node_ok() {
    local bin="$1"
    [ -x "$bin" ] || return 1
    local major
    major=$("$bin" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    [ -n "$major" ] && [ "$major" -ge "$NODE_MAJOR" ]
}

ensure_node() {
    export PATH=/usr/local/node/bin:$PATH
    if node_ok /usr/local/node/bin/node; then
        log "Node 已就绪: $(/usr/local/node/bin/node -v)"
        return
    fi
    local arch
    case "$(uname -m)" in
        x86_64)  arch=x64 ;;
        aarch64) arch=arm64 ;;
        *) warn "不支持的架构: $(uname -m)"; return 1 ;;
    esac
    # 解析 Node 22 LTS 最新小版本
    local ver
    ver=$(curl -fsSL "https://nodejs.org/dist/index.json" \
        | python3 -c 'import json,sys; ds=[d for d in json.load(sys.stdin) if d.get("lts") and d["version"].startswith("v22.")]; print(ds[0]["version"])')
    [ -n "$ver" ] || { warn "无法获取 Node LTS 版本"; return 1; }
    log "安装 Node $ver (linux-$arch)"
    curl -fsSL "https://nodejs.org/dist/${ver}/node-${ver}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz
    $SUDO rm -rf /usr/local/node
    $SUDO mkdir -p /usr/local/node
    $SUDO tar -C /usr/local/node --strip-components=1 -xJf /tmp/node.tar.xz
    rm -f /tmp/node.tar.xz
    # 软链到 PATH（不覆盖系统包管理器的 node）
    $SUDO ln -sf /usr/local/node/bin/node /usr/local/bin/node
    $SUDO ln -sf /usr/local/node/bin/npm /usr/local/bin/npm
    $SUDO ln -sf /usr/local/node/bin/npx /usr/local/bin/npx
    log "Node 安装完成: $(/usr/local/node/bin/node -v)"
}

ensure_pnpm() {
    export PATH=/usr/local/node/bin:$PATH
    if command -v pnpm >/dev/null 2>&1; then
        log "pnpm 已就绪: $(pnpm -v)"
        return
    fi
    # DSH 依赖图巨大，npm arborist 解析极慢，必须用 pnpm
    log "安装 pnpm"
    $SUDO env PATH=/usr/local/node/bin:$PATH npm install -g pnpm --no-audit --no-fund
    log "pnpm 安装完成: $(pnpm -v)"
}

# -------------------- 3. DSH 安装（npm，pin 版本） --------------------
install_dsh() {
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"

    local installed=""
    if [ -f node_modules/@deepseek-ai/dsh/package.json ]; then
        installed=$(python3 -c 'import json;print(json.load(open("node_modules/@deepseek-ai/dsh/package.json"))["version"])' 2>/dev/null || true)
    fi
    if [ "$installed" = "$DSH_VERSION" ]; then
        log "DSH $DSH_VERSION 已安装，跳过（升级走 dsh-upgrade.sh）"
        return
    fi

    log "安装 @deepseek-ai/dsh@$DSH_VERSION （当前: ${installed:-none}）"
    if [ ! -f package.json ]; then
        cat > package.json <<EOF
{
  "name": "silksecagent",
  "private": true,
  "version": "0.1.0",
  "description": "SilkSecAgent - DSH based AI security platform (managed by spool bundle dsh)",
  "dependencies": {
    "@deepseek-ai/dsh": "$DSH_VERSION"
  }
}
EOF
    else
        # 已存在 package.json：仅在版本不一致时更新依赖声明
        python3 - "$DSH_VERSION" <<'EOF'
import json, sys
p = json.load(open("package.json"))
p.setdefault("dependencies", {})["@deepseek-ai/dsh"] = sys.argv[1]
json.dump(p, open("package.json", "w"), indent=2, ensure_ascii=False)
EOF
    fi
    export PATH=/usr/local/node/bin:$PATH
    pnpm install --prod --ignore-scripts
    log "DSH 安装完成: $(node node_modules/@deepseek-ai/dsh/lib/bin.js --version 2>/dev/null || echo "$DSH_VERSION")"
}

# -------------------- 4. 数据目录与配置 --------------------
ensure_data() {
    mkdir -p "$DATA_DIR"/{results,backups,tools.d,knowledge,playbooks,skills/draft,flows,imports}
    mkdir -p "$BASE_DIR/xray"
    # 密钥文件权限固化（审计 S5：sync push 可能写回 644，此处兜底 600）
    if [ -f "$BASE_DIR/.env" ]; then chmod 600 "$BASE_DIR/.env"; fi
    # 授权白名单：只初始化，不覆盖
    if [ ! -f "$DATA_DIR/scope.yml" ]; then
        if [ -f "$BASE_DIR/scope.yml" ]; then
            cp "$BASE_DIR/scope.yml" "$DATA_DIR/scope.yml"
            log "初始化授权白名单: $DATA_DIR/scope.yml"
        fi
    else
        log "scope.yml 已存在，不覆盖"
    fi
}

# -------------------- 5. 服务状态 --------------------
reconcile_service() {
    if systemctl is-active --quiet silksecagent 2>/dev/null; then
        log "服务运行中，重启以加载新安装"
        $SUDO systemctl restart silksecagent
        return
    fi
    # 接管场景：存在游离的手动 dsh 进程 → 终止，交由 systemd 接管
    local pids
    pids=$(pgrep -f 'deepseek-ai/dsh' || true)
    if [ -n "$pids" ]; then
        warn "检测到手动运行的 dsh 进程 (PID: $(echo $pids | tr '\n' ' '))，终止以交由 systemd 接管"
        $SUDO pkill -f 'deepseek-ai/dsh' || true
    fi
    log "完成。启动服务: spool bundle dsh up <host>（或 systemctl start silksecagent）"
}

# -------------------- 主流程 --------------------
log "BASE_DIR=$BASE_DIR APP_DIR=$APP_DIR DATA_DIR=$DATA_DIR"
ensure_apt_deps
ensure_node
ensure_pnpm
install_dsh
ensure_data
reconcile_service

# -------------------- 6. 代理池基础设施（mubeng 网关 + 采集刷新） --------------------
if [ -f "$BASE_DIR/proxy-pool-infra-setup.sh" ]; then
    bash "$BASE_DIR/proxy-pool-infra-setup.sh" || warn "代理池基础设施安装失败（不影响 DSH 主程序）"
fi

# -------------------- 7. 代理池 dsh 插件（替代 MCP 模式） --------------------
if [ -f "$BASE_DIR/proxy-pool-plugin-setup.sh" ]; then
    bash "$BASE_DIR/proxy-pool-plugin-setup.sh" || warn "代理池插件安装失败（不影响 DSH 主程序）"
fi

# -------------------- 8. 安全套件插件（sec-cli-adapter + scope-guard） --------------------
if [ -f "$BASE_DIR/sec-suite-plugin-setup.sh" ]; then
    bash "$BASE_DIR/sec-suite-plugin-setup.sh" || warn "安全套件插件安装失败（不影响 DSH 主程序）"
fi

# -------------------- 8.5 浏览器 fork（流量入总线） --------------------
if [ -f "$BASE_DIR/sec-browser-plugin-setup.sh" ]; then
    bash "$BASE_DIR/sec-browser-plugin-setup.sh" || warn "浏览器 fork 安装失败（不影响 DSH 主程序）"
fi

# -------------------- 8.6 向量嵌入模块 --------------------
if [ -f "$BASE_DIR/embeddings-setup.sh" ]; then
    bash "$BASE_DIR/embeddings-setup.sh" || warn "嵌入模块安装失败（语义检索降级为 FTS）"
fi

# -------------------- 8.7 安全看板客户端插件（DSH Web UI slot） --------------------
if [ -f "$BASE_DIR/sec-dashboard-plugin-setup.sh" ]; then
    bash "$BASE_DIR/sec-dashboard-plugin-setup.sh" || warn "安全看板插件安装失败（不影响 DSH 主程序）"
fi

# -------------------- 8.8 丝之歌全局主题客户端插件 --------------------
if [ -f "$BASE_DIR/theme-silksong-plugin-setup.sh" ]; then
    bash "$BASE_DIR/theme-silksong-plugin-setup.sh" || warn "丝之歌主题插件安装失败（不影响 DSH 主程序）"
fi

# -------------------- 9. 情报刷新定时器（intel-feeder v1，每日） --------------------
if [ -f "$BASE_DIR/intel-refresh.sh" ]; then
    $SUDO tee /etc/systemd/system/silksec-intel.service >/dev/null <<EOF
[Unit]
Description=SilkSecAgent intel refresh (nuclei/afrog template update)

[Service]
Type=oneshot
User=silkspool
ExecStart=/bin/bash $BASE_DIR/intel-refresh.sh
EOF
    $SUDO tee /etc/systemd/system/silksec-intel.timer >/dev/null <<'EOF'
[Unit]
Description=SilkSecAgent intel refresh (daily)

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now silksec-intel.timer 2>/dev/null || warn "intel timer 启用失败"
fi

# -------------------- 9.5 数据保留期定时器（审计 S7，每日） --------------------
if [ -f "$BASE_DIR/retention.sh" ]; then
    $SUDO tee /etc/systemd/system/silksec-retention.service >/dev/null <<EOF
[Unit]
Description=SilkSecAgent data retention cleanup (flows/results/audit)

[Service]
Type=oneshot
User=silkspool
ExecStart=/bin/bash $BASE_DIR/retention.sh
EOF
    $SUDO tee /etc/systemd/system/silksec-retention.timer >/dev/null <<'EOF'
[Unit]
Description=SilkSecAgent data retention cleanup (daily)

[Timer]
OnCalendar=*-*-* 05:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now silksec-retention.timer 2>/dev/null || warn "retention timer 启用失败"
fi

# -------------------- 9.6 SQLite 快照备份定时器（P0-5，每 6 小时） --------------------
if [ -f "$BASE_DIR/silksec-backup.sh" ]; then
    chmod +x "$BASE_DIR/silksec-backup.sh" "$BASE_DIR/silksec-restore.sh" 2>/dev/null || true
    $SUDO tee /etc/systemd/system/silksec-backup.service >/dev/null <<EOF
[Unit]
Description=SilkSecAgent SQLite consistent snapshot backup

[Service]
Type=oneshot
User=silkspool
ExecStart=/bin/bash $BASE_DIR/silksec-backup.sh
EOF
    $SUDO tee /etc/systemd/system/silksec-backup.timer >/dev/null <<'EOF'
[Unit]
Description=SilkSecAgent SQLite snapshot backup (every 6h)

[Timer]
OnCalendar=*-*-* 00/6:17:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now silksec-backup.timer 2>/dev/null || warn "backup timer 启用失败"
fi
log "setup 完成"
