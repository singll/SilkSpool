#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent headless worker 模型熔断回退安装器（spool bundle dsh setup 调用，幂等）
# 背景 2026-08-24：worker（headless profile）未挂 dsh-model-failover 时，
# provider 一次瞬时 TRANSPORT 错误 = 定时任务硬失败（web 对话会自动切 deepseek，worker 不会）。
# 本脚本确保 headless profile 装入 dsh-model-failover（复用 web profile 的 npm 副本，软链不重复下载），
# 并写入 worker 侧 cordis.patch.yml（fallbacks=deepseek/deepseek-chat，六类错误熔断）。
# 注意：headless cordis.patch.yml 同时由 spool sync（hosts/<host>/dsh/headless.cordis.patch.yml）管理；
# 本脚本仅在文件缺失时写默认，不覆盖 sync 下发的版本。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
WEB_PROFILE="$DATA_DIR/profiles/web"
HEADLESS_PROFILE="$DATA_DIR/profiles/headless"
FAILOVER_SRC="$WEB_PROFILE/node_modules/dsh-model-failover"

log()  { echo "[headless-failover] $*"; }
warn() { echo "[headless-failover][WARN] $*"; }

# -------------------- 0. 前置检查 --------------------
if [ ! -d "$HEADLESS_PROFILE" ]; then
    warn "headless profile 不存在（$HEADLESS_PROFILE），跳过"
    exit 0
fi
if [ ! -d "$FAILOVER_SRC" ]; then
    warn "web profile 未安装 dsh-model-failover（$FAILOVER_SRC），跳过"
    exit 0
fi

# -------------------- 1. package.json：依赖 + bundles 条目（node 幂等改写） --------------------
/usr/local/node/bin/node - "$HEADLESS_PROFILE" <<'EOF'
const fs = require('fs')
const path = require('path')
const profileDir = process.argv[2]
const pkgFile = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
let changed = false
pkg.dependencies = pkg.dependencies || {}
if (!pkg.dependencies['dsh-model-failover']) {
    pkg.dependencies['dsh-model-failover'] = 'file:/opt/silkspool/dsh/data/profiles/web/node_modules/dsh-model-failover'
    changed = true
}
const bundles = (((pkg.dsh || {}).profile || {}).bundles) || []
if (!bundles.includes('dsh-model-failover')) {
    bundles.push('dsh-model-failover')
    pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {}; pkg.dsh.profile.bundles = bundles
    changed = true
}
if (changed) {
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
    console.log('[headless-failover] package.json 已写入 dsh-model-failover 依赖与 bundle 条目')
} else {
    console.log('[headless-failover] package.json 已包含 dsh-model-failover，跳过')
}
EOF

# -------------------- 2. node_modules 软链（复用 web 副本） --------------------
mkdir -p "$HEADLESS_PROFILE/node_modules"
if [ ! -e "$HEADLESS_PROFILE/node_modules/dsh-model-failover" ]; then
    ln -s ../../web/node_modules/dsh-model-failover "$HEADLESS_PROFILE/node_modules/dsh-model-failover"
    log "软链已建: headless/node_modules/dsh-model-failover -> web 副本"
else
    log "软链已存在，跳过"
fi

# -------------------- 3. worker 侧 cordis.patch.yml（缺失才写默认；sync 管理的版本不覆盖） --------------------
if [ ! -s "$HEADLESS_PROFILE/cordis.patch.yml" ]; then
    cat > "$HEADLESS_PROFILE/cordis.patch.yml" <<'EOF'
# SilkSecAgent overlay: headless worker 模型熔断回退（与 web profile 一致）
# 背景 2026-08-24：worker 无 failover 时 provider 瞬时 TRANSPORT 错误 = 任务硬失败。
# fallback: agent-default-model（现为 deepseek） → opencode-go（保留额度时可用）。
# P18：任务级 provider/model 覆盖通过 --patch 单独生效，不受 failover 影响。
- id: model-failover
  config:
    enabled: true
    fallbacks:
      - provider: opencode-go
        model: deepseek-v4-flash
    tripCodes:
      - RATE_LIMIT
      - SERVER
      - TIMEOUT
      - TRANSPORT
      - QUOTA
      - EMPTY_RESPONSE
    modelCircuitThreshold: 1
    modelCooldownMs: 60000
    platformCircuitThreshold: 1
    platformCooldownMs: 120000
    burstWindowMs: 300000
    enableProbe: true
    probeMaxTokens: 8
    stripReasoningEffort: true
    notifyUser: true
EOF
    log "已写入默认 cordis.patch.yml（后续由 spool sync 管理）"
else
    log "cordis.patch.yml 已存在（spool sync 管理），跳过"
fi

# -------------------- 4. 冒烟：软链目标可读 --------------------
if [ -f "$HEADLESS_PROFILE/node_modules/dsh-model-failover/package.json" ]; then
    log "冒烟通过：headless 可解析 dsh-model-failover"
else
    warn "冒烟失败：软链目标不可读"
    exit 1
fi
log "完成。重启生效: spool restart <host> silksecagent"
