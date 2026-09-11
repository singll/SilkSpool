#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-domain-proxy 插件安装器（spool bundle dsh setup 调用，幂等）
# 组装 proxy 域插件包 + file 后端包并装入 web + headless profile；契约测试硬门槛。
# 依赖：sec-domain-bus 必须先于本脚本组装（setup.sh 顺序保证）。
# 附带：确保 {BASE_DIR}/proxy-pool 五文件对域用户（silkspool）可写——采集单元以 root 跑，
#       落池主路径已从 proxy_grade.py 直写收敛到 proxy_refresh 命令（silkspool 写五文件）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-domain-proxy"
BACKEND_DIR="$BASE_DIR/plugins/sec-backend-proxy-file"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-proxy-domain-plugin] $*"; }
die()  { echo "[sec-proxy-domain-plugin][ERROR] $*" >&2; exit 1; }

assemble() {
    mkdir -p "$PLUGIN_DIR/test"
    cp "$BASE_DIR/dsh-plugin-sec-domain-proxy.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-domain-proxy.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    cp "$BASE_DIR/dsh-plugin-sec-domain-proxy.contract-proxy.test.js" "$PLUGIN_DIR/test/contract-proxy.test.js"
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-domain-proxy",
  "version": "1.0.0",
  "description": "SilkSecAgent proxy domain: proxy_refresh/report_bad/sticky_bind + proxy_stats/list/gateway (free-proxy pool, file backend, mubeng native watch).",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml", "test/contract-proxy.test.js"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
    mkdir -p "$BACKEND_DIR"
    cp "$BASE_DIR/dsh-plugin-sec-backend-proxy-file.js" "$BACKEND_DIR/index.js"
    cat > "$BACKEND_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-backend-proxy-file",
  "version": "1.0.0",
  "description": "SilkSecAgent proxy domain file backend (repository-v1): owns pool.json/live.txt/blocklist.txt/stats.json/sticky.json, atomic tmp+rename, proposal inbox read-only.",
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
        if grep -q '"@silksec/sec-domain-proxy"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

run_contract_tests() {
    log "运行 proxy 域契约测试（node --test）..."
    (cd "$PLUGIN_DIR" && "$NODE" --test --test-concurrency=1 --test-reporter=spec test/contract-proxy.test.js) \
        || die "proxy 域契约测试失败，setup 中止"
    log "契约测试全绿"
}

ensure_writable() {
    local pooldir="$BASE_DIR/proxy-pool"
    local sudo=''
    if [ "$(id -u)" -ne 0 ]; then sudo='sudo'; fi
    if [ ! -d "$pooldir" ]; then
        $sudo mkdir -p "$pooldir/out"
        log "代理池目录不存在，已初始化 $pooldir"
    fi
    for f in pool.json live.txt blocklist.txt stats.json sticky.json; do
        $sudo touch "$pooldir/$f" 2>/dev/null || true
        $sudo chown silkspool:silkspool "$pooldir/$f" 2>/dev/null || true
    done
    $sudo chown silkspool:silkspool "$pooldir" 2>/dev/null || true
    log "代理池五文件已确认对 silkspool 可写"
}

# 落池 CLI 归位（data-seed/scripts/sec-proxy-land.mjs → scripts/pipeline/，timer 链 ExecStartPost 调用）
install_land_cli() {
    mkdir -p "$BASE_DIR/scripts/pipeline"
    local src="$BASE_DIR/data-seed/scripts/sec-proxy-land.mjs"
    [ -f "$src" ] || return 0
    if ! cmp -s "$src" "$BASE_DIR/scripts/pipeline/sec-proxy-land.mjs" 2>/dev/null; then
        install -m 0755 "$src" "$BASE_DIR/scripts/pipeline/sec-proxy-land.mjs"
        log "落池 CLI 已归位 → scripts/pipeline/sec-proxy-land.mjs"
    else
        log "落池 CLI 已是最新"
    fi
}

smoke() {
    log "校验 profile 组合（--dump-config）"
    for profile in web headless; do
        if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile "$profile" --dump-config 2>&1 | grep -q 'sec-domain-proxy'); then
            log "冒烟通过：sec-domain-proxy 已进 $profile 组合树"
        else
            die "冒烟未在 $profile 组合树中发现 sec-domain-proxy"
        fi
    done
}

assemble
install_plugin
run_contract_tests
ensure_writable
install_land_cli
smoke
log "完成。重启生效: spool restart <host> silksecagent"
