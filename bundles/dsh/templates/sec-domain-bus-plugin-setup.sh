#!/usr/bin/env bash
# ==============================================================================
# @silksec/sec-domain-bus 插件安装器（spool bundle dsh setup 调用，幂等）
# 组装总线插件包并装入 web + headless profile；别名表部署；契约测试硬门槛；
# 冒烟组合树；任何一步失败 = setup 中止（总线是全部域的宿主，fail-closed）。
#
# 对应 01-bus.md §2.7 的 setup 执行点：
#   §A 组装  §B profile 挂载  §D 别名表校验  §F 契约测试  §G dump-config 冒烟
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PLUGIN_DIR="$BASE_DIR/plugins/sec-domain-bus"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-domain-bus-plugin] $*"; }
warn() { echo "[sec-domain-bus-plugin][WARN] $*"; }
die()  { echo "[sec-domain-bus-plugin][ERROR] $*" >&2; exit 1; }

# -------------------- §A 组装插件包 --------------------
assemble() {
    mkdir -p "$PLUGIN_DIR/test"
    cp "$BASE_DIR/dsh-plugin-sec-domain-bus.js" "$PLUGIN_DIR/index.js"
    cp "$BASE_DIR/dsh-plugin-sec-domain-bus.patch.yml" "$PLUGIN_DIR/cordis.patch.yml"
    cp "$BASE_DIR/dsh-plugin-sec-domain-bus.contract-bus.test.js" "$PLUGIN_DIR/test/contract-bus.test.js"
    cat > "$PLUGIN_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-domain-bus",
  "version": "1.0.0",
  "description": "SilkSecAgent domain bus: DomainRegistry / CommandGateway / QueryGateway / EventOutbox+Dispatcher / ToolProjector / RpcProjector / idempotency / audit v5 / aliases.",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml", "test/contract-bus.test.js"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
EOF
    log "插件包已组装（$PLUGIN_DIR）"
}

# -------------------- §B profile 挂载（web + headless 双面） --------------------
install_plugin() {
    for profile in web headless; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/sec-domain-bus"' "$profile_dir/package.json" 2>/dev/null; then
            log "插件已在 $profile profile 中，跳过（升级插件代码后需 systemctl restart silksecagent）"
            continue
        fi
        log "dsh plugin --profile $profile add $PLUGIN_DIR"
        (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$PLUGIN_DIR")
        log "插件安装完成 ($profile)"
    done
}

# -------------------- 别名表部署（版本受控副本 → data/bus.aliases.yaml） --------------------
deploy_aliases() {
    mkdir -p "$DATA_DIR"
    if [ ! -f "$DATA_DIR/bus.aliases.yaml" ]; then
        cp "$BASE_DIR/bus.aliases.yaml" "$DATA_DIR/bus.aliases.yaml"
        log "别名表已初始化: $DATA_DIR/bus.aliases.yaml"
    else
        log "别名表已存在，不覆盖（运行时副本）"
    fi
}

# -------------------- CLI 归位（data-seed/scripts/sec-bus-cli.mjs → scripts/pipeline/） --------------------
# 沿用 sec-suite-plugin-setup.sh install_scripts 模式（幂等，内容一致才跳过）
install_cli() {
    mkdir -p "$BASE_DIR/scripts/pipeline"
    local src="$BASE_DIR/data-seed/scripts/sec-bus-cli.mjs"
    [ -f "$src" ] || return 0
    if ! cmp -s "$src" "$BASE_DIR/scripts/pipeline/sec-bus-cli.mjs" 2>/dev/null; then
        install -m 0755 "$src" "$BASE_DIR/scripts/pipeline/sec-bus-cli.mjs"
        log "CLI 已归位 → scripts/pipeline/sec-bus-cli.mjs"
    else
        log "CLI 已是最新"
    fi
}

# -------------------- §D 别名表校验（语法/环/自环；目标存在性留到注册期检查） --------------------
validate_aliases() {
    "$NODE" --input-type=module -e '
import * as fs from "node:fs"
const f = process.argv[1]
if (!fs.existsSync(f)) { console.log("别名表不存在（空别名表）"); process.exit(0) }
const text = fs.readFileSync(f, "utf8")
const errs = []
const doc = (() => { try { return JSON.parse(text) } catch { return null } })()
if (doc !== null) {
  // JSON 备用格式
  for (const [k, v] of Object.entries(doc.aliases || {})) if (typeof v !== "string") errs.push(k)
} else {
  const m = text.match(/^aliases:\s*\{\}\s*$/m)
  const md = text.match(/^dispatch_aliases:\s*\{\}\s*$/m)
  if (!m || !md) {
    // 非空：交给总线运行时解析校验（index.js 提供 loadAliases/validateAliases；ESM 用 import）
    const mod = await import("/opt/silkspool/dsh/plugins/sec-domain-bus/index.js")
    if (typeof mod.loadAliases !== "function") errs.push("总线插件未导出 loadAliases")
    else {
      const res = mod.loadAliases(f)
      if (!res.ok) errs.push(...res.errors)
    }
  }
}
if (errs.length) { console.error("别名表非法: " + errs.join("; ")); process.exit(1) }
console.log("别名表结构 OK")
' "$DATA_DIR/bus.aliases.yaml"
}

# -------------------- §F 契约测试（不过 = 中止） --------------------
run_contract_tests() {
    log "运行总线契约测试（node --test）..."
    (cd "$PLUGIN_DIR" && DSH_HOME="$DATA_DIR" "$NODE" --test --test-concurrency=1 --test-reporter=spec test/contract-bus.test.js) \
        || die "总线契约测试失败，setup 中止（总线是全部域的宿主）"
    log "契约测试全绿"
}

# -------------------- §G dump-config 冒烟 --------------------
smoke() {
    log "校验 profile 组合（--dump-config）"
    for profile in web headless; do
        if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile "$profile" --dump-config 2>&1 | grep -q 'sec-domain-bus'); then
            log "冒烟通过：sec-domain-bus 已进 $profile 组合树"
        else
            die "冒烟未在 $profile 组合树中发现 sec-domain-bus"
        fi
    done
}

assemble
deploy_aliases
install_cli
install_plugin
validate_aliases
run_contract_tests
smoke
log "完成。重启生效: spool restart <host> silksecagent"
