#!/usr/bin/env bash
# dsh-version-watch.sh — 监控 npm 上 @deepseek-ai/dsh 新版本（每日一次）
# dist-tags.latest 出现非已部署版本时写事件到 radar-queue.jsonl（recon 开局可见）
# 注意：必须查 dist-tags.latest 而非 versions[-1]（后者按发布序含 alpha 预发布，会误报）
set -uo pipefail
LOG=/opt/silkspool/dsh/data/pipeline/dsh-version-watch.log
RADAR=/opt/silkspool/dsh/data/pipeline/dsh-ops/radar-queue.jsonl
KNOWN="0.1.2-rc.1"
mkdir -p "$(dirname "$RADAR")"
LATEST=$(curl -fsSL --connect-timeout 15 "https://registry.npmjs.org/@deepseek-ai/dsh" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['dist-tags']['latest'])" 2>/dev/null)
NOW=$(date +%Y-%m-%dT%H:%M:%S)
if [ -z "$LATEST" ]; then
  echo "$NOW npm 查询失败" >> "$LOG"
  exit 0
fi
if [ "$LATEST" != "$KNOWN" ]; then
  echo "$NOW 发现新版本: $LATEST" >> "$LOG"
  printf '{"ts":"%s","type":"dsh-new-version","version":"%s","note":"npm 出现 @deepseek-ai/dsh@%s，评估升级窗口"}\n' "$NOW" "$LATEST" "$LATEST" >> "$RADAR"
else
  echo "$NOW 仍最新=$KNOWN" >> "$LOG"
fi
