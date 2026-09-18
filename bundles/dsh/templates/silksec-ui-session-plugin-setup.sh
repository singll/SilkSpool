#!/usr/bin/env bash
# ==============================================================================
# @silksec/ui-session 安装器（spool bundle dsh setup 调用，幂等）
# 19-ui-surface P5 会话内绑定：conversation.view「安全产出」+ 会话头计数钮 +
# assistant-actions「登记候选漏洞 / 沉淀事实」。
#   - 宿主半面：no-op cordis 插件（使本包成为 Loader entry，触发 dsh.client 扫描）
#   - 客户端半面：跨 bundle require @silksec/ui-core；conversation 提供 view /
#     session header utilities 槽，chat 提供 assistant-actions 槽；写操作走
#     /silksec-domain（vuln.finding_add / fact.upsert，actor=dashboard）。
# 必须在 ui-core 之后安装（消费注册表/hooks）；建议在 ui-settings-scope 之后、
# sec-dashboard 之前。会话槽缺席 → 不注册，不改变主面板 legacy 行为。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/ui-session"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[ui-session-plugin] $*"; }
warn() { echo "[ui-session-plugin][WARN] $*"; }

# -------------------- 1. 组装插件包 --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-silksec-ui-session.index.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-silksec-ui-session.client.js" "$PLUGIN_DIR/client.js"
    cp "$BASE_DIR/dsh-plugin-silksec-ui-session.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    # package.json 完全由本脚本管理，始终重写（结构升级时无需手工干预）
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/ui-session",
  "version": "0.1.0",
  "description": "SilkSecAgent session bindings: DSH-native conversation.view security output + session-header badge + assistant-actions register/deposit.",
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
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-chat",
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
    if grep -q '"@silksec/ui-session"' "$profile_dir/package.json" 2>/dev/null; then
        log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
        return
    fi
    log "dsh plugin --profile $profile add $PLUGIN_DIR"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
    log "插件安装完成 ($profile)"
}

# -------------------- 3. 冒烟：客户端声明被识别 --------------------
smoke() {
    log "校验 client 声明（--dump-config 组合树应含 ui-session）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'ui-session'); then
        log "冒烟通过：ui-session 已进组合树"
    else
        warn "冒烟未在组合树中发现 ui-session"
        return 1
    fi
}

assemble
install_plugin
smoke || true
log "完成。重启生效: spool restart <host> silksecagent"
