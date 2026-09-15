#!/usr/bin/env bash
# 构建版本受控的 Scope 浏览器 fork；输出 tarball、锁和实际安装字节的摘要。
# 不从浮动上游复制/正则打补丁，不启动共享浏览器，不重启生产服务。
set -euo pipefail
BASE_DIR="${SEC_BASE_DIR:-{{BASE_DIR}}}"
args=(--base-dir "$BASE_DIR" --templates "$BASE_DIR" --install)
if [ "${DSH_UPGRADE_OFFLINE:-0}" = 1 ]; then args+=(--offline); fi
exec python3 "$BASE_DIR/dsh-browser-fork.py" "${args[@]}"
