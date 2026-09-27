#!/usr/bin/env bash
# 设置落点补丁：
#   0.1.5：settings 客户端镜像补丁（每个安装实例验证版本和整文件摘要，未知产物立即失败）。
#   0.1.7：settings.yaml 迁移到双 profile cordis.patch.yml 受管区块（已存在行不覆盖，
#           保留 UI 编辑结果）；settings.yaml 不再作为热更新真相源。
set -euo pipefail
BASE_DIR="${SEC_BASE_DIR:-{{BASE_DIR}}}"
exec python3 "$BASE_DIR/dsh-runtime-compat.py" --base-dir "$BASE_DIR" --settings-only
