#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-domain-eval 插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 eval 域插件包 + file 后端包并装入 web + headless profile；契约测试硬门槛。
# 依赖：sec-domain-bus 必须先于本脚本组装（setup.sh 顺序保证）。
# 附带：执行 p-v5-1-migrate-eval.js（幂等种子 fp-cases.jsonl / contract-cases.jsonl / runs/ + 原地接管断言）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-domain-eval"
BACKEND_DIR="$BASE_DIR/plugins/sec-backend-eval-file"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-eval-domain-plugin] $*"; }
die()  { echo "[sec-eval-domain-plugin][ERROR] $*" >&2; exit 1; }

assemble() {
    mkdir -p "$PLUGIN_DIR/test"
    cp "$BASE_DIR/dsh-plugin-sec-domain-eval.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-domain-eval.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    cp "$BASE_DIR/dsh-plugin-sec-domain-eval.contract-eval.test.js" "$PLUGIN_DIR/test/contract-eval.test.js"
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-domain-eval",
  "version": "1.0.0",
  "description": "SilkSecAgent eval domain: eval_case_append/run_fp/run_contract + eval_stats/cases/reports (live eval set / FP ablation / contract compliance, file backend, model-invisible writes).",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml", "test/contract-eval.test.js"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
    mkdir -p "$BACKEND_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-backend-eval-file.js" "$BACKEND_DIR/index.js"
    cat > "$BACKEND_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-backend-eval-file",
  "version": "1.0.0",
  "description": "SilkSecAgent eval domain file backend (repository-v1): owns data/eval/ (eval-live/fp-cases/contract-cases/reports/runs), O_APPEND live set + tmp+rename reports.",
  "type": "module",
  "main": "./index.js",
  "license": "MIT"
}
EOF
    log "插件包已组装（$PLUGIN_DIR + $BACKEND_DIR）"
}

install_plugin() {
    for profile in web headless; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/sec-domain-eval"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

run_contract_tests() {
    log "运行 eval 域契约测试（node --test）..."
    (cd "$PLUGIN_DIR" && "$NODE" --test --test-concurrency=1 --test-reporter=spec test/contract-eval.test.js) \
        || die "eval 域契约测试失败，setup 中止"
    log "契约测试全绿"
}

run_migration() {
    if [ -f "$BASE_DIR/p-v5-1-migrate-eval.js" ]; then
        log "执行 eval 域数据迁移/种子（p-v5-1-migrate-eval.js）..."
        SEC_BASE_DIR="$BASE_DIR" SEC_DATA_DIR="$DATA_DIR" "$NODE" "$BASE_DIR/p-v5-1-migrate-eval.js" \
            || die "eval 域迁移/种子失败，setup 中止"
    else
        log "未找到 p-v5-1-migrate-eval.js，跳过迁移（首次部署请确认模板已推送）"
    fi
}

smoke() {
    log "校验 profile 组合（--dump-config）"
    for profile in web headless; do
        if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile "$profile" --dump-config 2>&1 | grep -q 'sec-domain-eval'); then
            log "冒烟通过：sec-domain-eval 已进 $profile 组合树"
        else
            die "冒烟未在 $profile 组合树中发现 sec-domain-eval"
        fi
    done
}

assemble
install_plugin
run_contract_tests
run_migration
smoke
log "完成。重启生效: spool restart <host> silksecagent"
