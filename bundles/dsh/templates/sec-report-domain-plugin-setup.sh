#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-domain-report 插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 report 域插件包 + sqlite 后端包（索引）+ file 后端包（产物文件）并装入 web + headless profile；契约测试硬门槛。
# 依赖：sec-domain-bus 必须先于本脚本组装（setup.sh 顺序保证）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-domain-report"
BACKEND_SQLITE_DIR="$BASE_DIR/plugins/sec-backend-report-sqlite"
BACKEND_FILE_DIR="$BASE_DIR/plugins/sec-backend-report-file"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-report-domain-plugin] $*"; }
die()  { echo "[sec-report-domain-plugin][ERROR] $*" >&2; exit 1; }

assemble() {
    mkdir -p "$PLUGIN_DIR/test"
    cp "$BASE_DIR/dsh-plugin-sec-domain-report.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-domain-report.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    cp "$BASE_DIR/dsh-plugin-sec-domain-report.contract-report.test.js" "$PLUGIN_DIR/test/contract-report.test.js"
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-domain-report",
  "version": "1.0.0",
  "description": "SilkSecAgent report domain: report_build/report_draft_submission + report_list/report_read (frontmatter authoritative + reports index; data/reports/ owner).",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml", "test/contract-report.test.js"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
    mkdir -p "$BACKEND_SQLITE_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-backend-report-sqlite.js" "$BACKEND_SQLITE_DIR/index.js"
    cat > "$BACKEND_SQLITE_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-backend-report-sqlite",
  "version": "1.0.0",
  "description": "SilkSecAgent report domain sqlite-local backend (reports index): rebuilt-cache index, frontmatter authoritative.",
  "type": "module",
  "main": "./index.js",
  "license": "MIT"
}
EOF
    mkdir -p "$BACKEND_FILE_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-backend-report-file.js" "$BACKEND_FILE_DIR/index.js"
    cat > "$BACKEND_FILE_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-backend-report-file",
  "version": "1.0.0",
  "description": "SilkSecAgent report domain file backend (data/reports/): atomic write (tmp+rename), path-prefix-safe read.",
  "type": "module",
  "main": "./index.js",
  "license": "MIT"
}
EOF
    log "插件包已组装（$PLUGIN_DIR + $BACKEND_SQLITE_DIR + $BACKEND_FILE_DIR）"
}

install_plugin() {
    for profile in web headless; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/sec-domain-report"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

run_contract_tests() {
    log "运行 report 域契约测试（node --test）..."
    (cd "$PLUGIN_DIR" && SEC_DATA_DIR="$DATA_DIR" "$NODE" --test --test-concurrency=1 --test-reporter=spec test/contract-report.test.js) \
        || die "report 域契约测试失败，setup 中止"
    log "契约测试全绿"
}

smoke() {
    log "校验 profile 组合（--dump-config）"
    for profile in web headless; do
        if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile "$profile" --dump-config 2>&1 | grep -q 'sec-domain-report'); then
            log "冒烟通过：sec-domain-report 已进 $profile 组合树"
        else
            die "冒烟未在 $profile 组合树中发现 sec-domain-report"
        fi
    done
}

assemble
install_plugin
run_contract_tests
smoke
log "完成。重启生效: spool restart <host> silksecagent"
