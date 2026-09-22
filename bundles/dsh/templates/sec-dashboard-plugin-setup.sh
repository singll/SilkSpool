#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 看板域视图包安装器（spool bundle dsh setup 调用，幂等）
#
# v5 收口后看板 UI 唯一形态：
#   - 承载面包：@silksec/ui-core / ui-panel / ui-approval / ui-task /
#     ui-settings-scope / ui-session（各自 setup 脚本先于本脚本执行）
#   - 浏览型域视图：本脚本组装 7 个独立 client bundle
#     @silksec/sec-dashboard-view-{vuln,asset,endpoint,fact,know,report,audit}
#     经 @silksec/ui-core 的 viewRegistry 注册 canonical id，ui-panel 主面板装配。
#
# 旧单体 @silksec/sec-dashboard（Modal 壳 + `-old` 并排视图 + footer 入口）已删除：
# 任务/审批/授权迁 DSH 原生右侧栏/设置页承载面，浏览型七域由上述独立包承载。
# 数据通道 /silksec-dashboard 仍由 @silksec/sec-suite 宿主侧提供。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"
export PATH="/usr/local/node/bin:$PATH"

log()  { echo "[sec-dashboard-views] $*"; }
warn() { echo "[sec-dashboard-views][WARN] $*"; }

VIEW_DOMAINS="vuln asset endpoint fact know report audit"

assemble_view() {
    local d="$1"
    local view_dir="$BASE_DIR/plugins/sec-dashboard-view-$d"
    mkdir -p "$view_dir"
    cp "$BASE_DIR/dsh-plugin-sec-dashboard.view-$d.client.js" "$view_dir/client.js"
    # 宿主半面 no-op loader entry（触发 dsh.client 扫描；无 cordis 服务）
    cat > "$view_dir/index.js" <<EOF
// @silksec/sec-dashboard-view-$d — host half (no-op)
export default { name: 'sec-dashboard-view-$d', inject: [], apply() {} }
EOF
    cat > "$view_dir/cordis.patch.yml" <<EOF
# silksec-sec-dashboard-view-$d bundle layer：把域视图宿主半面挂进 profile
- insert:
    - id: sec-dashboard-view-$d
      name: '@silksec/sec-dashboard-view-$d'
EOF
    cat > "$view_dir/package.json" <<EOF
{
  "name": "@silksec/sec-dashboard-view-$d",
  "version": "0.1.0",
  "description": "SilkSecAgent dashboard domain view ($d): DSH-native browsing view registered into @silksec/ui-core viewRegistry.",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@silksec/ui-core"] }
  }
}
EOF
    log "组装视图包 sec-dashboard-view-$d"
}

install_view() {
    local d="$1"
    local view_dir="$BASE_DIR/plugins/sec-dashboard-view-$d"
    local profile_dir="$DATA_DIR/profiles/web"
    if grep -q "\"@silksec/sec-dashboard-view-$d\"" "$profile_dir/package.json" 2>/dev/null; then
        log "视图包 sec-dashboard-view-$d 已在 web profile 中，跳过"
        return
    fi
    log "dsh plugin --profile web add $view_dir"
    (cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" plugin --profile web add "$view_dir")
    log "视图包安装完成 (sec-dashboard-view-$d)"
}

smoke_views() {
    log "校验域视图包声明（--dump-config 组合树应含全部 sec-dashboard-view-*）"
    local dump missing=""
    dump="$(cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>&1 || true)"
    local d
    for d in $VIEW_DOMAINS; do
        echo "$dump" | grep -q "sec-dashboard-view-$d" || missing="$missing $d"
    done
    if [ -z "$missing" ]; then
        log "冒烟通过：7 个域视图包均已进组合树"
    else
        warn "冒烟未发现视图包:$missing"
        return 1
    fi
}

for d in $VIEW_DOMAINS; do assemble_view "$d"; done
for d in $VIEW_DOMAINS; do install_view "$d"; done
smoke_views || true
log "完成。重启生效: spool restart <host> silksecagent"
