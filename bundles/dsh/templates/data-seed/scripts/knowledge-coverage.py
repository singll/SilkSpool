#!/usr/bin/env python3
# ==============================================================================
# knowledge-coverage.py — 知识覆盖度审计（攻面 × rules/VC 卡交叉表）
# 借鉴 Claude-Red MINDMAP：内置攻面分类表（TAXONOMY）逐条对照静态先验 rules/
# 与 vulncards/VC-*.yaml——交叉表空行即覆盖缺口，先验层缺哪块手法一目了然。
# 用法: knowledge-coverage.py [--rules-dir DIR] [--vulncards-dir DIR] [--out JSON]
#   --rules-dir     静态先验目录（techniques/web/php/cases/…，递归扫 *.md）
#   --vulncards-dir VC 卡目录（VC-*.yaml；找不到则全部置空并在输出注明）
#   --out           结果 JSON 路径（默认 <rules 上级>/knowledge-coverage.json）
# 默认路径按 SEC_DATA_DIR / 脚本落点推断：模板 data-seed/scripts/ 与部署后
# <BASE>/scripts/pipeline/ 两种位置都兼容。stdlib only；幂等可重跑。
# 匹配规则：文件名命中关键词=强匹配；正文累计命中 ≥2 次=弱匹配（防索引/顺带
# 提及造成假覆盖）。ASCII 关键词带边界（"oss" 不命中 "across"）。
# ==============================================================================
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

TZ = timezone(timedelta(hours=8))

# ── 攻面分类表：每条 (id, 中文名, 关键词列表) ─────────────────────────────────
# 前段 = secagent 手法族词汇表（15）；后段 = 补充常见 Web 攻面（21）。
TAXONOMY = [
    # ---- secagent 手法族（15）----
    ("idor", "越权 / IDOR", ["idor", "越权", "水平越权", "垂直越权", "authz_diff", "bola"]),
    ("auth-bypass", "认证绕过 / 未授权访问", ["authbypass", "认证绕过", "鉴权绕过", "未授权", "unauthorized", "auth bypass", "401 bypass", "403 bypass"]),
    ("cred-leak", "凭证泄露", ["凭证泄露", "凭据泄露", "密钥泄露", "api key", "apikey", "api-key", "access key", "accesskey", "ak/sk", "secretkey", "sourcemap", "source map", "js 密钥"]),
    ("file-chain", "文件 / 存储链", ["文件上传", "file upload", "对象存储", "云存储", "存储桶", "oss", "cos 桶", "s3", "storage bucket", "bucket"]),
    ("ssrf", "SSRF", ["ssrf", "server-side request"]),
    ("injection", "注入（SQL / 命令）", ["sqli", "sql注入", "sql 注入", "命令注入", "command injection", "os command", "injection-test"]),
    ("xss-rce", "XSS / RCE", ["xss", "rce", "远程代码执行", "反射型", "存储型"]),
    ("traversal-lfi", "穿越 / LFI", ["lfi", "rfi", "目录穿越", "路径穿越", "path traversal", "file inclusion", "文件包含", "任意文件读取"]),
    ("biz-logic", "业务逻辑", ["业务逻辑", "逻辑漏洞", "逻辑缺陷", "biz-logic", "logic-test", "支付逻辑", "薅羊毛"]),
    ("cache-poisoning", "缓存投毒 / 缓存欺骗", ["缓存投毒", "缓存欺骗", "cache poisoning", "cache deception", "web cache"]),
    ("host-header", "Host 头攻击", ["host header", "host头", "host 头", "host-header"]),
    ("proto-pollution", "原型污染", ["原型污染", "prototype pollution", "__proto__", "原型链污染"]),
    # 注：不放 "mcp"——rules 正文大量提 js-reverse MCP 是工具引用而非攻面，纯噪声
    ("agent-exec", "Agent 执行", ["agent-tool-exec", "agent tool", "agent执行", "agent 执行", "对话口工具", "工具真执行", "code_interpreter"]),
    ("cloud-ide-rce", "云 IDE / RCE 链", ["cloud ide", "cloud-ide", "云ide", "云 ide", "ide rce", "codex rce"]),
    ("csrf-session", "CSRF / 会话", ["csrf", "会话固定", "session fixation", "会话劫持", "session 劫持", "会话令牌"]),
    # ---- 补充常见 Web 攻面（21）----
    ("deserialization", "反序列化", ["反序列化", "deserialization", "unserialize", "gadget 链", "gadget链"]),
    ("graphql", "GraphQL", ["graphql"]),
    ("oauth-jwt", "OAuth / JWT", ["oauth", "jwt", "oidc", "none algorithm", "token 伪造", "jwt 伪造", "算法混淆"]),
    ("race-condition", "竞态条件", ["竞态", "条件竞争", "race condition", "race-condition", "toc-tou"]),
    ("request-smuggling", "请求走私", ["走私", "smuggling", "desync", "cl.te", "te.cl"]),
    ("open-redirect", "开放重定向", ["open redirect", "open-redirect", "开放重定向", "任意跳转", "url 跳转"]),
    ("subdomain-takeover", "子域接管", ["子域接管", "子域名接管", "subdomain takeover", "dangling cname", "dangling dns"]),
    ("xxe", "XXE", ["xxe", "外部实体", "external entity"]),
    ("websocket", "WebSocket", ["websocket"]),
    ("crlf", "CRLF 注入", ["crlf", "响应头注入"]),
    ("csp-bypass", "CSP 绕过", ["csp", "content-security-policy", "content security policy"]),
    ("cors", "CORS", ["cors", "跨域资源共享", "任意起源反射"]),
    ("clickjacking", "点击劫持", ["点击劫持", "clickjacking", "x-frame-options", "frame busting"]),
    ("hpp", "HPP 参数污染", ["hpp", "参数污染", "parameter pollution"]),
    ("type-confusion", "类型混淆", ["类型混淆", "类型戏法", "type juggling", "type-juggling", "松散比较", "ghost bits", "ghost-bits"]),
    ("supply-chain", "依赖混淆 / 供应链", ["依赖混淆", "依赖投毒", "dependency confusion", "供应链", "supply chain", "typosquatting", "insecure scm"]),
    ("jndi-el", "JNDI / EL 注入", ["jndi", "el注入", "el 注入", "el injection", "log4j", "spel", "表达式注入"]),
    ("xslt", "XSLT 注入", ["xslt"]),
    ("dns-rebinding", "DNS rebinding", ["dns rebinding", "dns-rebinding", "rebinding"]),
    ("llm-security", "LLM 安全", ["llm", "大模型安全", "prompt injection", "提示词注入", "提示注入"]),
    ("waf-bypass", "WAF 绕过", ["waf 绕过", "waf bypass", "waf-bypass", "绕waf", "绕 waf"]),
]

# ── 关键词匹配：ASCII 词带字符边界；含中文的词用子串 ──────────────────────────
def _kw_is_ascii(kw):
    return all(ord(c) < 128 for c in kw)

def _kw_regex(kw):
    if not _kw_is_ascii(kw):
        return None
    return re.compile(r"(?<![0-9A-Za-z_])" + re.escape(kw) + r"(?![0-9A-Za-z_])", re.IGNORECASE)

def kw_in_name(name, kw):
    r = _kw_regex(kw)
    return bool(r.search(name)) if r else (kw in name)

def kw_hits(text, kw):
    r = _kw_regex(kw)
    if r is None:
        return text.count(kw)
    return len(r.findall(text))

def match_files(files, keywords, content_min_hits):
    """files: [(rel, 文件名, 正文)] → 命中文件 rel 列表（文件名强匹配 / 正文累计阈值）"""
    hits = []
    for rel, name, text in files:
        if any(kw_in_name(name, k) for k in keywords):
            hits.append(rel)
            continue
        if sum(kw_hits(text, k) for k in keywords) >= content_min_hits:
            hits.append(rel)
    return sorted(hits)

# ── 目录扫描 ──────────────────────────────────────────────────────────────────
def scan_rules(rules_dir):
    """递归收集 *.md → [(相对路径, 文件名小写, 正文)]；目录缺失返回 ([], False)"""
    if not rules_dir.is_dir():
        return [], False
    out = []
    for p in sorted(rules_dir.rglob("*.md")):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        out.append((p.relative_to(rules_dir).as_posix(), p.name.lower(), text))
    return out, True

def scan_cards(vc_dir):
    """收集 VC-*.yaml → [(VC id, 文件名小写, 卡名, 正文)]；目录缺失返回 ([], False)"""
    if not vc_dir.is_dir():
        return [], False
    out = []
    for p in sorted(vc_dir.rglob("VC-*.yaml")):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = re.match(r"(VC-\d+)", p.name)
        if not m:
            continue
        nm = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
        out.append((m.group(1), p.name.lower(), (nm.group(1).strip() if nm else ""), text))
    return out, True

# ── 默认路径推断（模板 / 部署两种落点）───────────────────────────────────────
def _candidate_roots():
    here = Path(__file__).resolve().parent
    roots = []
    env = os.environ.get("SEC_DATA_DIR")
    if env:
        roots.append(Path(env))
    roots.append(here.parent.parent / "data")   # <BASE>/scripts/pipeline/ → <BASE>/data
    roots.append(here.parent)                   # data-seed/scripts/ → data-seed（模板）
    roots.append(Path("/opt/silkspool/dsh/data"))
    return roots

def default_dir(sub):
    for r in _candidate_roots():
        d = r / sub
        if d.is_dir():
            return d
    return _candidate_roots()[0] / sub  # 都没有：给首个候选，调用方按“未找到”处理

# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="知识覆盖度审计：攻面 × rules/VC 卡交叉表")
    ap.add_argument("--rules-dir", help="静态先验目录（递归 *.md，默认按 SEC_DATA_DIR/脚本落点推断）")
    ap.add_argument("--vulncards-dir", help="VC 卡目录（VC-*.yaml）")
    ap.add_argument("--out", help="结果 JSON 输出路径（默认 <rules 上级>/knowledge-coverage.json）")
    args = ap.parse_args()

    rules_dir = Path(args.rules_dir) if args.rules_dir else default_dir("rules")
    vc_dir = Path(args.vulncards_dir) if args.vulncards_dir else default_dir("vulncards")
    out = Path(args.out) if args.out else rules_dir.parent / "knowledge-coverage.json"

    rule_files, rules_found = scan_rules(rules_dir)
    if not rules_found:
        print(f"错误: rules 目录不存在: {rules_dir}", file=sys.stderr)
        return 2
    card_files, vc_found = scan_cards(vc_dir)

    now = datetime.now(TZ)
    taxonomy = []
    for tid, name, keywords in TAXONOMY:
        rules_hits = match_files(rule_files, keywords, content_min_hits=2)
        card_hits = sorted({cid for cid, fname, cname, text in card_files
                            if any(kw_in_name(fname, k) or kw_hits(text, k) >= 1 for k in keywords)})
        taxonomy.append({
            "id": tid,
            "name": name,
            "keywords": keywords,
            "covered_by_rules": rules_hits,
            "covered_by_cards": card_hits,
            "gap": not rules_hits and not card_hits,
        })

    gaps = [{"id": t["id"], "name": t["name"]} for t in taxonomy if t["gap"]]
    no_card = [{"id": t["id"], "name": t["name"]} for t in taxonomy
               if t["covered_by_rules"] and not t["covered_by_cards"]]
    covered_rules = sum(1 for t in taxonomy if t["covered_by_rules"])
    covered_cards = sum(1 for t in taxonomy if t["covered_by_cards"])
    total = len(taxonomy)

    result = {
        "generated_at": now.isoformat(timespec="seconds"),
        "rules_dir": str(rules_dir),
        "rules_found": rules_found,
        "rules_files": len(rule_files),
        "vulncards_dir": str(vc_dir),
        "vulncards_found": vc_found,
        "cards_files": len(card_files),
        "vulncards_note": "" if vc_found else f"vulncards 目录未找到（{vc_dir}），VC 卡覆盖全部置空——部署后位于数据目录 vulncards/",
        "taxonomy": taxonomy,
        "summary": {
            "total": total,
            "covered_rules": covered_rules,
            "covered_cards": covered_cards,
            "coverage_pct": round(covered_rules * 100.0 / total, 1) if total else 0.0,
            "gap_count": len(gaps),
            "gaps": gaps,
            "rules_without_cards": no_card,
        },
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # 控制台人类可读摘要
    print(f"知识覆盖度审计 — {now.strftime('%Y-%m-%d %H:%M %z')}")
    print(f"rules: {rules_dir}（{len(rule_files)} 篇） | vulncards: {vc_dir}"
          f"（{'未找到，VC 覆盖置空' if not vc_found else str(len(card_files)) + ' 张'}）")
    print(f"覆盖: {covered_rules}/{total} 攻面有规则覆盖（{result['summary']['coverage_pct']}%）"
          f" | {covered_cards}/{total} 有 VC 卡")
    print(f"缺口（无规则无卡片）: {len(gaps)}")
    for g in gaps:
        print(f"  - {g['name']}（{g['id']}）")
    print(f"有规则无 VC 卡: {len(no_card)}")
    for g in no_card:
        print(f"  - {g['name']}（{g['id']}）")
    print(f"已写入 {out}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
