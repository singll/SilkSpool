#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-rules-hypothesis 安装器（spool bundle dsh setup 调用，幂等）
# 组装假设/判定规则层包（纯函数，21 号方案 §四~§八）：登录态判定/业务语义/
# 评级硬降级/污点路由/H1 保底/oracle 五件套/注入防护/局面编译。
# 被 endpoint/vuln 等域插件以相对路径 import（plugins/sec-rules-hypothesis/index.js）；
# 不注册域、不进 profile 组合树（非 cordis 插件）。
# 契约测试硬门槛（纯函数逐条钉死，不过 = setup 中止）。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-rules-hypothesis"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-rules-hypothesis] $*"; }
die()  { echo "[sec-rules-hypothesis][ERROR] $*" >&2; exit 1; }

assemble() {
    mkdir -p "$PLUGIN_DIR/test"
    cp "$BASE_DIR/dsh-plugin-sec-rules-hypothesis.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-rules-hypothesis.test.js" "$PLUGIN_DIR/test/index.test.js"
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-rules-hypothesis",
  "version": "1.0.0",
  "description": "SilkSecAgent hypothesis/rule layer (pure functions): auth-state classifier, business-semantics suggest, severity caps, taint routing, H1 fallback, oracle quintet, injection fence, situation compiler.",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "test/index.test.js"],
  "license": "MIT"
}
EOF
    log "规则层包已组装（$PLUGIN_DIR）"
}

run_tests() {
    log "运行规则层契约测试（node --test）..."
    (cd "$PLUGIN_DIR" && DSH_HOME="$DATA_DIR" "$NODE" --test --test-concurrency=1 --test-reporter=spec test/index.test.js) \
        || die "规则层契约测试失败，setup 中止"
    log "契约测试全绿"
}

assemble
run_tests
log "完成（规则层为被 import 的纯函数包，重启 silksecagent 后随域插件加载生效）"
