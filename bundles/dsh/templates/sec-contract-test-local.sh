#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 契约测试本地组装器（仓库内运行，非部署路径）
# 把 bundles/dsh/templates 下的 dsh-plugin-sec-*.js 组装成部署态目录结构
# （plugins/sec-domain-*/index.js + test/ + plugins/sec-backend-*/index.js），
# 然后用 node --test 跑契约测试。
# 用法：
#   bash sec-contract-test-local.sh            # 跑全部域契约
#   bash sec-contract-test-local.sh ledger vuln # 只跑指定域
# 退出码：0 = 全部通过
# ==============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${SEC_CONTRACT_OUT:-/tmp/sec-contract-assemble}"
NODE="${NODE_BIN:-node}"

rm -rf "$OUT"
mkdir -p "$OUT/plugins"

# 域插件 + 契约测试
for f in "$HERE"/dsh-plugin-sec-domain-*.js; do
  base="$(basename "$f")"
  rest="${base#dsh-plugin-sec-domain-}"
  domain="${rest%%.*}"
  case "$rest" in
    "$domain.js")
      mkdir -p "$OUT/plugins/sec-domain-$domain"
      cp "$f" "$OUT/plugins/sec-domain-$domain/index.js"
      ;;
    "$domain".contract-*.test.js)
      testname="${rest#"$domain".}"
      mkdir -p "$OUT/plugins/sec-domain-$domain/test"
      cp "$f" "$OUT/plugins/sec-domain-$domain/test/$testname"
      ;;
    *) ;; # patch.yml 等非 js 已不匹配本 glob
  esac
done

# 后端插件
for f in "$HERE"/dsh-plugin-sec-backend-*.js; do
  base="$(basename "$f" .js)"
  backend="${base#dsh-plugin-sec-backend-}"
  mkdir -p "$OUT/plugins/sec-backend-$backend"
  cp "$f" "$OUT/plugins/sec-backend-$backend/index.js"
done

# sec-suite 共享模块（被域插件 import 的运行时依赖）
mkdir -p "$OUT/plugins/sec-suite"
for m in host-compat parse-proposal task-policy worker-runtime asset-db asset-graph experience webhook native-guard dashboard-rpc; do
  f="$HERE/dsh-plugin-sec-suite.$m.js"
  [ -f "$f" ] && cp "$f" "$OUT/plugins/sec-suite/$m.js"
done

# 规则层模块（sec-rules-*，含测试）
for f in "$HERE"/dsh-plugin-sec-rules-*.js; do
  [ -e "$f" ] || continue
  base="$(basename "$f" .js)"
  case "$base" in
    *.test)
      mod="${base%.test}"
      mod="${mod#dsh-plugin-}"
      mkdir -p "$OUT/plugins/$mod/test"
      cp "$f" "$OUT/plugins/$mod/test/index.test.js"
      ;;
    *)
      mod="${base#dsh-plugin-}"
      mkdir -p "$OUT/plugins/$mod"
      cp "$f" "$OUT/plugins/$mod/index.js"
      ;;
  esac
done

# 收集测试文件
tests=()
if [ "$#" -gt 0 ]; then
  for d in "$@"; do
    while IFS= read -r t; do tests+=("$t"); done < <(find "$OUT/plugins/sec-domain-$d/test" "$OUT/plugins/sec-rules-$d/test" "$OUT/plugins/$d/test" -name '*.test.js' 2>/dev/null | sort)
  done
else
  while IFS= read -r t; do tests+=("$t"); done < <(find "$OUT/plugins" -name '*.test.js' | sort)
fi

[ "${#tests[@]}" -gt 0 ] || { echo "未找到测试文件"; exit 1; }

fixture_home="$(mktemp -d /tmp/sec-contract-home-XXXXXX)"
cd "$OUT"
SEC_DATA_DIR="$fixture_home" DSH_HOME="$fixture_home" "$NODE" --test --test-concurrency=1 "${tests[@]}"
