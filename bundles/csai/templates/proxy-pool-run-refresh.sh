#!/usr/bin/env bash
# ==============================================================================
# proxy-scraper-checker 运行包装器
# 上游二进制编译进 TUI 且无关闭开关：无 TTY 直接报错（os error 6），
# 且在 TUI 下跑完后会停在 "press q" 界面不退出。本包装器：
#   1. 用 script(1) 提供伪终端
#   2. 监视 out/proxies.json 落盘后向 TUI 发送 'q' 使其退出
# ==============================================================================
set -uo pipefail

POOL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$POOL_DIR"
touch .run-start

(
    # 最长兜底 30 分钟，超时也发 q 结束（TimeoutStartSec 之前）
    for _ in $(seq 1 360); do
        sleep 5
        if [ -f out/proxies.json ] && [ out/proxies.json -nt .run-start ]; then
            sleep 10  # 等待输出完全写完
            printf 'q'
            sleep 30  # 保持 stdin 打开直至 TUI 退出
            exit 0
        fi
    done
    printf 'q'
    sleep 30
) | /usr/bin/script -qefc "$POOL_DIR/bin/proxy-scraper-checker" /dev/null
