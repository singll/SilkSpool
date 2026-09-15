#!/usr/bin/env bash
# rc.2 设置镜像补丁：每个安装实例都验证版本和整文件摘要，未知产物立即失败。
set -euo pipefail
BASE_DIR="${SEC_BASE_DIR:-{{BASE_DIR}}}"
exec python3 "$BASE_DIR/dsh-runtime-compat.py" --base-dir "$BASE_DIR" --settings-only
