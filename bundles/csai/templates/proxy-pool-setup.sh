#!/usr/bin/env bash
# ==============================================================================
# csai 代理池幂等安装脚本（由 setup.sh 末尾调用，也可单独执行，可重复运行）
# 组件：
#   proxy-scraper-checker (Rust 单二进制) —— 采集+验证免费代理
#   proxy_grade.py                        —— 匿名度分级 → pool.json/live.txt
#   mubeng                                —— 本地轮换网关 127.0.0.1:8899
#   mcp_proxy_pool.py                     —— CyberStrikeAI 外部 MCP（LLM 管理代理池）
#   csai-proxy-refresh.timer              —— 每 30 分钟自动刷新
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
POOL_DIR="$BASE_DIR/proxy-pool"
MUBENG_VERSION="0.23.0"

log()  { echo "[proxy-pool] $*"; }
warn() { echo "[proxy-pool][WARN] $*"; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then SUDO='sudo'; fi

# 下载（GitHub 直连失败时走镜像回退）
download() {
    local url="$1" dst="$2"
    local mirrors=("" "https://ghfast.top/")
    for prefix in "${mirrors[@]}"; do
        if curl -fsSL --connect-timeout 10 --retry 2 "${prefix}${url}" -o "$dst"; then
            return 0
        fi
        warn "下载失败，尝试下一镜像: ${prefix}${url}"
    done
    return 1
}

mkdir -p "$POOL_DIR/bin" "$POOL_DIR/out"

# -------------------- 1. mubeng --------------------
install_mubeng() {
    local bin="$POOL_DIR/bin/mubeng"
    if [ -x "$bin" ] && "$bin" -V 2>/dev/null | grep -q "$MUBENG_VERSION"; then
        log "mubeng $MUBENG_VERSION 已就绪"
        return
    fi
    local arch
    case "$(uname -m)" in
        x86_64)  arch=amd64 ;;
        aarch64) arch=arm64 ;;
        *) warn "不支持的架构: $(uname -m)"; return 1 ;;
    esac
    log "下载 mubeng v$MUBENG_VERSION (linux/$arch)"
    download "https://github.com/mubeng/mubeng/releases/download/v${MUBENG_VERSION}/mubeng_${MUBENG_VERSION}_linux_${arch}" "$bin"
    chmod +x "$bin"
    log "mubeng 安装完成: $("$bin" -V 2>&1 | head -1)"
}

# -------------------- 2. proxy-scraper-checker --------------------
install_scraper() {
    local bin="$POOL_DIR/bin/proxy-scraper-checker"
    if [ -x "$bin" ] && [ -z "${PSC_UPDATE:-}" ]; then
        log "proxy-scraper-checker 已存在（PSC_UPDATE=1 可更新）"
        return
    fi
    command -v unzip >/dev/null 2>&1 || { $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip; }
    local target
    case "$(uname -m)" in
        x86_64)  target=x86_64-unknown-linux-musl ;;
        aarch64) target=aarch64-unknown-linux-musl ;;
        *) warn "不支持的架构: $(uname -m)"; return 1 ;;
    esac
    log "下载 proxy-scraper-checker ($target, nightly)"
    local zip="$POOL_DIR/psc.zip"
    download "https://nightly.link/monosans/proxy-scraper-checker/workflows/ci/main/proxy-scraper-checker-binary-${target}.zip" "$zip"
    unzip -o -q "$zip" -d "$POOL_DIR/psc-tmp"
    mv "$POOL_DIR/psc-tmp/proxy-scraper-checker" "$bin"
    chmod +x "$bin"
    local sha
    sha=$(cat "$POOL_DIR/psc-tmp/commit-sha.txt" 2>/dev/null || echo unknown)
    rm -rf "$POOL_DIR/psc-tmp" "$zip"
    log "proxy-scraper-checker 安装完成 (commit ${sha:0:7})"
}

# -------------------- 3. 归位 bundle 推送的平面文件 --------------------
arrange_files() {
    # bundle pushTemplates 将模板平铺到 BASE_DIR 根，这里移入 proxy-pool/
    [ -f "$BASE_DIR/proxy_grade.py" ]      && mv -f "$BASE_DIR/proxy_grade.py" "$POOL_DIR/proxy_grade.py"
    [ -f "$BASE_DIR/mcp_proxy_pool.py" ]   && mv -f "$BASE_DIR/mcp_proxy_pool.py" "$POOL_DIR/mcp_proxy_pool.py"
    [ -f "$BASE_DIR/proxy-pool-run-refresh.sh" ] && mv -f "$BASE_DIR/proxy-pool-run-refresh.sh" "$POOL_DIR/proxy-pool-run-refresh.sh"
    [ -f "$BASE_DIR/proxy-scraper-checker.toml" ] && mv -f "$BASE_DIR/proxy-scraper-checker.toml" "$POOL_DIR/config.toml"
    chmod +x "$POOL_DIR/proxy_grade.py" "$POOL_DIR/mcp_proxy_pool.py" "$POOL_DIR/proxy-pool-run-refresh.sh" 2>/dev/null || true
    [ -f "$POOL_DIR/config.toml" ] || warn "缺少 $POOL_DIR/config.toml"
    touch "$POOL_DIR/live.txt" "$POOL_DIR/blocklist.txt"
}

# -------------------- 4. mubeng MITM CA 入系统信任库 --------------------
# mubeng 网关对 HTTPS 做 MITM（GoProxy 内置静态 CA，2037 年到期），
# 装入系统信任库后 curl/git/python 等经网关无需 -k
install_mitm_ca() {
    local dst=/usr/local/share/ca-certificates/goproxy-mitm.crt
    if [ -f "$dst" ]; then
        log "MITM CA 已安装"
        return
    fi
    $SUDO tee "$dst" >/dev/null <<'EOF'
-----BEGIN CERTIFICATE-----
MIIF9DCCA9ygAwIBAgIJAODqYUwoVjJkMA0GCSqGSIb3DQEBCwUAMIGOMQswCQYD
VQQGEwJJTDEPMA0GA1UECAwGQ2VudGVyMQwwCgYDVQQHDANMb2QxEDAOBgNVBAoM
B0dvUHJveHkxEDAOBgNVBAsMB0dvUHJveHkxGjAYBgNVBAMMEWdvcHJveHkuZ2l0
aHViLmlvMSAwHgYJKoZIhvcNAQkBFhFlbGF6YXJsQGdtYWlsLmNvbTAeFw0xNzA0
MDUyMDAwMTBaFw0zNzAzMzEyMDAwMTBaMIGOMQswCQYDVQQGEwJJTDEPMA0GA1UE
CAwGQ2VudGVyMQwwCgYDVQQHDANMb2QxEDAOBgNVBAoMB0dvUHJveHkxEDAOBgNV
BAsMB0dvUHJveHkxGjAYBgNVBAMMEWdvcHJveHkuZ2l0aHViLmlvMSAwHgYJKoZI
hvcNAQkBFhFlbGF6YXJsQGdtYWlsLmNvbTCCAiIwDQYJKoZIhvcNAQEBBQADggIP
ADCCAgoCggIBAJ4Qy+H6hhoY1s0QRcvIhxrjSHaO/RbaFj3rwqcnpOgFq07gRdI9
3c0TFKQJHpgv6feLRhEvX/YllFYu4J35lM9ZcYY4qlKFuStcX8Jm8fqpgtmAMBzP
sqtqDi8M9RQGKENzU9IFOnCV7SAeh45scMuI3wz8wrjBcH7zquHkvqUSYZz035t9
V6WTrHyTEvT4w+lFOVN2bA/6DAIxrjBiF6DhoJqnha0SZtDfv77XpwGG3EhA/qoh
hiYrDruYK7zJdESQL44LwzMPupVigqalfv+YHfQjbhT951IVurW2NJgRyBE62dLr
lHYdtT9tCTCrd+KJNMJ+jp9hAjdIu1Br/kifU4F4+4ZLMR9Ueji0GkkPKsYdyMnq
j0p0PogyvP1l4qmboPImMYtaoFuYmMYlebgC9LN10bL91K4+jLt0I1YntEzrqgJo
WsJztYDw543NzSy5W+/cq4XRYgtq1b0RWwuUiswezmMoeyHZ8BQJe2xMjAOllASD
fqa8OK3WABHJpy4zUrnUBiMuPITzD/FuDx4C5IwwlC68gHAZblNqpBZCX0nFCtKj
YOcI2So5HbQ2OC8QF+zGVuduHUSok4hSy2BBfZ1pfvziqBeetWJwFvapGB44nIHh
WKNKvqOxLNIy7e+TGRiWOomrAWM18VSR9LZbBxpJK7PLSzWqYJYTRCZHAgMBAAGj
UzBRMB0GA1UdDgQWBBR4uDD9Y6x7iUoHO+32ioOcw1ICZTAfBgNVHSMEGDAWgBR4
uDD9Y6x7iUoHO+32ioOcw1ICZTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEB
CwUAA4ICAQAaCEupzGGqcdh+L7BzhX7zyd7yzAKUoLxFrxaZY34Xyj3lcx1XoK6F
AqsH2JM25GixgadzhNt92JP7vzoWeHZtLfstrPS638Y1zZi6toy4E49viYjFk5J0
C6ZcFC04VYWWx6z0HwJuAS08tZ37JuFXpJGfXJOjZCQyxse0Lg0tuKLMeXDCk2Y3
Ba0noeuNyHRoWXXPyiUoeApkVCU5gIsyiJSWOjhJ5hpJG06rQNfNYexgKrrraEin
o0jmEMtJMx5TtD83hSnLCnFGBBq5lkE7jgXME1KsbIE3lJZzRX1mQwUK8CJDYxye
i6M/dzSvy0SsPvz8fTAlprXRtWWtJQmxgWENp3Dv+0Pmux/l+ilk7KA4sMXGhsfr
bvTOeWl1/uoFTPYiWR/ww7QEPLq23yDFY04Q7Un0qjIk8ExvaY8lCkXMgc8i7sGY
VfvOYb0zm67EfAQl3TW8Ky5fl5CcxpVCD360Bzi6hwjYixa3qEeBggOixFQBFWft
8wrkKTHpOQXjn4sDPtet8imm9UYEtzWrFX6T9MFYkBR0/yye0FIh9+YPiTA6WB86
NCNwK5Yl6HuvF97CIH5CdgO+5C7KifUtqTOL8pQKbNwy0S3sNYvB+njGvRpR7pKV
BUnFpB/Atptqr4CUlTXrc5IPLAqAfmwk5IKcwy3EXUbruf9Dwz69YA==
-----END CERTIFICATE-----
EOF
    $SUDO update-ca-certificates >/dev/null 2>&1 || true
    log "MITM CA 已写入 $dst"
}

# -------------------- 5. 刷新定时器（bundle 仅自动安装 .service，timer 在此安装） --------------------
install_timer() {
    local timer=/etc/systemd/system/csai-proxy-refresh.timer
    $SUDO tee "$timer" >/dev/null <<'EOF'
[Unit]
Description=CSAI Proxy Pool - periodic refresh (scrape+validate+grade)

[Timer]
OnBootSec=3min
OnUnitActiveSec=30min
Unit=csai-proxy-refresh.service

[Install]
WantedBy=timers.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now csai-proxy-refresh.timer
    log "定时器已启用: $(systemctl is-active csai-proxy-refresh.timer)"
}

# -------------------- 6. 首次刷新（无队列时后台触发一次） --------------------
initial_refresh() {
    if [ ! -s "$POOL_DIR/live.txt" ] && ! systemctl is-active --quiet csai-proxy-refresh.service; then
        log "首次运行，后台触发代理池刷新（约 5-15 分钟）"
        $SUDO systemctl start --no-block csai-proxy-refresh.service || warn "首次刷新触发失败，可稍后手动: systemctl start csai-proxy-refresh.service"
    fi
}

log "POOL_DIR=$POOL_DIR"
install_mubeng
install_scraper
arrange_files
install_mitm_ca
install_timer
initial_refresh
log "proxy-pool 安装完成"
