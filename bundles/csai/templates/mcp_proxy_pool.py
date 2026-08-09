#!/usr/bin/env python3
"""
Proxy Pool MCP Server - 免费代理池管理（CyberStrikeAI 外部 MCP）

架构（spool bundle csai 统一部署）：
  csai-proxy-refresh.timer ──每30分钟──▶ proxy-scraper-checker（采集+验证，Rust）
                                        └─▶ proxy_grade.py（匿名度分级 → pool.json / live.txt）
  csai-proxy-rotator.service ──▶ mubeng 本地轮换网关 http://127.0.0.1:8899（-w 热加载 live.txt）

本 MCP 让大模型管理代理池：查看统计/队列、按条件取代理、上报失效代理、触发刷新。
两种用法：
  A. 轮换网关（推荐批量探测）：命令前加 http_proxy=http://127.0.0.1:8899 https_proxy=http://127.0.0.1:8899
     或 curl -x / sqlmap --proxy / nuclei -proxy 指向该地址，mubeng 每请求自动换 IP、失败自动剔除
  B. 单代理（需会话保持/指定地区）：proxy_pool_get 取一个，自行注入命令

依赖：pip install mcp（CyberStrikeAI venv 已含）
"""

from __future__ import annotations

import json
import random
import subprocess
import time
from pathlib import Path

from mcp.server.mcpserver import MCPServer

POOL_DIR = Path(__file__).resolve().parent
POOL_JSON = POOL_DIR / "pool.json"
LIVE_TXT = POOL_DIR / "live.txt"
BLOCKLIST = POOL_DIR / "blocklist.txt"
STATS_JSON = POOL_DIR / "stats.json"
STICKY_JSON = POOL_DIR / "sticky.json"

GATEWAY = "http://127.0.0.1:8899"
REFRESH_UNIT = "csai-proxy-refresh.service"
ROTATOR_UNIT = "csai-proxy-rotator.service"

app = MCPServer(
    "proxy-pool",
    instructions=(
        "免费代理池：防止探测时真实 IP 被封。"
        "批量 HTTP 探测优先用轮换网关（proxy_pool_gateway 查看用法）；"
        "需要固定出口/指定国家时用 proxy_pool_get 取单个代理；"
        "代理失效或被目标封禁时务必 proxy_pool_report_bad 上报；"
        "池子耗尽或太旧时调用 proxy_pool_refresh。"
    ),
)


def _load_pool() -> list[dict]:
    if not POOL_JSON.exists():
        return []
    try:
        return json.loads(POOL_JSON.read_text())
    except Exception:
        return []


def _load_live_urls() -> set[str]:
    if not LIVE_TXT.exists():
        return set()
    return {ln.strip() for ln in LIVE_TXT.read_text().splitlines() if ln.strip()}


def _proxy_url(e: dict) -> str:
    auth = ""
    if e.get("username"):
        auth = f"{e['username']}:{e.get('password') or ''}@"
    return f"{e.get('protocol', 'http')}://{auth}{e['host']}:{e['port']}"


def _systemctl(*args: str) -> str:
    try:
        out = subprocess.run(
            ["systemctl", *args], capture_output=True, text=True, timeout=15
        )
        return (out.stdout or out.stderr).strip()
    except Exception as exc:
        return f"error: {exc}"


def _meta(e: dict) -> dict:
    geo = e.get("geolocation") or {}
    country = (geo.get("country") or {}).get("iso_code")
    city = (geo.get("city") or {}).get("names", {}).get("en")
    return {
        "proxy": _proxy_url(e),
        "protocol": e.get("protocol"),
        "grade": e.get("grade"),
        "latency_ms": round((e.get("timeout") or 0) * 1000),
        "exit_ip": e.get("exit_ip"),
        "country": country,
        "city": city,
    }


@app.tool(
    description="查看代理池整体状态：总数、各协议/匿名度分布、可用队列规模、上次刷新时间、轮换网关运行状态。",
)
def proxy_pool_stats() -> str:
    stats = {}
    if STATS_JSON.exists():
        try:
            stats = json.loads(STATS_JSON.read_text())
        except Exception:
            pass
    refreshed_at = stats.get("refreshed_at")
    age_min = round((time.time() - refreshed_at) / 60, 1) if refreshed_at else None
    result = {
        **stats,
        "age_minutes": age_min,
        "live_txt_size": len(_load_live_urls()),
        "gateway": GATEWAY,
        "rotator_status": _systemctl("is-active", ROTATOR_UNIT),
        "refresh_timer": _systemctl("is-active", "csai-proxy-refresh.timer"),
    }
    return json.dumps(result, ensure_ascii=False, indent=1)


@app.tool(
    description="从可用队列取一个代理。可按 protocol(http/https/socks4/socks5)、max_latency_ms、country(ISO 两位码如 US) 过滤；"
    "传入 sticky_key 可在多次调用间复用同一出口（会话保持）。返回代理 URL 及元数据；注入方式："
    "http_proxy=<url> https_proxy=<url> <命令>，或工具自带 --proxy 参数。",
)
def proxy_pool_get(
    protocol: str | None = None,
    max_latency_ms: int | None = None,
    country: str | None = None,
    sticky_key: str | None = None,
) -> str:
    live = _load_live_urls()
    if not live:
        return json.dumps({"error": "可用队列为空，请先 proxy_pool_refresh", "gateway": GATEWAY}, ensure_ascii=False)

    if sticky_key and STICKY_JSON.exists():
        try:
            sticky = json.loads(STICKY_JSON.read_text())
            cached = sticky.get(sticky_key)
            if cached and cached.get("proxy") in live:
                return json.dumps({**cached, "sticky": True}, ensure_ascii=False)
        except Exception:
            pass

    candidates = []
    for e in _load_pool():
        url = _proxy_url(e)
        if url not in live:
            continue
        if protocol and e.get("protocol") != protocol:
            continue
        if max_latency_ms and (e.get("timeout") or 999) * 1000 > max_latency_ms:
            continue
        if country:
            cc = ((e.get("geolocation") or {}).get("country") or {}).get("iso_code", "")
            if cc.upper() != country.upper():
                continue
        candidates.append(e)

    if not candidates:
        return json.dumps({"error": "无符合过滤条件的代理", "live_total": len(live)}, ensure_ascii=False)

    # 在延迟最优的前 5 个里随机，兼顾速度与分散
    top = sorted(candidates, key=lambda e: e.get("timeout", 999))[:5]
    chosen = _meta(random.choice(top))

    if sticky_key:
        sticky = {}
        if STICKY_JSON.exists():
            try:
                sticky = json.loads(STICKY_JSON.read_text())
            except Exception:
                pass
        sticky[sticky_key] = chosen
        STICKY_JSON.write_text(json.dumps(sticky, ensure_ascii=False, indent=1))

    return json.dumps(chosen, ensure_ascii=False)


@app.tool(
    description="列出可用代理队列（按延迟升序）。可选 protocol / grade(elite|anonymous|socks) 过滤，limit 默认 20。",
)
def proxy_pool_list(protocol: str | None = None, grade: str | None = None, limit: int = 20) -> str:
    live = _load_live_urls()
    items = []
    for e in _load_pool():
        url = _proxy_url(e)
        if url not in live:
            continue
        if protocol and e.get("protocol") != protocol:
            continue
        if grade and e.get("grade") != grade:
            continue
        items.append(_meta(e))
        if len(items) >= max(1, min(limit, 100)):
            break
    return json.dumps({"total_live": len(live), "items": items}, ensure_ascii=False, indent=1)


@app.tool(
    description="上报失效/被目标封禁的代理：加入 blocklist 并从轮换队列移除（mubeng 热加载自动生效）。"
    "proxy 形如 http://1.2.3.4:8080 或 1.2.3.4:8080；reason 可选，如 timeout / banned_403 / captcha。",
)
def proxy_pool_report_bad(proxy: str, reason: str = "") -> str:
    raw = proxy.strip()
    hostport = raw.split("://")[-1].split("@")[-1].strip().strip("/")
    if not hostport or ":" not in hostport:
        return json.dumps({"error": f"无法解析代理地址: {proxy}"}, ensure_ascii=False)

    existing = set()
    if BLOCKLIST.exists():
        existing = {ln.strip() for ln in BLOCKLIST.read_text().splitlines() if ln.strip()}
    note = f"{hostport}  # {reason} {int(time.time())}" if reason else hostport
    if hostport not in existing:
        with BLOCKLIST.open("a") as f:
            f.write(note + "\n")

    removed = False
    if LIVE_TXT.exists():
        lines = [ln for ln in LIVE_TXT.read_text().splitlines() if ln.strip()]
        kept = [ln for ln in lines if hostport not in ln]
        removed = len(kept) != len(lines)
        if removed:
            tmp = LIVE_TXT.with_suffix(".tmp")
            tmp.write_text("\n".join(kept) + ("\n" if kept else ""))
            tmp.replace(LIVE_TXT)

    return json.dumps(
        {"blocked": hostport, "removed_from_live": removed, "live_remaining": len(_load_live_urls())},
        ensure_ascii=False,
    )


@app.tool(
    description="触发一次代理池刷新（后台执行：重新采集免费代理→验证存活→匿名度分级→更新轮换队列，约需 5-15 分钟）。"
    "当池子耗尽、队列过旧或大量代理失效时调用。",
)
def proxy_pool_refresh() -> str:
    active = _systemctl("is-active", REFRESH_UNIT)
    if active == "activating":
        return json.dumps({"status": "already_running"}, ensure_ascii=False)
    out = _systemctl("start", "--no-block", REFRESH_UNIT)
    return json.dumps(
        {"status": "started", "detail": out or "refresh 已在后台运行，数分钟后 proxy_pool_stats 查看新队列"},
        ensure_ascii=False,
    )


@app.tool(
    description="查看本地轮换网关用法。网关每请求自动更换出口 IP、失败自动轮换/剔除，是批量探测防封的首选方式。",
)
def proxy_pool_gateway() -> str:
    return json.dumps(
        {
            "gateway": GATEWAY,
            "rotator_status": _systemctl("is-active", ROTATOR_UNIT),
            "usage": {
                "env前缀（通用）": f"http_proxy={GATEWAY} https_proxy={GATEWAY} <命令>",
                "curl": f"curl -x {GATEWAY} <url>",
                "sqlmap": f"sqlmap -u <url> --proxy={GATEWAY}",
                "nuclei": f"nuclei -u <url> -proxy {GATEWAY}",
                "httpx/ffuf": f"httpx -http-proxy {GATEWAY} / ffuf -x {GATEWAY}",
                "nmap(仅HTTP代理探测)": "经网关取单代理后: nmap -sT --proxies <proxy_url> <target>",
            },
            "notes": [
                "轮换网关仅代理 HTTP/HTTPS 流量；SOCKS 需求请用 proxy_pool_get 取 socks5 代理自行注入",
                "经代理的流量绝不携带任何真实凭证/Cookie/Token（免费代理可被运营者嗅探）",
                "nmap 经代理只能用 -sT 全连接扫描，无 SYN/UDP",
            ],
        },
        ensure_ascii=False,
        indent=1,
    )


if __name__ == "__main__":
    app.run(transport="stdio")
