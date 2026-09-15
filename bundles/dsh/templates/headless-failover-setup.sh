#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent headless worker 模型熔断回退安装器（spool bundle dsh setup 调用，幂等）
# 背景 2026-08-24：worker（headless profile）未挂 dsh-model-failover 时，
# provider 一次瞬时 TRANSPORT 错误 = 定时任务硬失败（web 对话会自动切 deepseek，worker 不会）。
# 本脚本确保 headless profile 装入固定 dsh-model-failover 0.1.4（由 pnpm 锁管理），
# 并写入 worker 侧 cordis.patch.yml（fallbacks=deepseek/deepseek-chat，六类错误熔断）。
# 注意：headless cordis.patch.yml 同时由 spool sync（hosts/<host>/dsh/headless.cordis.patch.yml）管理；
# 本脚本仅在文件缺失时写默认，不覆盖 sync 下发的版本。
# ==============================================================================
set -euo pipefail

BASE_DIR="${SEC_BASE_DIR:-{{BASE_DIR}}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
WEB_PROFILE="$DATA_DIR/profiles/web"
HEADLESS_PROFILE="$DATA_DIR/profiles/headless"
FAILOVER_SRC="$WEB_PROFILE/node_modules/dsh-model-failover"

log()  { echo "[headless-failover] $*"; }
warn() { echo "[headless-failover][WARN] $*"; }

# -------------------- 0. 前置检查 --------------------
if [ ! -d "$HEADLESS_PROFILE" ]; then
    warn "headless profile 不存在（$HEADLESS_PROFILE）"
    exit 1
fi
if [ ! -d "$FAILOVER_SRC" ]; then
    warn "web profile 未安装 dsh-model-failover（$FAILOVER_SRC）"
    exit 1
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
if (pkg.dependencies['dsh-model-failover'] !== '0.1.4') {
    pkg.dependencies['dsh-model-failover'] = '0.1.4'
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

# -------------------- 2. 固定依赖和锁（禁止跨 profile 手建软链） --------------------
(
    cd "$HEADLESS_PROFILE"
    export PATH=/usr/local/node/bin:$PATH CI=true
    pnpm install --prod --ignore-scripts --no-frozen-lockfile
    pnpm install --prod --ignore-scripts --frozen-lockfile --offline
)

# -------------------- 3. worker 侧 cordis.patch.yml（缺失才写默认；sync 管理的版本不覆盖） --------------------
if [ ! -s "$HEADLESS_PROFILE/cordis.patch.yml" ]; then
    cat > "$HEADLESS_PROFILE/cordis.patch.yml" <<'EOF'
# SilkSecAgent overlay: headless worker 模型熔断回退（与 web profile 一致）
# 背景 2026-08-24：worker 无 failover 时 provider 瞬时 TRANSPORT 错误 = 任务硬失败。
# fallback: agent-default-model（现为 bellkeeper/pool-secagent） → deepseek 官方直连。
# P18：任务级 provider/model 覆盖通过 --patch 单独生效，不受 failover 影响。
- id: model-failover
  config:
    enabled: true
    fallbacks:
      - provider: deepseek
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

# -------------------- 4. 验证两个 profile 的实际版本 --------------------
python3 - "$WEB_PROFILE" "$HEADLESS_PROFILE" <<'PY'
import json, sys
from pathlib import Path
for profile in sys.argv[1:]:
    package = Path(profile) / 'node_modules/dsh-model-failover/package.json'
    if json.loads(package.read_text())['version'] != '0.1.4':
        raise RuntimeError('failover 安装版本不符')
PY
log "完成。重启生效: spool restart <host> silksecagent"
