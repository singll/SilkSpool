#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 安全看板客户端插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 @silksec/sec-dashboard 双面插件包并装入 web profile（headless 不装）。
#   - 宿主半面：no-op cordis 插件（使本包成为 Loader entry，触发 dsh.client 扫描）
#   - 客户端半面：dsh.client 声明 + exports["./client"]，DSH Web UI 新增「安全看板」标签页
# 数据通道 /silksec-dashboard 由 @silksec/sec-suite 宿主侧提供（connection.rpc）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-dashboard"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-dashboard-plugin] $*"; }
warn() { echo "[sec-dashboard-plugin][WARN] $*"; }

# -------------------- 1. 组装插件包 --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-dashboard.index.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-dashboard.client.js" "$PLUGIN_DIR/client.js"
    cp "$BASE_DIR/dsh-plugin-sec-dashboard.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    # package.json 完全由本脚本管理，始终重写（结构升级时无需手工干预）
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-dashboard",
  "version": "1.0.0",
  "description": "SilkSecAgent dashboard: DSH Web UI slot plugin (assets/vulnerabilities/blackboard views + finding tag & fact-correction write ops).",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@silksec/ui-core"] }
  }
}
EOF
    log "生成 package.json"
}

# -------------------- 2. 装入 web profile --------------------
install_plugin() {
    local profile=web
    local profile_dir="$DATA_DIR/profiles/$profile"
    if grep -q '"@silksec/sec-dashboard"' "$profile_dir/package.json" 2>/dev/null; then
        log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
        return
    fi
    log "dsh plugin --profile $profile add $PLUGIN_DIR"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
    log "插件安装完成 ($profile)"
}

# -------------------- 3. 冒烟：客户端声明被识别 --------------------
smoke() {
    log "校验 client 声明（--dump-config 组合树应含 sec-dashboard）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'sec-dashboard'); then
        log "冒烟通过：sec-dashboard 已进组合树"
    else
        warn "冒烟未在组合树中发现 sec-dashboard"
        return 1
    fi
}

# ==============================================================================
# -------------------- 4. P6 逐域视图包（vuln/asset/endpoint/fact/know/report/audit）
# 19-ui-surface P6：七个浏览型域视图从旧单体 client 拆为独立 client bundle，
# 各自经 @silksec/ui-core 的 viewRegistry 注册（canonical id），ui-panel 主面板装配。
# 每域一个独立包 → 构建隔离（单包语法错误不影响其他包加载）；
# 旧单体对应视图以 `-old` 后缀并排观察 7 天（由 sec-dashboard client 注册）。
# 必须在 ui-core 之后安装（dsh.client.inject 声明 "@silksec/ui-core"）。
# ==============================================================================
VIEW_DOMAINS="vuln asset endpoint fact know report audit"

assemble_view() {
    local d="$1"
    local view_dir="$BASE_DIR/plugins/sec-dashboard-view-$d"
    mkdir -p "$view_dir"
    cp "$BASE_DIR/dsh-plugin-sec-dashboard.view-$d.client.js" "$view_dir/client.js"
    # 宿主半面 no-op loader entry（触发 dsh.client 扫描；无 cordis 服务）
    cat > "$view_dir/index.js" <<EOF
// @silksec/sec-dashboard-view-$d — host half (no-op)
export default { name: 'sec-dashboard-view-$d', inject: [], apply() {} }
EOF
    cat > "$view_dir/cordis.patch.yml" <<EOF
# silksec-sec-dashboard-view-$d bundle layer：把域视图宿主半面挂进 profile
- insert:
    - id: sec-dashboard-view-$d
      name: '@silksec/sec-dashboard-view-$d'
EOF
    cat > "$view_dir/package.json" <<EOF
{
  "name": "@silksec/sec-dashboard-view-$d",
  "version": "0.1.0",
  "description": "SilkSecAgent dashboard domain view ($d): DSH-native browsing view registered into @silksec/ui-core viewRegistry.",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@silksec/ui-core"] }
  }
}
EOF
    log "组装视图包 sec-dashboard-view-$d"
}

install_view() {
    local d="$1"
    local view_dir="$BASE_DIR/plugins/sec-dashboard-view-$d"
    local profile_dir="$DATA_DIR/profiles/web"
    if grep -q "\"@silksec/sec-dashboard-view-$d\"" "$profile_dir/package.json" 2>/dev/null; then
        log "视图包 sec-dashboard-view-$d 已在 web profile 中，跳过"
        return
    fi
    log "dsh plugin --profile web add $view_dir"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile web add "$view_dir")
    log "视图包安装完成 (sec-dashboard-view-$d)"
}

smoke_views() {
    log "校验 P6 视图包声明（--dump-config 组合树应含全部 sec-dashboard-view-*）"
    local dump missing=""
    dump="$(cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 || true)"
    local d
    for d in $VIEW_DOMAINS; do
        echo "$dump" | grep -q "sec-dashboard-view-$d" || missing="$missing $d"
    done
    if [ -z "$missing" ]; then
        log "冒烟通过：7 个 P6 域视图包均已进组合树"
    else
        warn "冒烟未发现视图包:$missing"
        return 1
    fi
}

assemble
install_plugin
smoke || true
for d in $VIEW_DOMAINS; do assemble_view "$d"; done
for d in $VIEW_DOMAINS; do install_view "$d"; done
smoke_views || true
log "完成。重启生效: spool restart <host> silksecagent"
