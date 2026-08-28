#!/usr/bin/env bash
# ==============================================================================
# vault-export-build.sh — 构建 Obsidian vault 导出包（csai 侧，cron 每 30min）
# 产出 /opt/silkspool/dsh/data/vault-export/SilkSecAgent/：
#   卡片库/（vulncards YAML→md 渲染）  报告/ 覆盖视图/ 交接/
# 由 operator 侧 vault-sync.sh 拉取并中继到 keeper 的 vault。
# ==============================================================================
set -uo pipefail

DATA=/opt/silkspool/dsh/data
OUT=$DATA/vault-export/SilkSecAgent
mkdir -p "$OUT/卡片库/vuln" "$OUT/卡片库/ideas" "$OUT/报告" "$OUT/覆盖视图" "$OUT/交接"

# 1. 漏洞卡 YAML → md（人读友好；保留 YAML 原文以便精确复制）
python3 - "$DATA/vulncards" "$OUT/卡片库" <<'PYEOF'
import os, sys, glob
src, dst = sys.argv[1], sys.argv[2]
count = 0
for f in glob.glob(os.path.join(src, "*.yaml")):
    name = os.path.splitext(os.path.basename(f))[0]
    body = open(f, encoding="utf-8").read()
    title = name
    for line in body.splitlines():
        if line.startswith("name:"):
            title = line.split(":", 1)[1].strip()
            break
    sub = "ideas" if "ideas" in f else "vuln"
    out = os.path.join(dst, sub, f"{name}.md")
    content = f"# {name}｜{title}\n\n> 机器同步自 csai data/vulncards/（勿手改，改动请回源）\n\n```yaml\n{body}```\n"
    if not os.path.exists(out) or open(out, encoding="utf-8").read() != content:
        open(out, "w", encoding="utf-8").write(content)
        count += 1
# ideas 目录（本身已是 yaml，同法渲染）
for f in glob.glob(os.path.join(src, "ideas", "*.yaml")):
    name = os.path.splitext(os.path.basename(f))[0]
    body = open(f, encoding="utf-8").read()
    out = os.path.join(dst, "ideas", f"{name}.md")
    content = f"# {name}\n\n> 机器同步自 csai data/vulncards/ideas/\n\n```yaml\n{body}```\n"
    if not os.path.exists(out) or open(out, encoding="utf-8").read() != content:
        open(out, "w", encoding="utf-8").write(content)
        count += 1
print(f"[vault-export] 卡片渲染 {count} 个更新")
PYEOF

# 2. 报告/覆盖视图/交接（原始 md 直拷，保留目录结构）
for prog in meituan-src bytedance; do
    mkdir -p "$OUT/报告/$prog" "$OUT/覆盖视图/$prog" "$OUT/交接/$prog"
    [ -d "$DATA/reports/$prog" ] && cp -u "$DATA/reports/$prog"/*.md "$OUT/报告/$prog/" 2>/dev/null
    pdir="$DATA/pipeline/$prog"
    [ -f "$pdir/coverage-latest.md" ] && cp -u "$pdir/coverage-latest.md" "$OUT/覆盖视图/$prog/"
    for h in "$pdir"/handoff-*.md; do
        [ -f "$h" ] && cp -u "$h" "$OUT/交接/$prog/" 2>/dev/null
    done
done

echo "[vault-export] 构建完成：$OUT"
