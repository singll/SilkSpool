#!/usr/bin/env python3
"""
proxy_grade.py - csai 代理池匿名度分级与队列生成

在 proxy-scraper-checker 完成采集验证后运行（csai-proxy-refresh.service 的 ExecStartPost）：
  1. 读取 out/proxies.json（已验证存活，含延迟/出口IP/地理位置）
  2. 对 HTTP(S) 代理做匿名度分级（transparent 会经 X-Forwarded-For 等头泄露真实 IP，必须剔除）
     - SOCKS4/5 代理不修改 HTTP 头，天然匿名，直接保留
  3. 应用 blocklist.txt（LLM 通过 MCP 上报的失效/被封代理）
  4. 产出：
     - pool.json  全量 enriched 池（含 grade 字段），按延迟升序
     - live.txt   mubeng 轮换网关使用的可用队列（elite/anonymous 的 http + 全部 socks，限速靠前 N 条）
     - stats.json 统计信息（供 MCP proxy_pool_stats 读取）

仅依赖 Python 标准库（3.10+）。
"""

from __future__ import annotations

import json
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

POOL_DIR = Path(__file__).resolve().parent
OUT_JSON = POOL_DIR / "out" / "proxies.json"
POOL_JSON = POOL_DIR / "pool.json"
LIVE_TXT = POOL_DIR / "live.txt"
BLOCKLIST = POOL_DIR / "blocklist.txt"
STATS_JSON = POOL_DIR / "stats.json"

GRADE_WORKERS = 64
GRADE_TIMEOUT = 8.0
# 只对延迟最优的前 N 个 HTTP 代理做匿名度探测，控制运行时长
HTTP_GRADE_LIMIT = 600
# live.txt 队列上限（mubeng 池规模）
LIVE_LIMIT = 400

REAL_IP_URLS = [
    "https://api.ipify.org",
    "https://ipv4.icanhazip.com",
    "https://ifconfig.me/ip",
]
ECHO_URLS = [
    "https://httpbin.org/headers",
    "https://httpbingo.org/headers",
    "https://postman-echo.com/headers",
]
# 出现即视为"代理注入头"（不含真实 IP 时为 anonymous，含真实 IP 为 transparent）
PROXY_HEADERS = (
    "x-forwarded-for", "x-real-ip", "forwarded", "via",
    "client-ip", "x-client-ip", "x-proxy-id", "proxy-connection",
)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")


def log(msg: str) -> None:
    print(f"[proxy_grade] {msg}", flush=True)


def fetch_direct(url: str, timeout: float = 8.0) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.read(4096).decode("utf-8", "replace")
    except Exception:
        return None


def detect_real_ip() -> str | None:
    for url in REAL_IP_URLS:
        body = fetch_direct(url)
        if body:
            candidate = body.strip().split()[0] if body.strip() else ""
            parts = candidate.split(".")
            if len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
                return candidate
    return None


def grade_http_proxy(proxy_url: str, real_ip: str | None) -> str:
    """elite / anonymous / transparent / unknown"""
    for echo in ECHO_URLS:
        try:
            handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
            opener = urllib.request.build_opener(handler)
            req = urllib.request.Request(echo, headers={"User-Agent": UA})
            with opener.open(req, timeout=GRADE_TIMEOUT) as resp:
                body = resp.read(8192).decode("utf-8", "replace")
            if real_ip and real_ip in body:
                return "transparent"
            lowered = body.lower()
            try:
                headers = json.loads(body).get("headers", {})
                lowered = json.dumps(headers).lower()
            except Exception:
                pass
            if any(h in lowered for h in PROXY_HEADERS):
                return "anonymous"
            return "elite"
        except Exception:
            continue
    return "unknown"


def proxy_url_of(entry: dict) -> str:
    scheme = entry.get("protocol", "http")
    auth = ""
    if entry.get("username"):
        auth = f"{entry['username']}:{entry.get('password') or ''}@"
    return f"{scheme}://{auth}{entry['host']}:{entry['port']}"


def main() -> int:
    if not OUT_JSON.exists():
        log(f"未找到 {OUT_JSON}，跳过")
        return 0

    entries = json.loads(OUT_JSON.read_text())
    log(f"载入已验证代理 {len(entries)} 条")

    blocked = set()
    if BLOCKLIST.exists():
        blocked = {ln.strip() for ln in BLOCKLIST.read_text().splitlines() if ln.strip() and not ln.startswith("#")}
    before = len(entries)
    entries = [e for e in entries if f"{e['host']}:{e['port']}" not in blocked]
    if before != len(entries):
        log(f"blocklist 剔除 {before - len(entries)} 条")

    real_ip = detect_real_ip()
    log(f"本机真实出口 IP: {real_ip or '探测失败'}")
    if not real_ip:
        log("[WARN] 真实 IP 探测失败：HTTP 代理全部标记 unknown（不进入 live.txt），仅保留 SOCKS")

    http_entries = [e for e in entries if e.get("protocol") in ("http", "https")]
    socks_entries = [e for e in entries if e.get("protocol") in ("socks4", "socks5")]

    for e in socks_entries:
        e["grade"] = "socks"  # SOCKS 不触碰 HTTP 头，天然不泄露真实 IP

    to_grade = sorted(http_entries, key=lambda e: e.get("timeout", 999))[:HTTP_GRADE_LIMIT] if real_ip else []
    graded_urls: set[str] = set()
    if to_grade:
        log(f"对 {len(to_grade)} 个 HTTP(S) 代理做匿名度分级（并发 {GRADE_WORKERS}）")
        t0 = time.monotonic()
        with ThreadPoolExecutor(max_workers=GRADE_WORKERS) as pool:
            futures = {pool.submit(grade_http_proxy, proxy_url_of(e), real_ip): e for e in to_grade}
            for fut in as_completed(futures):
                e = futures[fut]
                e["grade"] = fut.result()
                graded_urls.add(proxy_url_of(e))
        log(f"分级完成，耗时 {time.monotonic() - t0:.0f}s")

    for e in http_entries:
        if proxy_url_of(e) not in graded_urls:
            e["grade"] = "unknown"

    entries.sort(key=lambda e: e.get("timeout", 999))
    POOL_JSON.write_text(json.dumps(entries, ensure_ascii=False, indent=1))

    usable = [e for e in entries if e["grade"] in ("elite", "anonymous", "socks")][:LIVE_LIMIT]
    live_lines = [proxy_url_of(e) for e in usable]
    tmp = LIVE_TXT.with_suffix(".tmp")
    tmp.write_text("\n".join(live_lines) + ("\n" if live_lines else ""))
    tmp.replace(LIVE_TXT)  # 原子替换，配合 mubeng -w 热加载

    by_grade: dict[str, int] = {}
    for e in entries:
        by_grade[e["grade"]] = by_grade.get(e["grade"], 0) + 1
    stats = {
        "refreshed_at": int(time.time()),
        "real_ip": real_ip,
        "total_validated": len(entries),
        "live_pool": len(usable),
        "by_grade": by_grade,
        "by_protocol": {
            p: sum(1 for e in entries if e.get("protocol") == p)
            for p in ("http", "https", "socks4", "socks5")
        },
    }
    STATS_JSON.write_text(json.dumps(stats, ensure_ascii=False, indent=1))
    log(f"完成: 池 {len(entries)}，可用队列 {len(usable)}，分级分布 {by_grade}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
