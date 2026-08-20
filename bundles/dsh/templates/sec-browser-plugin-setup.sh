#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 浏览器插件（dsh-browser fork，+流量总线代理支持）
# 上游 wqty123/dsh-browser@0.1.0 不支持 proxy 配置，本脚本把已安装的上游包
# 复制为 @silksec/dsh-browser 并注入 SEC_FLOW_PROXY 支持（browser → xray:7777 → mubeng:8899）。
# 幂等：上游版本未变且已打过补丁则跳过。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
PROFILE_DIR="$DATA_DIR/profiles/web"
UPSTREAM="$PROFILE_DIR/node_modules/dsh-browser"
PLUGIN_DIR="$BASE_DIR/plugins/sec-browser"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

log()  { echo "[sec-browser] $*"; }
warn() { echo "[sec-browser][WARN] $*"; }

if [ -f "$UPSTREAM/package.json" ]; then
    SRC_LIB="$UPSTREAM/lib"
    upstream_ver=$(python3 -c 'import json;print(json.load(open("'"$UPSTREAM"'/package.json"))["version"])')
elif [ -f "$BASE_DIR/dsh-browser-upstream.index.js" ]; then
    # 回退：bundle 自带的上游 lib 副本（dsh-browser@0.1.0，plugins.lock 有 hash 记录）
    SRC_LIB="$BASE_DIR/.sec-browser-src"
    mkdir -p "$SRC_LIB"
    cp "$BASE_DIR/dsh-browser-upstream.index.js" "$SRC_LIB/index.js"
    cp "$BASE_DIR/dsh-browser-upstream.browser-manager.js" "$SRC_LIB/browser-manager.js"
    upstream_ver="0.1.0"
else
    warn "上游 dsh-browser 未安装且 bundle 无自带副本"
    exit 0
fi

# 幂等检查：版本一致且已注入代理支持则跳过
ours_ver=$(python3 -c 'import json,os;print(json.load(open("'"$PLUGIN_DIR"'/package.json")).get("x_upstream_version",""))' 2>/dev/null || echo "")
if [ "$ours_ver" = "$upstream_ver" ] && grep -q "SEC_FLOW_PROXY" "$PLUGIN_DIR/lib/browser-manager.js" 2>/dev/null; then
    log "已是最新补丁版（上游 $upstream_ver），跳过"
else
    log "构建 @silksec/dsh-browser（基于上游 $upstream_ver + SEC_FLOW_PROXY 补丁）"
    rm -rf "$PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
    cp -r "$SRC_LIB" "$PLUGIN_DIR/lib"
    [ -f "$UPSTREAM/README.md" ] && cp "$UPSTREAM/README.md" "$PLUGIN_DIR/" || true

    # 注入代理支持（chromium.launch 增加 proxy 选项）
    python3 - "$PLUGIN_DIR/lib/browser-manager.js" <<'PYEOF'
import sys
p = sys.argv[1]
src = open(p).read()
anchor = "chromium.launch({"
idx = src.find(anchor)
if idx < 0:
    sys.exit("未找到 chromium.launch 锚点")
inject = ("proxy: process.env.SEC_FLOW_PROXY ? { server: process.env.SEC_FLOW_PROXY } : undefined,\n"
          + " " * 16)
pos = src.find("{", idx) + 1
src = src[:pos] + "\n" + inject + src[pos+0:]
open(p, "w").write(src)
print("proxy 注入完成")
PYEOF

    cat > "$PLUGIN_DIR/package.json" <<EOF
{
  "name": "@silksec/dsh-browser",
  "version": "0.1.0-silksec.1",
  "description": "Fork of dsh-browser@$upstream_ver with SEC_FLOW_PROXY support (browser traffic through xray passive bus).",
  "type": "module",
  "main": "./lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "license": "MIT",
  "x_upstream_version": "$upstream_ver",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "playwright-core": "^1.49.0"
  }
}
EOF
    cat > "$PLUGIN_DIR/cordis.patch.yml" <<'EOF'
# 与上游同 id：后装的 bundle 按 id 覆盖上游 browser 行
- insert:
    - id: browser
      name: '@silksec/dsh-browser'
EOF
fi

# 装入 profile：先卸上游（避免同 id 歧义）；fork 打 tarball 安装
# （link: 安装的包 pnpm 不装其依赖，tarball 才能正确解析 schemastery 等）
install_plugin() {
    local tgz
    tgz=$(cd "$PLUGIN_DIR" && PATH=/usr/local/node/bin:$PATH npm pack --pack-destination "$BASE_DIR/plugins" 2>/dev/null | tail -1)
    [ -n "$tgz" ] || { warn "npm pack 失败"; return 1; }
    for profile in web; do
        local profile_dir="$DATA_DIR/profiles/$profile"
        if grep -q '"@silksec/dsh-browser"' "$profile_dir/package.json" 2>/dev/null \
           && grep -q "tgz" "$profile_dir/package.json" 2>/dev/null; then
            log "fork 已在 $profile profile 中（tarball 安装）"
        else
            for old in dsh-browser @silksec/dsh-browser; do
                if grep -q "\"$old\"" "$profile_dir/package.json" 2>/dev/null; then
                    log "移除 $old（由 tarball fork 替代）"
                    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" remove "$old") || warn "移除 $old 失败"
                fi
            done
            log "dsh plugin --profile $profile add $BASE_DIR/plugins/$tgz"
            (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" PATH=/usr/local/node/bin:$PATH "$NODE" "$DSH_BIN" plugin --profile "$profile" add "$BASE_DIR/plugins/$tgz")
        fi
    done
}

install_plugin

# 冒烟
if (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 | grep -q '@silksec/dsh-browser'); then
    log "冒烟通过：@silksec/dsh-browser 已进组合树"
else
    warn "冒烟未发现 @silksec/dsh-browser"
fi
log "完成。重启生效: spool restart <host> silksecagent"
