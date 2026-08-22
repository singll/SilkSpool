#!/usr/bin/env bash
# ==============================================================================
# 丝之歌主题客户端插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 @silksec/theme-silksong 双面插件包并装入 web profile（headless 不装）。
#   - 宿主半面：no-op cordis 插件（使本包成为 Loader entry，触发 dsh.client 扫描）
#   - 客户端半面：注册全局深色主题 silksong（设置→通用可开关）
# 设计规范：bundles/dsh/doc/silksong-theme-design.md
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/theme-silksong"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[theme-silksong-plugin] $*"; }
warn() { echo "[theme-silksong-plugin][WARN] $*"; }

# -------------------- 1. 组装插件包 --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-theme-silksong.index.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-theme-silksong.client.js" "$PLUGIN_DIR/client.js"
    cp "$BASE_DIR/dsh-plugin-theme-silksong.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    # package.json 完全由本脚本管理，始终重写（结构升级时无需手工干预）
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/theme-silksong",
  "version": "0.1.0",
  "description": "SilkSecAgent Silksong theme: global dark theme registered via dsh-client-ui-theme registry (Hollow Knight: Silksong palette).",
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
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-theme"] }
  }
}
EOF
    log "生成 package.json"
}

# -------------------- 2. 装入 web profile --------------------
install_plugin() {
    local profile=web
    local profile_dir="$DATA_DIR/profiles/$profile"
    if grep -q '"@silksec/theme-silksong"' "$profile_dir/package.json" 2>/dev/null; then
        log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
        return
    fi
    log "dsh plugin --profile $profile add $PLUGIN_DIR"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
    log "插件安装完成 ($profile)"
}

# -------------------- 3. 冒烟：客户端声明被识别 --------------------
smoke() {
    log "校验 client 声明（--dump-config 组合树应含 theme-silksong）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'theme-silksong'); then
        log "冒烟通过：theme-silksong 已进组合树"
    else
        warn "冒烟未在组合树中发现 theme-silksong"
        return 1
    fi
}

assemble
install_plugin
smoke || true
log "完成。重启生效: spool restart <host> silksecagent"
