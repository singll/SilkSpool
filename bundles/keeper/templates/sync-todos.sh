#!/bin/bash
# ==============================================================================
#  Memos Todo 同步脚本
#  功能: 从 Memos API 获取待办，转换为 todo.txt 格式，写入 TrueNAS 挂载
#  调度: 每分钟执行
# ==============================================================================

# 配置
MEMOS_API="http://sp-memos:5230/api/v1/memos"
MEMOS_TOKEN="${MEMOS_API_TOKEN:-}"
TODOS_DIR="/mnt/NAS/data/knowledge/todos"
TODO_FILE="$TODOS_DIR/todo.txt"
DONE_FILE="$TODOS_DIR/done.txt"

# 调试模式（设置为 1 开启）
DEBUG=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# 检查依赖
if [ -z "$MEMOS_TOKEN" ]; then
    log "ERROR: MEMOS_API_TOKEN not set"
    exit 1
fi

if [ ! -d "$TODOS_DIR" ]; then
    log "ERROR: Directory $TODOS_DIR not found"
    exit 1
fi

# 获取所有 Memos
response=$(curl -s -H "Authorization: Bearer $MEMOS_TOKEN" \
    "$MEMOS_API?pageSize=500" 2>/dev/null)

if [ $? -ne 0 ]; then
    log "ERROR: Failed to fetch memos"
    exit 1
fi

# 解析 JSON 并转换格式
# 使用 python3 进行 JSON 解析（Keeper 服务器应该有）
python3 << 'PYTHON_SCRIPT'
import sys
import json
import re
from datetime import datetime

try:
    data = json.loads(sys.stdin.read())
except:
    print("", file=sys.stderr)
    print("x 1 2", file=open("/dev/stdout", "w"))
    print("x 3 4", file=open("/dev/stdout", "w"))
    sys.exit(0)

memos = data.get("data", [])
todo_lines = []
done_lines = []

def convert_to_todotxt(content, memo):
    """将 Memos 格式转换为 todo.txt 格式"""
    # 移除 #待办 标签
    content = re.sub(r'#待办\s*', '', content)
    content = re.sub(r'#todo\s*', '', content)

    # 解析优先级: #P1 → (A), #P2 → (B), #P3 → (C)
    priority = ""
    p_match = re.search(r'#P([1-3])\b', content)
    if p_match:
        p_map = {"1": "A", "2": "B", "3": "C"}
        priority = f"({p_map.get(p_match.group(1), '')})"
        content = re.sub(r'#P[1-3]\s*', '', content)

    # 解析日期: #D:YYYY-MM-DD → due:YYYY-MM-DD
    due_match = re.search(r'#D:(\d{4}-\d{2}-\d{2})', content)
    due = ""
    if due_match:
        due = f"due:{due_match.group(1)}"
        content = re.sub(r'#D:\d{4}-\d{2}-\d{2}\s*', '', content)

    # 解析项目: #+project → +project
    projects = re.findall(r'#\+(\S+)', content)
    content = re.sub(r'#\+\S+\s*', '', content)

    # 解析上下文: #@context → @context
    contexts = re.findall(r'#@(\S+)', content)
    content = re.sub(r'#@\S+\s*', '', content)

    # 清理剩余标签
    content = re.sub(r'#\S+', '', content)
    content = content.strip()

    # 构建 todo.txt 格式
    parts = []
    if priority:
        parts.append(priority)
    parts.append(content)
    for p in projects:
        parts.append(f"+{p}")
    for c in contexts:
        parts.append(f"@{c}")
    if due:
        parts.append(due)

    return " ".join(parts)

def format_timestamp(ts):
    """Unix 时间戳转换为 YYYY-MM-DD"""
    if ts <= 0:
        return ""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")

for m in memos:
    content = m.get("content", "")

    # 检查是否是待办
    if "#待办" not in content and "#todo" not in content:
        continue

    todotxt = convert_to_todotxt(content, m)
    created_ts = m.get("createdTs", 0)
    completed_ts = m.get("completedTs")
    done = m.get("done", False)

    # 构建行
    line_parts = []
    if done or (completed_ts and completed_ts > 0):
        # 已完成格式: x <completed> <created> <content>
        line_parts.append("x")
        if completed_ts:
            line_parts.append(format_timestamp(completed_ts))
        if created_ts:
            line_parts.append(format_timestamp(created_ts))
        line_parts.append(todotxt)
        done_lines.append(" ".join(line_parts))
    else:
        # 待办格式: <priority> <created> <content>
        if created_ts > 0:
            line_parts.append(format_timestamp(created_ts))
        line_parts.append(todotxt)
        todo_lines.append(" ".join(line_parts))

# 输出结果
with open("/tmp/todo_sync_output.txt", "w") as f:
    f.write("TODO\n")
    f.write("\n".join(todo_lines))
    f.write("\n")
    f.write("DONE\n")
    f.write("\n".join(done_lines))
    f.write("\n")

print(f"Processed: {len(todo_lines)} todos, {len(done_lines)} done", file=sys.stderr)
PYTHON_SCRIPT

# 检查输出
if [ ! -f /tmp/todo_sync_output.txt ]; then
    log "ERROR: Python script failed"
    exit 1
fi

# 分离 todo.txt 和 done.txt
grep -A1000 "^TODO$" /tmp/todo_sync_output.txt | grep -v "^TODO$" | grep -v "^DONE$" > "$TODO_FILE"
grep -A1000 "^DONE$" /tmp/todo_sync_output.txt | grep -v "^DONE$" > "$DONE_FILE"

# 清理
rm -f /tmp/todo_sync_output.txt

# 调试输出
if [ "$DEBUG" = "1" ]; then
    log "--- todo.txt ---"
    cat "$TODO_FILE"
    log "--- done.txt ---"
    cat "$DONE_FILE"
fi

log "Sync completed"
