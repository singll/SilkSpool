#!/usr/bin/env bash
# ==============================================================================
# l2-collect.sh — L2 接口层收集（katana + waybackurls + gau → endpoints.tsv）
# 用法: l2-collect.sh <program> <host|hosts-file> [--proxy http://127.0.0.1:8899]
# 纪律: 单批 ≤3 目标（调用方控制）；katana 单目标 timeout 120s
# ==============================================================================
set -uo pipefail

PROGRAM="$1"; TARGET="$2"; PROXY="${4:-http://127.0.0.1:8899}"
[ "${3:-}" = "--proxy" ] || PROXY="http://127.0.0.1:8899"
DATA="/opt/silkspool/dsh/data/pipeline/$PROGRAM"
mkdir -p "$DATA"
ENDPOINTS="$DATA/endpoints-$PROGRAM.tsv"
[ -f "$ENDPOINTS" ] || printf 'url\tmethod\tparams\tauth_required\tsource\tcollected_at\n' > "$ENDPOINTS"

NOW="$(date +%Y-%m-%dT%H:%M:%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

collect_one() {
    local host="$1"
    # katana 主动爬（走代理，深度 2，表单/XHR 提取）
    timeout 120 katana -u "https://$host" -d 2 -proxy "$PROXY" -silent 2>/dev/null \
        | sed 's/$/\tkatana/' >> "$TMP/urls.tsv"
    # waybackurls / gau 历史 URL（只查归档源，无需代理）
    timeout 60 bash -c "echo '$host' | waybackurls" 2>/dev/null | sed 's/$/\twaybackurls/' >> "$TMP/urls.tsv"
    timeout 60 bash -c "echo '$host' | gau --threads 2" 2>/dev/null | sed 's/$/\tgau/' >> "$TMP/urls.tsv"
}

if [ -f "$TARGET" ]; then
    while read -r h; do [ -n "$h" ] && collect_one "$h"; done < "$TARGET"
else
    collect_one "$TARGET"
fi

# 归一化：去静态资源/去重，提取参数名，输出 endpoints 行
python3 - "$TMP/urls.tsv" "$ENDPOINTS" "$NOW" <<'PYEOF'
import sys, re
from urllib.parse import urlparse, parse_qsl

inp, endpoints, now = sys.argv[1], sys.argv[2], sys.argv[3]
STATIC = re.compile(r'\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|mp4|webp)(\?|$)', re.I)
seen = set()
existing = set()
try:
    with open(endpoints, encoding="utf-8") as f:
        next(f, None)
        for line in f:
            existing.add(line.split("\t", 1)[0])
except FileNotFoundError:
    pass

out = []
with open(inp, encoding="utf-8", errors="replace") as f:
    for line in f:
        parts = line.rstrip("\n").rsplit("\t", 1)
        if len(parts) != 2:
            continue
        url, src = parts
        url = url.strip()
        if not url.startswith("http") or STATIC.search(url) or url in seen or url in existing:
            continue
        seen.add(url)
        try:
            q = urlparse(url)
            params = ",".join(sorted({k for k, _ in parse_qsl(q.query)}))
        except Exception:
            continue
        out.append(f"{url}\tGET\t{params}\tunknown\t{src}\t{now}")

with open(endpoints, "a", encoding="utf-8") as f:
    f.write("\n".join(out) + ("\n" if out else ""))
print(f"[l2-collect] 新增 {len(out)} 端点（去重后）→ {endpoints}")
PYEOF
