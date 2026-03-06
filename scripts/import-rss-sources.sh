#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$PROJECT_ROOT/hosts/keeper/.env"

API_URL="http://localhost:8090/api/rss"
RSS_FILE="$PROJECT_ROOT/doc/rss-sources.json"

if [ ! -f "$RSS_FILE" ]; then
  echo "错误: RSS 源文件不存在: $RSS_FILE"
  exit 1
fi

echo "开始导入 RSS 源..."

jq -c '.sources[]' "$RSS_FILE" | while read -r source; do
  name=$(echo "$source" | jq -r '.name')
  url=$(echo "$source" | jq -r '.url')
  category=$(echo "$source" | jq -r '.category')
  description=$(echo "$source" | jq -r '.description')

  echo "导入: $name ($category)"

  response=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
    -H "X-API-Key: $BELLKEEPER_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"$name\",
      \"url\": \"$url\",
      \"category\": \"$category\",
      \"description\": \"$description\",
      \"is_active\": true
    }")

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n-1)

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    echo "  ✅ 成功"
  else
    echo "  ❌ 失败 (HTTP $http_code): $body"
  fi
done

echo ""
echo "导入完成！"