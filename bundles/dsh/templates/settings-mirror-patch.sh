#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 设置镜像补丁（spool bundle dsh setup / upgrade 调用，幂等）
# 背景 2026-08-24：Web UI「设置 → 模型」报「加载提供方目录失败: settings are unavailable in this browser」。
# 根因：dsh-client-ui-settings 按【浏览器页 hostname 是否 loopback】决定设置镜像持久层——
# 经域名/LAN 访问时 persistence="memory"，describe 永不加载（上游设计：设置 RPC 钉死 loopback）。
# 本平台边缘 Caddy 已把 Host/Origin 改写为 loopback（服务端栅栏通过），且有 dsh-auth-gate 密码门禁，
# 故补丁把客户端持久层固定为 "host"，让域名访问也能读写设置。
# 注意：补丁打在 pnpm 店内（dsh 升级会重装覆盖）——本脚本由 setup.sh 与 dsh-upgrade.sh 调用重放。
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
APP_DIR="$BASE_DIR/app"

log()  { echo "[settings-mirror-patch] $*"; }
warn() { echo "[settings-mirror-patch][WARN] $*"; }

PATTERN='s/connection\.isLoopback ? "host" : "memory"/"host"/g'
patched=0 skipped=0
shopt -s nullglob
for f in "$APP_DIR"/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-settings@*/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js; do
    if grep -q 'connection\.isLoopback ? "host" : "memory"' "$f"; then
        sed -i "$PATTERN" "$f"
        log "已补丁: $f"
        patched=$((patched+1))
    else
        skipped=$((skipped+1))
    fi
done
if [ "$patched" -eq 0 ] && [ "$skipped" -eq 0 ]; then
    warn "未找到 dsh-client-ui-settings（DSH 未安装或目录结构变更）"
    exit 0
fi
# 冒烟：至少一个实例处于已补丁状态
for f in "$APP_DIR"/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-settings@*/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js; do
    if grep -q 'persistence = "host"' "$f"; then
        log "冒烟通过（patched=$patched already=$skipped）。浏览器需硬刷新（Ctrl/Cmd+Shift+R）加载新客户端"
        exit 0
    fi
done
warn "冒烟失败：补丁后仍未见 persistence = \"host\""
exit 1
