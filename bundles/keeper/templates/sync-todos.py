#!/usr/bin/env python3
"""Memos Todo 同步脚本 - 智能版本
只在 Memos 有变更时才写入文件
"""
import os
import re
import sys
import json
import hashlib
import urllib.request
from datetime import datetime

# 配置
MEMOS_API = "http://localhost:5230/api/v1/memos"
MEMOS_TOKEN = os.environ.get("MEMOS_API_TOKEN", "")
# 如果环境变量为空，尝试从 .env 文件加载
if not MEMOS_TOKEN:
    env_file = "/opt/silkspool/keeper/.env"
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith("#") or not line:
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    if k == "MEMOS_API_TOKEN":
                        MEMOS_TOKEN = v.strip().strip('"').strip("'")
                        break
TODOS_DIR = "/mnt/NAS/data/knowledge/todos"
TODO_FILE = f"{TODOS_DIR}/todo.txt"
DONE_FILE = f"{TODOS_DIR}/done.txt"
STATE_FILE = f"{TODOS_DIR}/.sync_state"  # 存储上次同步状态

def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", file=sys.stderr)

def convert_to_todotxt(content):
    """将 Memos 格式转换为 todo.txt 格式"""
    content = re.sub(r'#待办\s*', '', content)
    content = re.sub(r'#todo\s*', '', content)
    
    # 优先级
    priority = ""
    pm = re.search(r'#P([1-3])\b', content)
    if pm:
        p_map = {"1": "A", "2": "B", "3": "C"}
        priority = f"({p_map.get(pm.group(1), '')})"
    content = re.sub(r'#P[1-3]\s*', '', content)
    
    # 日期
    due = ""
    dm = re.search(r'#D:(\d{4}-\d{2}-\d{2})', content)
    if dm:
        due = f"due:{dm.group(1)}"
    content = re.sub(r'#D:\d{4}-\d{2}-\d{2}\s*', '', content)
    
    # 项目
    projects = re.findall(r'#\+(\S+)', content)
    content = re.sub(r'#\+\S+\s*', '', content)
    
    # 上下文
    contexts = re.findall(r'#@(\S+)', content)
    content = re.sub(r'#@\S+\s*', '', content)
    
    # 清理
    content = re.sub(r'#\S+', '', content).strip()
    
    # 构建
    parts = [p for p in [priority, content] + [f"+{p}" for p in projects] + [f"@{c}" for c in contexts] + [due] if p]
    return " ".join(parts)

def ts_to_date(t):
    if t and t > 0:
        return datetime.fromtimestamp(t).strftime("%Y-%m-%d")
    return ""

def main():
    if not MEMOS_TOKEN:
        log("ERROR: MEMOS_API_TOKEN not set")
        sys.exit(1)

    if not os.path.exists(TODOS_DIR):
        log(f"ERROR: Directory {TODOS_DIR} not found")
        sys.exit(1)

    # 获取 Memos
    req = urllib.request.Request(MEMOS_API + "?pageSize=500")
    req.add_header("Authorization", f"Bearer {MEMOS_TOKEN}")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        log(f"ERROR: Failed to fetch memos: {e}")
        sys.exit(1)

    memos = data.get("memos", [])
    todo_lines, done_lines = [], []

    # 计算当前数据的指纹
    content_hash = hashlib.md5()
    max_updated_ts = 0

    for m in memos:
        content = m.get("content", "")
        if "#待办" not in content and "#todo" not in content:
            continue

        # 更新指纹和最大时间戳
        content_hash.update(content.encode())
        cts_str = m.get("updateTime", "")
        if cts_str:
            cts = int(datetime.fromisoformat(cts_str.replace('Z', '+00:00')).timestamp())
            if cts > max_updated_ts:
                max_updated_ts = cts

        tt = convert_to_todotxt(content)
        ct_str = m.get("createTime", "")
        ct = int(datetime.fromisoformat(ct_str.replace('Z', '+00:00')).timestamp()) if ct_str else 0

        # 判断是否完成：有 #done 或 #已完成 标签
        done = "#done" in content.lower() or "#已完成" in content

        if done:
            parts = [ts_to_date(cts), ts_to_date(ct), tt]
            done_lines.append("x " + " ".join(filter(None, parts)))
        else:
            parts = [ts_to_date(ct), tt]
            todo_lines.append(" ".join(filter(None, parts)))

    current_hash = content_hash.hexdigest()
    current_max_ts = max_updated_ts

    # 读取上次同步状态
    last_hash = None
    last_max_ts = 0
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                state = json.load(f)
                last_hash = state.get("hash")
                last_max_ts = state.get("max_ts", 0)
        except:
            pass

    # 检查是否有变更
    has_changes = (current_hash != last_hash) or (current_max_ts > last_max_ts)

    if not has_changes:
        log("No changes detected, skipping write")
        return

    # 有变更，写入文件并更新状态
    with open(TODO_FILE, "w") as f:
        f.write("\n".join(todo_lines))
    with open(DONE_FILE, "w") as f:
        f.write("\n".join(done_lines))

    # 保存状态
    with open(STATE_FILE, "w") as f:
        json.dump({"hash": current_hash, "max_ts": current_max_ts, "synced_at": datetime.now().isoformat()}, f)

    log(f"Sync completed: {len(todo_lines)} todos, {len(done_lines)} done")

if __name__ == "__main__":
    main()
