#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 代理池插件安装器（spool bundle dsh setup 调用，幂等）
# 把 templates 平铺推送的插件文件组装成标准 dsh 插件包，再用
# `dsh plugin --profile web add` 装入 web profile（替代原 MCP 模式）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_NAME="@silksec/dsh-proxy-pool"
PLUGIN_DIR="$BASE_DIR/plugins/proxy-pool"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[proxy-pool-plugin] $*"; }
warn() { echo "[proxy-pool-plugin][WARN] $*"; }

# -------------------- 1. 组装插件包 --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-proxy-pool.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-proxy-pool.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    if [ ! -f "$PLUGIN_DIR/package.json" ]; then
        cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/dsh-proxy-pool",
  "version": "0.1.0",
  "description": "SilkSecAgent proxy pool: native dsh tools for the mubeng rotation gateway and graded free-proxy pool (replaces the MCP server).",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
        log "生成 package.json"
    fi
}

# -------------------- 2. 装入 profile（web + headless，worker 需要代理池工具） --------------------
install_plugin() {
    for profile in web headless; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/dsh-proxy-pool"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

# -------------------- 3. 冒烟：profile 组合可解析 --------------------
smoke() {
    log "校验 profile 组合（--dump-config）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'silksec-proxy-pool'); then
        log "冒烟通过：silksec-proxy-pool 已进组合树"
    else
        warn "冒烟未在组合树中发现 silksec-proxy-pool，请检查 plugin add 输出"
        return 1
    fi
}

assemble
install_plugin
smoke || true
log "完成。重启生效: spool restart <host> silksecagent"
