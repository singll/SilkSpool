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
    cp "$BASE_DIR/dsh-plugin-sec-suite.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    if [ ! -f "$PLUGIN_DIR/package.json" ]; then
        cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-suite",
  "version": "0.1.0",
  "description": "SilkSecAgent security suite: sec-cli-adapter (manifest-driven CLI runner) with built-in scope-guard whitelist enforcement.",
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

# -------------------- 2. tools.d 种子清单（只在为空时初始化） --------------------
seed_manifests() {
    mkdir -p "$DATA_DIR/tools.d"
    if compgen -G "$DATA_DIR/tools.d/*.yaml" >/dev/null 2>&1; then
        log "tools.d 已有清单，跳过种子初始化"
        return
    fi
    log "写入 tools.d 种子清单"
    cat > "$DATA_DIR/tools.d/subfinder.yaml" <<'EOF'
name: subfinder
binary: /usr/local/bin/subfinder
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [domains]
produces: [subdomains]
args_template: "-d {{target}} -silent -o {{outdir}}/subfinder.txt"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF
    cat > "$DATA_DIR/tools.d/httpx.yaml" <<'EOF'
name: httpx
binary: /usr/local/bin/httpx
stage: recon
risk: passive
timeout: 300
target_param: target
requires: [subdomains]
produces: [live_hosts, fingerprints]
args_template: "-u {{target}} -json -silent"
env_proxy: true
parser: jsonl
summarize: head
store: asset-graph
EOF
    cat > "$DATA_DIR/tools.d/nuclei.yaml" <<'EOF'
name: nuclei
binary: /usr/local/bin/nuclei
stage: vuln
risk: active
timeout: 1800
target_param: target
requires: [live_hosts]
produces: [findings]
args_template: "-u {{target}} -jsonl -silent -rl {{rate|50}} -o {{outdir}}/nuclei.jsonl"
env_proxy: true
parser: jsonl
summarize: head
store: asset-graph
EOF
    cat > "$DATA_DIR/tools.d/katana.yaml" <<'EOF'
name: katana
binary: /usr/local/bin/katana
stage: recon
risk: passive
timeout: 600
target_param: target
requires: [live_hosts]
produces: [urls]
args_template: "-u {{target}} -silent -d {{depth|2}} -o {{outdir}}/katana.txt"
env_proxy: true
parser: lines
summarize: head
store: asset-graph
EOF
    # 管线自检测试工具（不触网，验证 run_cli 全链路）
    cat > "$DATA_DIR/tools.d/echo-test.yaml" <<'EOF'
name: echo-test
binary: /bin/echo
stage: recon
risk: passive
timeout: 10
target_param: target
requires: []
produces: [selftest]
args_template: "selftest ok target={{target}} run={{run_id}}"
env_proxy: false
parser: lines
summarize: head
store: none
EOF
}

# -------------------- 3. 装入 web profile --------------------
install_plugin() {
    local profile_dir="$DATA_DIR/profiles/web"
    [ -d "$profile_dir" ] || { warn "profile 目录不存在: $profile_dir（先启动一次 dsh web）"; return 1; }

    if grep -q '"@silksec/sec-suite"' "$profile_dir/package.json" 2>/dev/null; then
        log "插件已在 profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
        return 0
    fi
    log "dsh plugin --profile web add $PLUGIN_DIR"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile web add "$PLUGIN_DIR")
    log "插件安装完成"
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
install_plugin
smoke || true
log "完成。重启生效: spool restart <host> silksecagent"
