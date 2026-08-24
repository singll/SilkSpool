#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 安全套件插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 @silksec/sec-suite 插件包并装入 web profile；初始化 tools.d 种子清单。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-suite"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-suite-plugin] $*"; }
warn() { echo "[sec-suite-plugin][WARN] $*"; }

# -------------------- 1. 组装插件包 --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-suite.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-suite.asset-db.js" "$PLUGIN_DIR/asset-db.js"
    cp "$BASE_DIR/dsh-plugin-sec-suite.asset-graph.js" "$PLUGIN_DIR/asset-graph.js"
    cp "$BASE_DIR/dsh-plugin-sec-suite.experience.js" "$PLUGIN_DIR/experience.js"
    cp "$BASE_DIR/dsh-plugin-sec-suite.parsers.js" "$PLUGIN_DIR/parsers.js"
    cp "$BASE_DIR/dsh-plugin-sec-suite.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    # package.json 完全由本脚本管理，始终重写（结构升级时不需要手工干预）
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-suite",
  "version": "1.0.0",
  "description": "SilkSecAgent security suite: sec-cli-adapter (manifest-driven CLI runner + scope-guard) and asset-graph (SQLite asset/endpoint/finding/blackboard store).",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./asset-graph": "./asset-graph.js",
    "./experience": "./experience.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "asset-db.js", "asset-graph.js", "experience.js", "parsers.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
    log "生成 package.json"
}

# -------------------- 2. tools.d 种子清单（幂等补齐缺失） --------------------
seed_manifests() {
    if [ -f "$BASE_DIR/seed-manifests.sh" ]; then
        DSH_HOME="$DATA_DIR" bash "$BASE_DIR/seed-manifests.sh"
    else
        warn "seed-manifests.sh 不存在，跳过"
    fi
}

# -------------------- 3. 装入 profile（web + headless，worker 需要 run_cli） --------------------
install_plugin() {
    for profile in web headless; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/sec-suite"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

# -------------------- 4. 冒烟：组合树可解析 --------------------
smoke() {
    log "校验 profile 组合（--dump-config）"
    if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'sec-cli-adapter'); then
        log "冒烟通过：sec-cli-adapter 已进组合树"
    else
        warn "冒烟未在组合树中发现 sec-cli-adapter"
        return 1
    fi
}

assemble
seed_manifests
if [ -f "$BASE_DIR/seed-skills.sh" ]; then
    DSH_HOME="$DATA_DIR" bash "$BASE_DIR/seed-skills.sh" || warn "Skill 种子失败（不影响主程序）"
fi
if [ -f "$BASE_DIR/seed-presets.sh" ]; then
    DSH_HOME="$DATA_DIR" bash "$BASE_DIR/seed-presets.sh" || warn "Preset 种子失败（不影响主程序）"
fi
install_plugin
smoke || true
log "完成。重启生效: spool restart <host> silksecagent"
