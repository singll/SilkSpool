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
#   R5 UI 冒烟（16-dashboard §2.6）：
#     ① 结构断言（默认，只读幂等）：13 个 UI 包均在 web 组合树、client bundle 落盘；
#     ②③④ 运行时断言（--ui-headless，经既有 headless 通道）：组合 bundle 200 且含各包、
#        window.__silksecSurfaceHealth 各面 ok/degraded、1 读 1 写 RPC 往返（写经路由 stub 不落库）。
# 用法：bash sec-v5-accept.sh [--json] [--ui-headless]
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
UI_HEADLESS=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    --ui-headless) UI_HEADLESS=1 ;;
  esac
done

PASS=0; FAIL=0
declare -a CHECKS=()

# JSON 字段转义：反斜杠→斜杠、双引号→单引号（报告只读，保证 --json 合法）
json_esc() { local s="${1//\\//}"; printf '%s' "${s//\"/\'}"; }

check() {
  local name ok detail
  name="$(json_esc "$1")"; ok="$2"; detail="$(json_esc "${3:-}")"
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

echo "=== SilkSecAgent v5 部署验收（R0 基础健康 + R4 owns 唯一性 + R5 UI 冒烟）==="

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

# --- R5 UI 冒烟（16-dashboard §2.6） ---
# 13 个 UI 面：6 个承载面包 + 7 个逐域视图包。旧单体 @silksec/sec-dashboard
# （Modal 壳 + `-old` 并排视图 + footer 入口）已删除，不再是必需面。
UI_PKG_IDS=(
  '@silksec/ui-core' '@silksec/ui-panel' '@silksec/ui-approval' '@silksec/ui-task'
  '@silksec/ui-settings-scope' '@silksec/ui-session'
  '@silksec/sec-dashboard-view-vuln' '@silksec/sec-dashboard-view-asset' '@silksec/sec-dashboard-view-endpoint'
  '@silksec/sec-dashboard-view-fact' '@silksec/sec-dashboard-view-know' '@silksec/sec-dashboard-view-report'
  '@silksec/sec-dashboard-view-audit'
)
UI_PKG_DIRS=(ui-core ui-panel ui-approval ui-task ui-settings-scope ui-session
  sec-dashboard-view-vuln sec-dashboard-view-asset sec-dashboard-view-endpoint
  sec-dashboard-view-fact sec-dashboard-view-know sec-dashboard-view-report sec-dashboard-view-audit)

ui_dump="$(cd "$APP_DIR" && DSH_HOME="$DATA_DIR" "$NODE" "$DSH_BIN" --profile web --dump-config 2>/dev/null || true)"
for i in "${!UI_PKG_IDS[@]}"; do
  pkg="${UI_PKG_IDS[$i]}"; dir="${UI_PKG_DIRS[$i]}"
  if [ -z "$ui_dump" ]; then
    check "ui-loader $pkg" 1 "web dump-config 无输出"
  elif ! printf '%s' "$ui_dump" | grep -qF "$pkg"; then
    check "ui-loader $pkg" 1 "组合树缺 loader entry"
  elif [ ! -s "$BASE_DIR/plugins/$dir/client.js" ]; then
    check "ui-loader $pkg" 1 "client bundle 缺失或为空"
  else
    check "ui-loader $pkg" 0 "组合树 loader entry + client bundle 落盘"
  fi
done

# 主题 v4.2 §11.7：视图/表面文件零颜色字面量（hex/rgb）；ui-core 是令牌源（含 SEV fallback），豁免
ui_color_hits=""
for dir in "${UI_PKG_DIRS[@]}"; do
  [ "$dir" = "ui-core" ] && continue
  f="$BASE_DIR/plugins/$dir/client.js"
  [ -f "$f" ] || continue
  if grep -Eq '#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(' "$f"; then ui_color_hits="$ui_color_hits $dir"; fi
done
if [ -z "$ui_color_hits" ]; then
  check "ui-no-color-literals" 0 "12 个表面 bundle 零 hex/rgb（ui-core 令牌源豁免）"
else
  check "ui-no-color-literals" 1 "命中:$ui_color_hits"
fi

if [ "$UI_HEADLESS" = "1" ]; then
  ui_out=""; ui_rc=0
  if [ -f "$BASE_DIR/dsh-ui-surface-smoke.py" ]; then
    ui_out="$(python3 "$BASE_DIR/dsh-ui-surface-smoke.py" 2>&1)" || ui_rc=$?
  else
    ui_rc=1; ui_out="UI_CHECK|1|ui-headless-harness|缺少 dsh-ui-surface-smoke.py"
  fi
  ui_checks=0
  while IFS= read -r line; do
    case "$line" in
      UI_CHECK\|*)
        rest="${line#UI_CHECK|}"
        ok="${rest%%|*}"; rest="${rest#*|}"
        name="${rest%%|*}"; detail="${rest#*|}"
        check "$name" "$ok" "$detail"
        ui_checks=$((ui_checks + 1))
        ;;
    esac
  done <<< "$ui_out"
  if [ "$ui_checks" -eq 0 ]; then
    check "ui-headless-harness" 1 "未产出 UI_CHECK（rc=$ui_rc）：$(printf '%s' "$ui_out" | tail -2 | tr '\n' ' ')"
  fi
fi

# --- 汇总 ---
echo ""
echo "=== 验收结果: PASS=$PASS FAIL=$FAIL ==="
if [ "$JSON_OUT" = "1" ]; then
  printf '{"pass":%d,"fail":%d,"checks":[%s]}\n' "$PASS" "$FAIL" "$(IFS=,; echo "${CHECKS[*]}")"
fi
[ "$FAIL" -eq 0 ]
