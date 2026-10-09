#!/usr/bin/env bash
# 按注册表启动指定名字的隔离共享浏览器 profile。
# 由模板单元 silksec-shared-browser@.service 调用：ExecStart=... shared-browser-launch.sh %i
# 复用同一个 shared-browser-host.mjs（单持久 profile + CDP + Scope 出口守卫），只是换 profile 目录与端口。
set -euo pipefail
name="${1:?usage: shared-browser-launch.sh <profile-name>}"
case "$name" in
  primary) echo "primary profile 由 silksec-shared-browser.service 承载，不走模板单元" >&2; exit 2 ;;
  *[!a-z0-9_-]*|'') echo "非法 profile 名（仅 [a-z0-9_-]）: $name" >&2; exit 2 ;;
esac
REG="${SEC_BROWSER_PROFILES:-/opt/silkspool/dsh/data/browser-profiles.json}"
HOST_JS="${SHARED_BROWSER_HOST:-/home/silkspool/日常/browser/shared-browser-host.mjs}"
read -r port dir < <(python3 - "$REG" "$name" <<'PY'
import json, sys
reg, name = sys.argv[1], sys.argv[2]
data = json.load(open(reg, encoding='utf-8'))
row = next((x for x in data.get('profiles', []) if x.get('name') == name), None)
if not row:
    raise SystemExit(f"profile not found in registry: {name}")
print(int(row['port']), row['dir'])
PY
)
export HOME=/home/silkspool
export SEC_FLOW_PROXY="${SEC_FLOW_PROXY:-http://127.0.0.1:7777}"
export SEC_BROWSER_PROFILE="$dir"
export CDP_PORT="$port"
exec /usr/local/node/bin/node "$HOST_JS"
