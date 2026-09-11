#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-domain-vuln 插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 vuln 域插件包 + sqlite 后端包并装入 web + headless profile；契约测试硬门槛；
# 冒烟组合树；任何一步失败 = setup 中止（vuln 域契约是全链的硬门槛）。
#
# 对应 02-vuln.md §1.1 与 01-bus.md §2.7 的 setup 执行点：
#   §A 组装（域插件 + 后端插件）  §B profile 挂载  §F 契约测试  §G dump-config 冒烟
# 依赖：sec-domain-bus 必须先于本脚本组装（setup.sh 顺序保证）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-domain-vuln"
BACKEND_DIR="$BASE_DIR/plugins/sec-backend-vuln-sqlite"
HTTP_BACKEND_DIR="$BASE_DIR/plugins/sec-backend-vuln-http"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-vuln-domain-plugin] $*"; }
warn() { echo "[sec-vuln-domain-plugin][WARN] $*"; }
die()  { echo "[sec-vuln-domain-plugin][ERROR] $*" >&2; exit 1; }

# -------------------- §A 组装插件包（域 + 后端） --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR/test"
    cp "$BASE_DIR/dsh-plugin-sec-domain-vuln.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-domain-vuln.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    cp "$BASE_DIR/dsh-plugin-sec-domain-vuln.contract-vuln.test.js" "$PLUGIN_DIR/test/contract-vuln.test.js"
    cp "$BASE_DIR/dsh-plugin-sec-domain-vuln.contract-vuln-http.test.js" "$PLUGIN_DIR/test/contract-vuln-http.test.js"
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-domain-vuln",
  "version": "1.0.0",
  "description": "SilkSecAgent vuln domain: register_signal/register_candidate/confirm/reject/submit/note/claim/release/verify_replay/attach_fgs/authz_diff + Q1-Q6.",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml", "test/contract-vuln.test.js"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
    mkdir -p "$BACKEND_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-backend-vuln-sqlite.js" "$BACKEND_DIR/index.js"
    cat > "$BACKEND_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-backend-vuln-sqlite",
  "version": "1.0.0",
  "description": "SilkSecAgent vuln domain sqlite-local backend (repository-v1): direct adoption of findings table + ensureCol column evolution.",
  "type": "module",
  "main": "./index.js",
  "license": "MIT"
}
EOF
    mkdir -p "$HTTP_BACKEND_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-backend-vuln-http.js" "$HTTP_BACKEND_DIR/index.js"
    cat > "$HTTP_BACKEND_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-backend-vuln-http",
  "version": "1.0.0",
  "description": "SilkSecAgent vuln domain http-remote backend (repository-v1): external vuln-management REST + local sqlite overlay (hybrid) + outbox sync.",
  "type": "module",
  "main": "./index.js",
  "license": "MIT"
}
EOF
    log "插件包已组装（$PLUGIN_DIR + $BACKEND_DIR + $HTTP_BACKEND_DIR）"
}

# -------------------- §B profile 挂载（web + headless 双面） --------------------
install_plugin() {
    for profile in web headless; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/sec-domain-vuln"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

# -------------------- §F 契约测试（不过 = 中止） --------------------
run_contract_tests() {
    log "运行 vuln 域契约测试（node --test：sqlite-local + http-remote 同套跑）..."
    (cd "$PLUGIN_DIR" && SEC_DATA_DIR="$DATA_DIR" "$NODE" --test --test-concurrency=1 --test-reporter=spec test/contract-vuln.test.js test/contract-vuln-http.test.js) \
        || die "vuln 域契约测试失败，setup 中止"
    log "契约测试全绿"
}

# -------------------- §G dump-config 冒烟 --------------------
smoke() {
    log "校验 profile 组合（--dump-config）"
    for profile in web headless; do
        if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile "$profile" --dump-config 2>&1 | grep -q 'sec-domain-vuln'); then
            log "冒烟通过：sec-domain-vuln 已进 $profile 组合树"
        else
            die "冒烟未在 $profile 组合树中发现 sec-domain-vuln"
        fi
    done
}

assemble
install_plugin
run_contract_tests
smoke
log "完成。重启生效: spool restart <host> silksecagent"