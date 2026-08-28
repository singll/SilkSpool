#!/usr/bin/env python3
# ==============================================================================
# js-watch.py — 变化雷达·前端发版监控：watchlist 中的 JS/页面 URL 每日取 hash，
# 变化即输出 diff 事件到 radar 队列（recon 任务开局消费）
# 用法:
#   js-watch.py init <program> <url>          # 加入监控
#   js-watch.py run <program> [--proxy P]     # 跑一轮（cron 或 recon 开局调用）
# ==============================================================================
import sys, os, json, hashlib, subprocess
from datetime import datetime, timezone, timedelta

DATA = "/opt/silkspool/dsh/data/pipeline"
NOW = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%dT%H:%M:%S")

def paths(program):
    d = os.path.join(DATA, program)
    os.makedirs(d, exist_ok=True)
    return (os.path.join(d, "js-watchlist.txt"),
            os.path.join(d, "js-watch-state.json"),
            os.path.join(d, "radar-queue.jsonl"))

def cmd_init(program, url):
    wl, state_p, _ = paths(program)
    with open(wl, "a", encoding="utf-8") as f:
        f.write(url + "\n")
    print(f"[init] {url} 已加入 {program} 监控（共 {sum(1 for _ in open(wl))} 条）")

def fetch(url, proxy):
    cmd = ["curl", "-sL", "--max-time", "30", "-o", "-", "-w", "\n%{http_code}"]
    if proxy:
        cmd[1:1] = ["-x", proxy]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, timeout=45)
    out = r.stdout
    body, _, code = out.rpartition(b"\n")
    return code.decode(errors="replace"), hashlib.sha256(body).hexdigest(), len(body)

def cmd_run(program, proxy):
    wl, state_p, radar = paths(program)
    if not os.path.isfile(wl):
        print("[run] watchlist 为空，先 init")
        return 0
    state = {}
    if os.path.isfile(state_p):
        state = json.load(open(state_p))
    changed = 0
    for url in [l.strip() for l in open(wl) if l.strip()]:
        try:
            code, h, size = fetch(url, proxy)
        except Exception as e:
            print(f"[run] {url} 获取失败: {e}")
            continue
        old = state.get(url, {})
        if old.get("hash") and old["hash"] != h:
            event = {"ts": NOW, "type": "js-change", "url": url,
                     "old_hash": old["hash"][:12], "new_hash": h[:12],
                     "old_size": old.get("size"), "new_size": size}
            with open(radar, "a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
            print(f"[CHANGE] {url}  hash {old['hash'][:12]}→{h[:12]}  size {old.get('size')}→{size}")
            changed += 1
        state[url] = {"hash": h, "size": size, "code": code, "ts": NOW}
    json.dump(state, open(state_p, "w"), ensure_ascii=False, indent=1)
    print(f"[run] {program}: 检查 {len(state)} 条，变化 {changed} 条 → {radar}")

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, program = sys.argv[1], sys.argv[2]
    proxy = None
    if "--proxy" in sys.argv:
        proxy = sys.argv[sys.argv.index("--proxy") + 1]
    if cmd == "init" and len(sys.argv) >= 4:
        return cmd_init(program, sys.argv[3]) or 0
    if cmd == "run":
        return cmd_run(program, proxy) or 0
    print(__doc__)
    return 2

if __name__ == "__main__":
    sys.exit(main())
