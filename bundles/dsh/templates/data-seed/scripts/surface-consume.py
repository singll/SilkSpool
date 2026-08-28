#!/usr/bin/env python3
# ==============================================================================
# surface-consume.py — 参数面消费：从 endpoints.tsv / 任意文本提取带参数 URL，
# 全局去重后产出 dalfox/sqlmap 队列；另支持敏感信息正则回扫（脱敏检查 VC-027）
# 用法:
#   surface-consume.py queue <program> <endpoints.tsv|文本文件>   # 产出新参数 URL 队列
#   surface-consume.py scan <file>                                # 敏感字段正则回扫
# ==============================================================================
import sys, os, re, hashlib
from urllib.parse import urlparse, parse_qsl

DATA = "/opt/silkspool/dsh/data/pipeline"

SENSITIVE = {
    "phone": re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    "idcard": re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)"),
    "bankcard": re.compile(r"(?<!\d)\d{16,19}(?!\d)"),
    "aksk": re.compile(r"(?<![A-Za-z0-9])(AK[A-Z0-9]{15,}|LTAI[A-Za-z0-9]{12,}|SK[.A-Za-z0-9_-]{20,})(?![A-Za-z0-9])"),
    "token": re.compile(r"(?i)(api[_-]?key|secret|token)[\"'\s:=]+[A-Za-z0-9_\-]{16,}"),
    "jwt": re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),
    "private_ip": re.compile(r"(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![\d.])"),
}
URL_RE = re.compile(r"https?://[^\s\"'<>)]+")

def seen_file(program):
    return os.path.join(DATA, program, "param-seen.txt")

def queue_file(program):
    return os.path.join(DATA, program, "param-queue.txt")

def cmd_queue(program, src):
    os.makedirs(os.path.join(DATA, program), exist_ok=True)
    seen = set()
    if os.path.isfile(seen_file(program)):
        with open(seen_file(program), encoding="utf-8") as f:
            seen = {l.strip() for l in f if l.strip()}
    urls = set()
    if src.endswith(".tsv"):
        with open(src, encoding="utf-8") as f:
            header = f.readline()
            for line in f:
                cols = line.rstrip("\n").split("\t")
                if cols and cols[0].startswith("http") and len(cols) > 2 and cols[2]:
                    urls.add(cols[0])
    else:
        with open(src, encoding="utf-8", errors="replace") as f:
            for m in URL_RE.finditer(f.read()):
                u = m.group(0)
                try:
                    if parse_qsl(urlparse(u).query):
                        urls.add(u)
                except Exception:
                    pass
    new = sorted(u for u in urls if u not in seen)
    with open(queue_file(program), "a", encoding="utf-8") as f:
        for u in new:
            f.write(u + "\n")
    with open(seen_file(program), "a", encoding="utf-8") as f:
        for u in new:
            f.write(u + "\n")
    print(f"[queue] 新参数 URL {len(new)} 条（累计去重池 {len(seen)+len(new)}）→ {queue_file(program)}")
    print(f"下游：dalfox file {queue_file(program)} / sqlmap -m {queue_file(program)} --batch --level 1 --risk 1")

def cmd_scan(path):
    hits = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            for name, pat in SENSITIVE.items():
                for m in pat.finditer(line):
                    s = m.group(0)
                    masked = s[:4] + "***" + s[-2:] if len(s) > 6 else "***"
                    print(f"[hit] {path}:{i} {name}: {masked} (sha256:{hashlib.sha256(s.encode()).hexdigest()[:12]})")
                    hits += 1
                    break  # 每行每类报一次
    print(f"[scan] {path}: {hits} 处命中（已打码；原始值不留档，复核请回源文件）")
    return 1 if hits else 0

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "queue" and len(sys.argv) >= 4:
        return cmd_queue(sys.argv[2], sys.argv[3]) or 0
    if cmd == "scan":
        return cmd_scan(sys.argv[2])
    print(__doc__)
    return 2

if __name__ == "__main__":
    sys.exit(main())
