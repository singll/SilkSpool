#!/usr/bin/env python3
# ==============================================================================
# verify-replay.py — 机械复核：重放证据包请求并比对响应（防幻觉标准 9）
# 用法: verify-replay.py <evidence_dir> [--proxy http://127.0.0.1:8899] [--expect-hash <sha256>]
# 规则: request.txt 为原始 HTTP 报文（首行 METHOD PATH HTTP/1.1 + Host 头）；
#       重放后把响应体 sha256 与 verify-log.md 追加记录；--expect-hash 一致才算 PASS。
#       本脚本不含任何 LLM 调用——LLM 不能给自己当法官。
# ==============================================================================
import hashlib, http.client, ssl, sys, os, re
from datetime import datetime, timezone, timedelta

def parse_request(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    head, _, body = raw.partition("\r\n\r\n")
    if not body:
        head, _, body = raw.partition("\n\n")
    lines = head.replace("\r\n", "\n").split("\n")
    m = re.match(r"^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)", lines[0])
    if not m:
        raise ValueError("request.txt 首行无法解析")
    method, pathq = m.group(1), m.group(2)
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip()] = v.strip()
    if "Host" not in headers and "host" not in {k.lower() for k in headers}:
        raise ValueError("request.txt 缺 Host 头")
    host = headers.get("Host") or headers.get("host")
    return method, pathq, host, headers, body

def replay(method, pathq, host, headers, body, proxy=None, timeout=15):
    # 简单直连实现；proxy 形式为 http://host:port（CONNECT 隧道）
    port = 443
    use_tls = True
    if proxy:
        ph, pp = proxy.replace("http://", "").split(":")[:2]
        conn = http.client.HTTPSConnection(ph, int(pp), timeout=timeout,
                                           context=ssl.create_default_context())
        conn.set_tunnel(host, port)
    else:
        conn = http.client.HTTPSConnection(host, port, timeout=timeout,
                                           context=ssl.create_default_context())
    hdrs = {k: v for k, v in headers.items() if k.lower() not in ("content-length", "connection", "accept-encoding")}
    hdrs["Accept-Encoding"] = "identity"
    conn.request(method, pathq, body=body or None, headers=hdrs)
    resp = conn.getresponse()
    data = resp.read()
    code = resp.status
    conn.close()
    return code, data

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    evdir = args[0]
    proxy = None
    expect = None
    if "--proxy" in args:
        proxy = args[args.index("--proxy") + 1]
    if "--expect-hash" in args:
        expect = args[args.index("--expect-hash") + 1]

    req_path = os.path.join(evdir, "request.txt")
    if not os.path.isfile(req_path):
        print(f"✗ {req_path} 不存在")
        return 1
    try:
        method, pathq, host, headers, body = parse_request(req_path)
    except ValueError as e:
        print(f"✗ 解析失败: {e}")
        return 1

    try:
        code, data = replay(method, pathq, host, headers, body, proxy=proxy)
    except Exception as e:
        print(f"✗ 重放失败: {e}")
        return 1

    h = hashlib.sha256(data).hexdigest()
    now = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M %z")
    verdict = "REPLAYED"
    if expect:
        verdict = "PASS" if h == expect else "FAIL(hash 不一致)"

    log_path = os.path.join(evdir, "verify-log.md")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"| {now} | {proxy or 'direct'} | {code} | sha256:{h[:16]}… | {verdict} |\n")

    print(f"重放 {method} https://{host}{pathq}")
    print(f"状态码: {code}  响应体 sha256: {h}")
    print(f"判定: {verdict}（已追加 {log_path}）")
    return 0 if verdict != "FAIL(hash 不一致)" else 1

if __name__ == "__main__":
    sys.exit(main())
