#!/usr/bin/env bash
# ==============================================================================
# @silksec/ui-task 安装器（spool bundle dsh setup 调用，幂等）
# 19-ui-surface P3 任务套件：任务右侧栏 page tab（四区块栏宽自适应）+ 会话头
# 「本会话任务」计数（conversation.session.header.utilities）。
#   - 宿主半面：no-op cordis 插件（使本包成为 Loader entry，触发 dsh.client 扫描）
#   - 客户端半面：跨 bundle require @silksec/ui-core；sidebar-right 提供
#     ctx.sidebarRight / ctx.sidebarRightTabs 与 keyed tab 槽；conversation 提供
#     session header utilities 槽。
# 必须在 ui-core / ui-panel / ui-approval 之后安装（消费 ui-core 注册表做降级视图）；
# sec-dashboard 旧入口保留（任务 tab 观察期 + Modal 降级）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/ui-task"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[ui-task-plugin] $*"; }
warn() { echo "[ui-task-plugin][WARN] $*"; }

# -------------------- 1. 组装插件包 --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-silksec-ui-task.index.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-silksec-ui-task.client.js" "$PLUGIN_DIR/client.js"
    cp "$BASE_DIR/dsh-plugin-silksec-ui-task.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    # package.json 完全由本脚本管理，始终重写（结构升级时无需手工干预）
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/ui-task",
  "version": "0.1.0",
  "description": "SilkSecAgent task suite: DSH-native sidebar-right task page tab (four responsive sections) + session-header task count.",
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
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@silksec/ui-core"
      ]
    }
  }
}
EOF
    log "生成 package.json"
}

# -------------------- 2. 装入 web profile --------------------
install_plugin() {
    local profile=web
    local profile_dir="$DATA_DIR/profiles/$profile"
    if grep -q '"@silksec/ui-task"' "$profile_dir/package.json" 2>/dev/null; then
        log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
        return
    fi
    log "dsh plugin --profile $profile add $PLUGIN_DIR"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
    log "插件安装完成 ($profile)"
}

# -------------------- 3. 冒烟：客户端声明被识别 --------------------
smoke() {
    log "校验 client 声明（--dump-config 组合树应含 ui-task）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'ui-task'); then
        log "冒烟通过：ui-task 已进组合树"
    else
        warn "冒烟未在组合树中发现 ui-task"
        return 1
    fi
}

assemble
install_plugin
smoke || true
log "完成。重启生效: spool restart <host> silksecagent"
