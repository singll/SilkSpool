#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-memcore 插件安装器（幂等）
# 组装插件包并装入 web + headless profile；冒烟校验组合树。
# ==============================================================================
set -euo pipefail

BASE_DIR="/opt/silkspool/dsh"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-memcore"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-memcore-plugin] $*"; }
warn() { echo "[sec-memcore-plugin][WARN] $*"; }

assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-memcore.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-memcore.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    cat > "$PLUGIN_DIR/package.json" <<'PKEOF'
{
  "name": "@silksec/sec-memcore",
  "version": "1.0.0",
  "description": "SilkSecAgent memory substrate: unified lifecycle governance (validateWrite/visibilityFilter/transition/recordSignal/sweep) for blackboard/facts/exp_cards/playbooks/kb_docs.",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
PKEOF
    log "插件包已组装"
}

install_plugin() {
    for profile in web headless; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/sec-memcore"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

smoke() {
    log "校验 profile 组合（--dump-config）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'sec-memcore'); then
        log "冒烟通过：sec-memcore 已进组合树"
    else
        warn "冒烟未在组合树中发现 sec-memcore"
        return 1
    fi
}

assemble
install_plugin
smoke
log "完成。重启生效: sudo systemctl restart silksecagent"
