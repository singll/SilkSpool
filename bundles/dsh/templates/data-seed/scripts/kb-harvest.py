#!/usr/bin/env python3
# ==============================================================================
# kb-harvest.py — 外部案例收割管道 MVP（P2-3，v4.7）
# 借鉴 Claude-BugHunter research/reports 管道：收割 → 覆盖缺口比对 → 起草草稿
# → 人工策展（knowledge-adopt 审批）→ 入库。铁律：绝不自动写入 rules/ 正式知识层。
#
# 输入（三选一或组合）：
#   1. --feed-url URL   远程 JSON 数组（每项 {title, url, severity?, cwe?}）
#                       ——可指向 H1 Hacktivity 导出/自建导出器/任何同构 feed
#   2. --inbox DIR      本地收件箱（默认 data/harvest/inbox/，放同构 .json 文件，
#                       一文件一数组；人工或上游脚本投递）
#   3. stdin            同构 JSON 数组
#
# 处理：
#   - 按 TAXONOMY（与 knowledge-coverage.py 同口径的手法族关键词表）给每条分配攻面
#   - 与 rules/cases/ 既有案例比对（同攻面已有 ≥1 案例的标记"已有先例"，否则"缺口"）
#   - 产出：
#       data/harvest/drafts/<ts>-<slug>.md   案例草稿（cases/ 格式骨架，字段留空待人工蒸馏）
#       data/harvest/candidates.json         候选清单（供 review 角色消费 → 提 knowledge-adopt 审批）
#       控制台摘要
#
# 草稿不含正文（正文必须人工蒸馏——版权与标识符红线见 rules/cases/ 既有文件头部纪律）。
# ==============================================================================
import json, sys, os, re, argparse, hashlib
from datetime import datetime, timezone

TAXONOMY = {
    "越权/IDOR": ["idor", "bola", "越权", "unauthorized access", "access control", "broken access"],
    "认证绕过": ["authentication bypass", "auth bypass", "登录绕过", "2fa", "otp bypass", "password reset"],
    "凭证泄露": ["credential", "api key", "secret", "token leak", "hardcoded", "泄露"],
    "文件/存储链": ["file upload", "storage", "s3", "bucket", "上传", "arbitrary file"],
    "SSRF": ["ssrf", "server-side request"],
    "注入": ["sqli", "sql injection", "注入", "nosql"],
    "XSS/RCE": ["xss", "cross-site scripting", "rce", "remote code execution", "命令执行"],
    "穿越/LFI": ["lfi", "path traversal", "directory traversal", "穿越", "file inclusion"],
    "业务逻辑": ["business logic", "logic flaw", "价格篡改", "race condition", "竞态", "price manipulation"],
    "缓存投毒": ["cache poisoning", "cache deception", "web cache"],
    "Host头": ["host header", "host header injection"],
    "原型污染": ["prototype pollution"],
    "Agent执行": ["prompt injection", "llm", "ai agent", "tool injection"],
    "云IDE/RCE": ["cloud ide", "code execution sandbox"],
    "CSRF/会话": ["csrf", "cross-site request", "session", "会话"],
    "OAuth/JWT": ["oauth", "jwt", "open redirect", "redirect_uri"],
    "GraphQL": ["graphql", "introspection"],
    "请求走私": ["request smuggling", "smuggling", "http/2", "h2c"],
    "反序列化": ["deserialization", "deserialisation", "rce via deserial"],
    "XXE": ["xxe", "xml external entity"],
    "WebSocket": ["websocket", "ws://", "cross-origin websocket"],
    "CRLF": ["crlf", "header injection"],
    "子域接管": ["subdomain takeover", "dangling dns", "cname"],
    "供应链": ["supply chain", "dependency confusion", "依赖混淆", "typosquatting"],
    "JNDI/EL注入": ["jndi", "log4j", "el injection", "expression language"],
}

SEVERITY_MAP = {"critical": "严重", "high": "高危", "medium": "中危", "low": "低危", "none": "待定"}


def classify(title):
    """按关键词把条目分到攻面；命中多个取首个（排序稳定）"""
    t = (title or "").lower()
    for cat, kws in TAXONOMY.items():
        if any(k in t for k in kws):
            return cat
    return None


def load_existing_cases(cases_dir):
    """读 rules/cases/ 既有案例的攻面分布（按文件名+首行标题分类）"""
    covered = {}
    if not os.path.isdir(cases_dir):
        return covered
    for f in sorted(os.listdir(cases_dir)):
        if not f.endswith(".md"):
            continue
        try:
            head = open(os.path.join(cases_dir, f), encoding="utf-8").read(1500)
        except OSError:
            continue
        title = head.split("\n", 1)[0]
        cat = classify(title) or classify(f)
        if cat:
            covered.setdefault(cat, []).append(f)
    return covered


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--feed-url", help="远程 JSON 数组 URL（title/url/severity/cwe 字段）")
    ap.add_argument("--inbox", default=None, help="本地收件箱目录（默认 data/harvest/inbox）")
    ap.add_argument("--cases-dir", default=None, help="既有案例目录（默认 <data>/rules/cases）")
    ap.add_argument("--out-root", default=None, help="产出根目录（默认 <data>/harvest）")
    ap.add_argument("--max", type=int, default=50, help="单轮最多起草 N 条（默认 50）")
    args = ap.parse_args()

    # 路径推断：SEC_DATA_DIR 环境变量 > 脚本相对约定
    data_dir = os.environ.get("SEC_DATA_DIR") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "data"
    )
    inbox = args.inbox or os.path.join(data_dir, "harvest", "inbox")
    cases_dir = args.cases_dir or os.path.join(data_dir, "rules", "cases")
    out_root = args.out_root or os.path.join(data_dir, "harvest")
    drafts_dir = os.path.join(out_root, "drafts")

    items = []
    # 1) 远程 feed（可选）
    if args.feed_url:
        import urllib.request
        try:
            with urllib.request.urlopen(args.feed_url, timeout=30) as r:
                feed = json.loads(r.read().decode("utf-8"))
            items.extend(feed if isinstance(feed, list) else feed.get("items", []))
        except Exception as e:  # noqa: BLE001 — feed 失败不阻断本地流程
            print(f"[kb-harvest] feed 拉取失败（继续处理 inbox）: {e}", file=sys.stderr)
    # 2) 本地 inbox
    if os.path.isdir(inbox):
        for f in sorted(os.listdir(inbox)):
            if not f.endswith(".json"):
                continue
            try:
                arr = json.loads(open(os.path.join(inbox, f), encoding="utf-8").read())
                items.extend(arr if isinstance(arr, list) else [arr])
            except (OSError, json.JSONDecodeError) as e:
                print(f"[kb-harvest] inbox 文件损坏跳过 {f}: {e}", file=sys.stderr)
    # 3) stdin
    if not sys.stdin.isatty():
        try:
            arr = json.loads(sys.stdin.read())
            items.extend(arr if isinstance(arr, list) else [arr])
        except json.JSONDecodeError:
            pass

    if not items:
        print("[kb-harvest] 无输入。用法：--feed-url / --inbox / stdin 提供同构 JSON。")
        return 0

    covered = load_existing_cases(cases_dir)
    seen_urls = set()
    candidates, drafts = [], []
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    for it in items:
        if len(candidates) >= args.max:
            break
        title = str(it.get("title", "")).strip()
        url = str(it.get("url", "")).strip()
        if not title or not url or url in seen_urls:
            continue
        if not re.match(r"^https?://", url):
            continue  # 来源 URL 必须像 URL——编造/空值直接丢
        seen_urls.add(url)
        cat = classify(title) or str(it.get("category", "")).strip() or None
        if not cat:
            continue  # 分类不出的留给人肉，不硬塞
        sev = SEVERITY_MAP.get(str(it.get("severity", "")).lower(), "待定")
        cwe = str(it.get("cwe", "")).strip()
        is_gap = cat not in covered
        candidates.append({
            "title": title, "url": url, "category": cat, "severity": sev,
            "cwe": cwe or None, "coverage": "缺口" if is_gap else "已有先例",
            "existing": covered.get(cat, []),
        })
        # 缺口类目起草草稿（骨架，正文留白待人工蒸馏）
        if is_gap:
            slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or hashlib.sha1(url.encode()).hexdigest()[:10]
            draft_path = os.path.join(drafts_dir, f"{ts}-{slug}.md")
            os.makedirs(drafts_dir, exist_ok=True)
            with open(draft_path, "w", encoding="utf-8") as f:
                f.write(f"""# 案例：<人工蒸馏：一句话场景>（{sev}）

> 来源: {url} · CWE: {cwe or "<人工补>"} · 首发年份: <人工补>
> 关联: <rules/techniques/<模块>.md> · VC 卡: <VC-0xx 或 无>
> 状态: DRAFT——本文件是收割管道自动生成的骨架，正文必须人工蒸馏后
> 走 knowledge-adopt 审批才能进 rules/cases/（禁止直接挪入）。

## 模式（什么形状的目标会有这洞）
<人工填写：2-4 句入口信号/架构特征>

## 打法（案例里实际打通的路径）
<人工填写：3-6 句，先做什么再做什么>

## 出什么算成
<一句话>

## 假点（什么样不算）
<1-3 句>

## 为什么值钱（severity 依据）
<1-2 句>
""")
            drafts.append(draft_path)

    # 候选清单（review 角色消费 → 提 knowledge-adopt）
    out = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "total_input": len(items),
        "candidates": candidates,
        "gap_categories": sorted({c["category"] for c in candidates if c["coverage"] == "缺口"}),
        "drafts": drafts,
        "note": "草稿与候选绝不自动入库；review 角色人工蒸馏后提 knowledge-adopt 审批。",
    }
    os.makedirs(out_root, exist_ok=True)
    cpath = os.path.join(out_root, "candidates.json")
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    gaps = out["gap_categories"]
    print(f"[kb-harvest] 输入 {len(items)} 条 → 候选 {len(candidates)}（缺口 {len(gaps)} 类）→ 草稿 {len(drafts)} 篇")
    if gaps:
        print(f"[kb-harvest] 覆盖缺口类目: {', '.join(gaps)}")
    print(f"[kb-harvest] 候选清单: {cpath}（review 角色消费，提 knowledge-adopt 审批）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
