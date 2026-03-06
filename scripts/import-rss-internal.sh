#!/bin/bash
# 在 Bellkeeper 容器内执行的 RSS 源导入脚本

API_KEY="${BELLKEEPER_API_KEY}"
API_URL="http://localhost:8080/api/rss"

cat <<'EOF' | jq -c '.sources[]' | while read -r source; do
{
  "sources": [
    {"name": "FreeBuf - 网络安全", "url": "/freebuf/index", "category": "网络安全", "description": "国内领先的网络安全行业门户"},
    {"name": "安全客 - 最新", "url": "/aqk/index", "category": "网络安全", "description": "安全客最新文章"},
    {"name": "Hacker News", "url": "/hackernews/newest", "category": "网络安全", "description": "Hacker News 最新技术资讯"},
    {"name": "The Hacker News", "url": "/thehackernews/posts", "category": "网络安全", "description": "国际知名网络安全新闻网站"},
    {"name": "Krebs on Security", "url": "/krebsonsecurity/blog", "category": "网络安全", "description": "Brian Krebs 的安全博客"},
    {"name": "Bleeping Computer", "url": "/bleepingcomputer/news/security", "category": "网络安全", "description": "安全新闻和漏洞分析"},
    {"name": "机器之心", "url": "/jiqizhixin/index", "category": "人工智能", "description": "专业的人工智能媒体和产业服务平台"},
    {"name": "量子位", "url": "/qbitai/index", "category": "人工智能", "description": "关注人工智能和前沿科技"},
    {"name": "AI 科技评论", "url": "/leiphone/ai", "category": "人工智能", "description": "雷锋网 AI 科技评论"},
    {"name": "Hugging Face Papers", "url": "/huggingface/daily-papers", "category": "人工智能", "description": "每日精选 AI 论文"},
    {"name": "OpenAI Blog", "url": "/openai/blog", "category": "人工智能", "description": "OpenAI 官方博客"},
    {"name": "Anthropic News", "url": "/anthropic/news", "category": "人工智能", "description": "Anthropic 官方新闻"},
    {"name": ".NET Blog", "url": "/dotnet/blog", "category": ".NET", "description": "微软 .NET 官方博客"},
    {"name": "C# Digest", "url": "/csharpdigest/index", "category": ".NET", "description": "C# 技术文章精选"},
    {"name": "Scott Hanselman", "url": "/scotthanselman/blog", "category": ".NET", "description": "微软 .NET 技术专家博客"},
    {"name": "Andrew Lock", "url": "/andrewlock/blog", "category": ".NET", "description": ".NET Core 深度技术博客"}
  ]
}
EOF

  name=$(echo "$source" | jq -r '.name')
  url=$(echo "$source" | jq -r '.url')
  category=$(echo "$source" | jq -r '.category')
  description=$(echo "$source" | jq -r '.description')

  echo "导入: $name"

  curl -s -X POST "$API_URL" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$name\",\"url\":\"$url\",\"category\":\"$category\",\"description\":\"$description\",\"is_active\":true}" \
    > /tmp/rss_import_result.json

  if [ $? -eq 0 ]; then
    echo "  ✅ 成功"
  else
    echo "  ❌ 失败"
  fi
done

echo "导入完成"