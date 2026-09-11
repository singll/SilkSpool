#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent v5 部署验收（18-migration.md §五 Phase 3「部署验收命令集」契约化）
# 职责（只读，幂等，可反复重跑；不做任何数据变更）：
#   R0 基础健康：
#     1) 6 个 systemd 单元 active（silksecagent/edge/xray/shared-browser/proxy-rotator/ct-watch）
#     2) scripts/pipeline/data-quality.py --json 通过
#     3) data/AUTHORITY.md 存在（操作员授权声明）
#     4) data/events/ 目录存在（总线事件留痕）
#     5) web + headless 双 profile --dump-config 含 sec-domain-bus 与全部 14 域
#   R4 owns 唯一性：14 域插件在 plugins/ 齐全。域注册 owns 冲突（R4）会拒载该域、
#     其动词不进投影 → dump-config 缺域即红（部署级 owns 冲突的红线信号）。
# 用法：bash sec-v5-accept.sh [--json]
#   环境：DSH_HOME（默认 BASE_DIR/data）
#   退出码：0 = 全部通过；1 = 存在失败项
# ==============================================================================
set -uo pipefail

BASE_DIR="{{BASE_DIR}}"
DATA_DIR="${DSH_HOME:-$BASE_DIR/data}"
APP_DIR="$BASE_DIR/app"
DSH_BIN="$APP_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="/usr/local/node/bin/node"

SERVICES=(silksecagent silksecagent-edge silksec-xray silksec-shared-browser silksec-proxy-rotator ct-watch)
DOMAINS=(vuln asset endpoint task fact know scope approval exec ledger report proxy fgs eval)

JSON_OUT=0
[ "${1:-}" = "--json" ] && JSON_OUT=1

PASS=0; FAIL=0
declare -a CHECKS=()

check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "0" ]; then
    PASS=$((PASS + 1))
    CHECKS+=("{\"check\":\"$name\",\"ok\":true,\"detail\":\"$detail\"}")
    echo "  [PASS] $name"
  else
    FAIL=$((FAIL + 1))
    CHECKS+=("{\"check\":\"$name\",\"ok\":false,\"detail\":\"$detail\"}")
    echo "  [FAIL] $name — $detail"
  fi
}

echo "=== SilkSecAgent v5 部署验收（R0 基础健康 + R4 owns 唯一性）==="

# --- R0.1 六个 systemd 单元 active ---
for svc in "${SERVICES[@]}"; do
  st=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  [ "$st" = "active" ] && check "systemctl $svc" 0 "$st" || check "systemctl $svc" 1 "$st"
done

# --- R0.2 data-quality.py --json ---
if [ -f "$BASE_DIR/scripts/pipeline/data-quality.py" ]; then
  if python3 "$BASE_DIR/scripts/pipeline/data-quality.py" --json >/dev/null 2>&1; then
    check "data-quality.py --json" 0 "exit 0"
  else
    check "data-quality.py --json" 1 "exit != 0"
  fi
else
  check "data-quality.py --json" 1 "脚本缺失"
fi

# --- R0.3 AUTHORITY.md ---
[ -f "$DATA_DIR/AUTHORITY.md" ] && check "data/AUTHORITY.md" 0 "存在" || check "data/AUTHORITY.md" 1 "缺失"

# --- R0.4 data/events/ 目录 ---
[ -d "$DATA_DIR/events" ] && check "data/events/ 目录" 0 "存在" || check "data/events/ 目录" 1 "缺失"

# --- R0.5 dump-config 双 profile 含 bus + 14 域 ---
for profile in web headless; do
  dc=$(cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile "$profile" --dump-config 2>/dev/null || true)
  if [ -z "$dc" ]; then
    check "dump-config $profile (bus+14域)" 1 "dump-config 无输出"
    continue
  fi
  missing=""
  for d in bus "${DOMAINS[@]}"; do
    printf '%s' "$dc" | grep -q "sec-domain-$d" || missing="$missing sec-domain-$d"
  done
  if [ -z "$missing" ]; then
    check "dump-config $profile (bus+14域)" 0 "15 插件全在组合树"
  else
    check "dump-config $profile (bus+14域)" 1 "缺:$missing"
  fi
done

# --- R4 14 域插件在 plugins/ 齐全（owns 冲突的部署级红线：域被拒载则缺工具投影） ---
for d in "${DOMAINS[@]}"; do
  if [ -f "$BASE_DIR/plugins/sec-domain-$d/index.js" ]; then
    check "plugins/sec-domain-$d" 0 "存在"
  else
    check "plugins/sec-domain-$d" 1 "插件缺失"
  fi
done

# --- 汇总 ---
echo ""
echo "=== 验收结果: PASS=$PASS FAIL=$FAIL ==="
if [ "$JSON_OUT" = "1" ]; then
  printf '{"pass":%d,"fail":%d,"checks":[%s]}\n' "$PASS" "$FAIL" "$(IFS=,; echo "${CHECKS[*]}")"
fi
[ "$FAIL" -eq 0 ]
