#!/usr/bin/env bash
# ============================================================================
# fofa_search —— FOFA 被动资产测绘查询（对齐遗留 cyberstrikeai fofa_search）
# ----------------------------------------------------------------------------
# 用途：只做被动空间测绘（域名/证书/端口/组件维度查询），产出暴露面线索，
#       不进行任何主动探测与漏洞验证（漏洞确认由 vuln 链环节承担）。
# 凭据：$HOME/.config/fofa.conf（FOFA_EMAIL/FOFA_KEY，chmod 600）
#       回退：/opt/silkspool/dsh/data/fofa.conf
#       （bwrap 沙箱只挂 /usr /etc $HOME venv opt + runDir，凭据须放 $HOME）
# 用法：
#   fofa_search -d meituan.com                       # domain 锚定查询（默认）
#   fofa_search --query 'cert="meituan.com"'         # 自定义 FOFA 语法
#   fofa_search -d meituan.com --size 200 --fields host,ip,port,title
# 合规：scope-guard 以 target(=domain) 硬校验授权；--query 自由语法须由调用者
#       锚定授权域名；纯 IP/CIDR 查询结果需人工映射回授权域名后方可入库。
# ============================================================================
set -euo pipefail

CONF="${FOFA_CONF:-$HOME/.config/fofa.conf}"
[ -f "$CONF" ] || CONF=/opt/silkspool/dsh/data/fofa.conf
[ -f "$CONF" ] || { echo "ERR: fofa.conf missing (~/.config/fofa.conf)" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${FOFA_EMAIL:?FOFA_EMAIL unset}" "${FOFA_KEY:?FOFA_KEY unset}"

DOM=""; QUERY=""; SIZE=100
FIELDS="host,ip,port,protocol,title,server"
while [ $# -gt 0 ]; do
  case "$1" in
    -d) DOM="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --fields) FIELDS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$QUERY" ]; then
  [ -n "$DOM" ] || { echo "ERR: -d <domain> or --query required" >&2; exit 2; }
  QUERY="domain=\"$DOM\""
fi

QB64=$(printf '%s' "$QUERY" | base64 -w0)
URL="https://fofa.info/api/v1/search/all?email=${FOFA_EMAIL}&key=${FOFA_KEY}&qbase64=${QB64}&size=${SIZE}&fields=${FIELDS}"

curl -s -m 30 "$URL" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d.get("error"):
    print("ERR: fofa api: %s" % d.get("errmsg", "unknown"), file=sys.stderr)
    sys.exit(3)
print("# query=%s size=%s" % (d.get("query"), d.get("size")))
for row in d.get("results", []):
    print("\t".join(str(x) for x in row) if isinstance(row, list) else str(row))
'
