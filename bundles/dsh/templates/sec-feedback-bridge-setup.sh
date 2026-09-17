#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-feedback-bridge 插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 DSH 原生反馈桥并装入 web profile（headless 无 UI 反馈面，不挂载）。
# 依赖：sec-domain-know 必须先于本脚本组装（know_feedback_ingest 唯一落账通道）；
# DSH 侧 message-feedback 未挂载时桥显式 unsupported（不伪造反馈流量）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-feedback-bridge"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-feedback-bridge] $*"; }
die()  { echo "[sec-feedback-bridge][ERROR] $*" >&2; exit 1; }

assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-feedback-bridge.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-feedback-bridge.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-feedback-bridge",
  "version": "1.0.0",
  "description": "SilkSecAgent DSH native feedback bridge (rc.2 message-feedback -> know_feedback_ingest; web profile only; explicit unsupported when messageFeedback service absent).",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
    log "插件包已组装（$PLUGIN_DIR）"
}

install_plugin() {
    local profile_dir="$DATA_DIR/profiles/web"
    if grep -q '"@silksec/sec-feedback-bridge"' "$profile_dir/package.json" 2>/dev/null; then
        log "插件已在 web profile 中，跳过"
    else
        log "dsh plugin --profile web add $PLUGIN_DIR"
        # store-dir 须与既有 profile node_modules 的链接商店一致（pnpm v11 全局
        # 配置在 ~/.config/pnpm/config.yaml；此处再以 env 兜底，避免换机复现）。
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH npm_config_store_dir="$BASE_DIR/.pnpm-store" "$NODE" "$DSH_BIN" plugin --profile web add "$PLUGIN_DIR")
        log "插件安装完成 (web)"
    fi
}

smoke() {
    log "校验 web profile 组合（--dump-config）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>/dev/null | grep -q 'sec-feedback-bridge'); then
        log "冒烟通过：sec-feedback-bridge 已进 web 组合树"
    else
        die "冒烟未在 web 组合树中发现 sec-feedback-bridge"
    fi
    # headless 不应挂载（无 UI 反馈面）
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile headless --dump-config 2>/dev/null | grep -q 'sec-feedback-bridge'); then
        die "sec-feedback-bridge 不应出现在 headless 组合树"
    fi
    log "冒烟通过：headless 未挂载（符合设计）"
}

assemble
install_plugin
smoke

log "完成。重启生效: spool restart <host> silksecagent"
