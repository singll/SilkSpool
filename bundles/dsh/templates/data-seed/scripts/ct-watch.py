#!/usr/bin/env python3
# ==============================================================================
# ct-watch.py — 变化雷达·CT 新证书轮询监控（Cert Spotter API，subfinder 已验证可用源）
# 命中 scope 后缀的新域名写入 radar-queue.jsonl（新子域黄金窗口，优先测）
# 用法: ct-watch.py <program> <suffix1,suffix2,...> [--interval 300] [--once]
# 依赖: 纯标准库（公用的 calidog websocket 已验证不可用，故改为轮询设计）
# ==============================================================================
import sys, os, json, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

DATA = "/opt/silkspool/dsh/data/pipeline"
API = "https://api.certspotter.com/v1/issuances"

def now():
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%dT%H:%M:%S")

def fetch_domains(suffix, proxy=None, retries=2):
    """取最近签发证书中的域名（含子域展开），返回 set；429 退避重试"""
    q = urllib.parse.urlencode({
        "domain": suffix, "include_subdomains": "true",
        "expand": "dns_names", "match_wildcards": "true",
    })
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "silksec-ct-watch/1.0"})
    handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy}) if proxy else urllib.request.ProxyHandler({})
    op = urllib.request.build_opener(handler)
    for attempt in range(retries + 1):
        try:
            with op.open(req, timeout=30) as r:
                data = json.loads(r.read())
            break
        except Exception as e:
            if "429" in str(e) and attempt < retries:
                wait = 30 * (attempt + 1)
                print(f"[ct-watch] {suffix} 429 限流，{wait}s 后重试", flush=True)
                time.sleep(wait)
                continue
            print(f"[ct-watch] {suffix} API 失败: {e}", flush=True)
            return set()
    names = set()
    for cert in data:
        for n in cert.get("dns_names", []):
            names.add(n.lstrip("*.").lower())
    return names

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    program = sys.argv[1]
    suffixes = [s.strip().lstrip("*.") for s in sys.argv[2].split(",") if s.strip()]
    interval = 300
    once = "--once" in sys.argv
    proxy = None
    delay = 4  # 每个后缀之间的请求间隔（certspotter 免费层限流）
    if "--interval" in sys.argv:
        interval = int(sys.argv[sys.argv.index("--interval") + 1])
    if "--delay" in sys.argv:
        delay = int(sys.argv[sys.argv.index("--delay") + 1])
    if "--proxy" in sys.argv:
        proxy = sys.argv[sys.argv.index("--proxy") + 1]

    outdir = os.path.join(DATA, program)
    os.makedirs(outdir, exist_ok=True)
    radar = os.path.join(outdir, "radar-queue.jsonl")
    seen_p = os.path.join(outdir, "ct-seen.txt")
    seen = set()
    if os.path.isfile(seen_p):
        seen = {l.strip() for l in open(seen_p) if l.strip()}

    print(f"[ct-watch] {program} 轮询后缀 {suffixes} 间隔 {interval}s → {radar}", flush=True)
    first_round = True
    while True:
        new_total = 0
        for i, s in enumerate(suffixes):
            if i:
                time.sleep(delay)
            for d in fetch_domains(s, proxy):
                if d in seen:
                    continue
                seen.add(d)
                with open(seen_p, "a") as f:
                    f.write(d + "\n")
                if not first_round:  # 首轮只建基线，不灌队列
                    with open(radar, "a", encoding="utf-8") as f:
                        f.write(json.dumps({"ts": now(), "type": "ct-new-domain",
                                            "domain": d, "suffix": s}, ensure_ascii=False) + "\n")
                    print(f"[CT-NEW] {d}", flush=True)
                new_total += 1
        print(f"[ct-watch] {now()} 本轮新域名 {new_total}（基线池 {len(seen)}）", flush=True)
        first_round = False
        if once:
            return 0
        time.sleep(interval)

if __name__ == "__main__":
    sys.exit(main())
