#!/usr/bin/env bash
# ==============================================================================
# vault-sync.sh — SilkSecAgent 产物同步到 TrueNAS Obsidian vault（operator 侧 cron）
# 通道：csai（构建 vault-export）→ spool → keeper（NFS 挂载 vault）
# 目标：/mnt/NAS/data/knowledge/vault/SilkSecAgent/
# 用法：bash vault-sync.sh   （建议 cron: */30 * * * *）
# ==============================================================================
set -uo pipefail

VAULT=/mnt/NAS/data/knowledge/vault/SilkSecAgent

# 先在 csai 上构建最新导出包（幂等）
spool exec csai "bash /opt/silkspool/dsh/scripts/pipeline/vault-export-build.sh" || {
    echo "[vault-sync] csai 构建失败，本轮跳过"
    exit 1
}

# 打包 → 中继 → keeper 解包（--delete 语义由 tar 全覆盖 + 清理实现；
# 为安全不做 delete：只增量覆盖，人工批注文件不受影响）
# TrueNAS 数据集为 NFSv4 ACL 模式，chmod 一律 EPERM——容忍 "Cannot change mode" 类错误，
# 其余错误仍视为失败；解包后按文件数校验。
spool exec csai "cd /opt/silkspool/dsh/data/vault-export && tar czf - SilkSecAgent" \
  | spool exec keeper "sudo mkdir -p $VAULT && sudo tar xzf - --no-same-owner -C /mnt/NAS/data/knowledge/vault/ 2>/tmp/vault-tar-err; rc=\$?; [ \$rc -ne 0 ] && { grep -v 'Cannot change mode' /tmp/vault-tar-err | grep -v 'failure status' | grep -q . && exit 1; }; rm -f /tmp/vault-tar-err; exit 0" || {
    echo "[vault-sync] 中继失败，本轮跳过"
    exit 1
}

# 校验：keeper 侧文件数 ≥ csai 侧导出文件数（容忍 ACL 报错但不能丢文件）
LOCAL=$(spool exec csai "find /opt/silkspool/dsh/data/vault-export/SilkSecAgent -type f | wc -l")
REMOTE=$(spool exec keeper "find $VAULT -type f | wc -l")
echo "[vault-sync] 同步完成 → keeper:$VAULT（文件 $REMOTE/$LOCAL，$(date +%H:%M)）"
[ "$REMOTE" -ge "$LOCAL" ] || { echo "[vault-sync][WARN] 远端文件数不足"; exit 1; }
