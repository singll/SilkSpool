#!/bin/bash
# RAGFlow 解析状态检查工具

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# 加载环境变量
if [ -f "$PROJECT_ROOT/hosts/keeper/.env" ]; then
    source "$PROJECT_ROOT/hosts/keeper/.env"
fi

BELLKEEPER_URL="${BELLKEEPER_URL:-http://localhost:8080}"
BELLKEEPER_API_KEY="${BELLKEEPER_API_KEY}"

if [ -z "$BELLKEEPER_API_KEY" ]; then
    echo -e "${RED}错误: BELLKEEPER_API_KEY 未设置${NC}"
    exit 1
fi

# 获取解析状态
echo -e "${BLUE}📊 正在获取 RAGFlow 解析状态...${NC}\n"

RESPONSE=$(curl -s -H "X-API-Key: $BELLKEEPER_API_KEY" "$BELLKEEPER_URL/api/ragflow/documents/parse/overview")

# 检查是否成功
if echo "$RESPONSE" | grep -q '"total_documents"'; then
    # 解析 JSON (使用 Python 因为 jq 可能不可用)
    python3 << 'EOF'
import json
import sys
import os

data = json.loads(os.environ['RESPONSE'])

total = data.get('total_documents', 0)
parsed = data.get('total_parsed', 0)
unparsed = data.get('total_unparsed', 0)
running = data.get('total_running', 0)
failed = data.get('total_failed', 0)
percent = round((parsed / total * 100) if total > 0 else 0)

# 颜色代码
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
RED = '\033[0;31m'
CYAN = '\033[0;36m'
GRAY = '\033[0;90m'
BOLD = '\033[1m'
NC = '\033[0m'

# 总体统计
print(f"{BOLD}{'='*60}{NC}")
print(f"{CYAN}总体进度{NC}")
print(f"{BOLD}{'='*60}{NC}\n")

# 进度条
bar_length = 40
filled = int(bar_length * percent / 100)
bar = '█' * filled + '░' * (bar_length - filled)
print(f"{bar} {GREEN}{percent}%{NC}\n")

print(f"  总文档数: {BOLD}{total}{NC}")
print(f"  已解析:   {GREEN}{parsed}{NC}")
print(f"  未解析:   {GRAY}{unparsed}{NC}")
print(f"  运行中:   {YELLOW}{running}{NC}")
print(f"  失败:     {RED}{failed}{NC}\n")

# 知识库详情
datasets = data.get('datasets', [])
if datasets:
    print(f"{BOLD}{'='*60}{NC}")
    print(f"{CYAN}知识库详情{NC}")
    print(f"{BOLD}{'='*60}{NC}\n")

    for ds in datasets:
        ds_name = ds.get('name', 'Unknown')
        ds_total = ds.get('total', 0)
        ds_parsed = ds.get('parsed', 0)
        ds_unparsed = ds.get('unparsed', 0)
        ds_running = ds.get('running', 0)
        ds_failed = ds.get('failed', 0)
        ds_percent = round((ds_parsed / ds_total * 100) if ds_total > 0 else 0)

        # 状态图标
        if ds_unparsed == 0 and ds_failed == 0:
            status = f"{GREEN}✅ 完成{NC}"
        elif ds_running > 0:
            status = f"{YELLOW}⏳ 运行中{NC}"
        elif ds_failed > 0:
            status = f"{RED}⚠️  有失败{NC}"
        else:
            status = f"{GRAY}⏸️  待处理{NC}"

        print(f"{BOLD}{ds_name}{NC} {status}")

        # 进度条
        ds_bar_length = 30
        ds_filled = int(ds_bar_length * ds_percent / 100)
        ds_bar = '█' * ds_filled + '░' * (ds_bar_length - ds_filled)
        print(f"  {ds_bar} {ds_percent}%")

        # 详细统计
        stats = []
        stats.append(f"总计: {ds_total}")
        stats.append(f"{GREEN}已解析: {ds_parsed}{NC}")
        if ds_unparsed > 0:
            stats.append(f"{GRAY}未解析: {ds_unparsed}{NC}")
        if ds_running > 0:
            stats.append(f"{YELLOW}运行中: {ds_running}{NC}")
        if ds_failed > 0:
            stats.append(f"{RED}失败: {ds_failed}{NC}")

        print(f"  {' | '.join(stats)}\n")

print(f"{BOLD}{'='*60}{NC}")
print(f"{GRAY}最后更新: {data.get('timestamp', 'N/A')}{NC}")
print(f"{GRAY}提示: 使用 Matrix 机器人命令 !解析状态 或 !ps 也可查看{NC}")
EOF
else
    echo -e "${RED}❌ 获取解析状态失败${NC}"
    echo -e "${GRAY}响应内容:${NC}"
    echo "$RESPONSE"
    exit 1
fi