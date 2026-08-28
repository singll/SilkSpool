#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 流水线插件安装器（幂等）
# 组装 @silksec/dsh-sec-pipeline 插件包并装入 web/headless profile。
# ==============================================================================
set -euo pipefail

BASE_DIR="/opt/silkspool/dsh"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-pipeline"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log() { echo "[sec-pipeline-plugin] $*"; }

mkdir -p "$PLUGIN_DIR"
cp "$BASE_DIR/dsh-plugin-sec-pipeline.js" "$PLUGIN_DIR/index.js"
cp "$BASE_DIR/dsh-plugin-sec-pipeline.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/dsh-sec-pipeline",
  "version": "1.0.0",
  "description": "SilkSecAgent pipeline: coverage ledger / card usage / validation / coverage report / verify replay / surface consume as native dsh tools.",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
log "插件包已组装"

for profile in web headless; do
    profile_dir="$DATA_DIR/profiles/$profile"
    if grep -q '"@silksec/dsh-sec-pipeline"' "$profile_dir/package.json" 2>/dev/null; then
        log "已在 $profile profile 中（代码更新需 systemctl restart silksecagent）"
        continue
    fi
    log "dsh plugin --profile $profile add $PLUGIN_DIR"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
done

log "冒烟：--dump-config 检查组合树"
if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q 'sec-pipeline'); then
    log "冒烟通过：sec-pipeline 已进组合树"
else
    echo "[sec-pipeline-plugin][WARN] 组合树未发现 sec-pipeline"
    exit 1
fi
