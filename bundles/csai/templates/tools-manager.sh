#!/usr/bin/env bash
# ==============================================================================
# CyberStrikeAI 安全工具集成管理脚本
# 用法:
#   tools-manager.sh list                     列出全部工具（按分类）
#   tools-manager.sh check                    检测安装状态与版本
#   tools-manager.sh install all|core|<name>… 安装工具
#   tools-manager.sh update  all|<name>…      更新工具
# 说明:
#   - apt 组走系统包管理器；go 组走 go install @latest 到 /usr/local/bin
#   - metasploit / bloodhound 等重型工具标记 manual，需按官方文档手动安装
# ==============================================================================
set -uo pipefail

SUDO=''
if [ "$(id -u)" -ne 0 ]; then SUDO='sudo'; fi
export PATH=/usr/local/go/bin:$PATH
GOBIN=/usr/local/bin

# -------------------- 工具清单 (name:install_target) --------------------
APT_TOOLS=(
    # 网络扫描
    nmap:nmap masscan:masscan arp-scan:arp-scan nbtscan:nbtscan onesixtyone:onesixtyone
    # Web 应用扫描
    sqlmap:sqlmap nikto:nikto dirb:dirb gobuster:gobuster whatweb:whatweb wafw00f:wafw00f
    # 漏洞/口令
    hydra:hydra hashcat:hashcat john:john wpscan:wpscan sslscan:sslscan
    # DNS/枚举
    dnsenum:dnsenum fierce:fierce dnsutils:dnsutils snmp:snmp smbclient:smbclient enum4linux:enum4linux
    # 二进制/取证
    gdb:gdb radare2:radare2 binwalk:binwalk foremost:foremost steghide:steghide exiftool:libimage-exiftool-perl
    # 后渗透/辅助
    responder:responder impacket:python3-impacket netcat:netcat-traditional socat:socat rlwrap:rlwrap
)

GO_TOOLS=(
    nuclei:github.com/projectdiscovery/nuclei/v3/cmd/nuclei
    subfinder:github.com/projectdiscovery/subfinder/v2/cmd/subfinder
    httpx:github.com/projectdiscovery/httpx/cmd/httpx
    dnsx:github.com/projectdiscovery/dnsx/cmd/dnsx
    naabu:github.com/projectdiscovery/naabu/v2/cmd/naabu
    katana:github.com/projectdiscovery/katana/cmd/katana
    alterx:github.com/projectdiscovery/alterx/cmd/alterx
    ffuf:github.com/ffuf/ffuf/v2
    dalfox:github.com/hahwul/dalfox/v2
    amass:github.com/owasp-amass/amass/v4/cmd/amass
    assetfinder:github.com/tomnomnom/assetfinder
    waybackurls:github.com/tomnomnom/waybackurls
)

MANUAL_TOOLS=(
    metasploit-framework   # https://docs.metasploit.com/docs/using-metasploit/getting-started/nightly-installers.html
    bloodhound             # https://github.com/SpecterOps/BloodHound
    volatility3            # pip install volatility3
)

CORE_NAMES=(nmap masscan sqlmap nikto gobuster ffuf nuclei subfinder httpx hydra hashcat john)

# -------------------- 辅助 --------------------
apt_pkg_of()  { for e in "${APT_TOOLS[@]}"; do [ "${e%%:*}" = "$1" ] && { echo "${e#*:}"; return 0; }; done; return 1; }
go_path_of()  { for e in "${GO_TOOLS[@]}"; do [ "${e%%:*}" = "$1" ] && { echo "${e#*:}"; return 0; }; done; return 1; }
is_manual()   { for m in "${MANUAL_TOOLS[@]}"; do [ "${m%% *}" = "$1" ] && return 0; done; return 1; }
all_names()   { for e in "${APT_TOOLS[@]}"; do echo "${e%%:*}"; done; for e in "${GO_TOOLS[@]}"; do echo "${e%%:*}"; done; }

tool_version() {
    local out
    out=$("$1" --version 2>/dev/null | head -1 || "$1" -V 2>/dev/null | head -1 || "$1" version 2>/dev/null | head -1 || true)
    [ -n "$out" ] && echo "$out" || echo "-"
}

# -------------------- 命令 --------------------
cmd_list() {
    echo "== APT 组 =="
    for e in "${APT_TOOLS[@]}"; do printf "  %-16s (apt: %s)\n" "${e%%:*}" "${e#*:}"; done
    echo "== Go 组 =="
    for e in "${GO_TOOLS[@]}"; do printf "  %-16s (go: %s)\n" "${e%%:*}" "${e#*:}"; done
    echo "== 手动安装 =="
    for m in "${MANUAL_TOOLS[@]}"; do echo "  $m"; done
}

cmd_check() {
    local ok=0 miss=0 name
    printf "%-16s %-10s %s\n" "TOOL" "STATUS" "VERSION"
    for name in $(all_names); do
        if command -v "$name" >/dev/null 2>&1; then
            printf "%-16s %-10s %s\n" "$name" "OK" "$(tool_version "$name")"
            ok=$((ok+1))
        else
            printf "%-16s %-10s %s\n" "$name" "MISSING" "-"
            miss=$((miss+1))
        fi
    done
    echo "----"
    echo "已安装 $ok，缺失 $miss。安装全部: tools-manager.sh install all；核心集: install core"
}

do_install_one() {
    local name="$1" target
    if command -v "$name" >/dev/null 2>&1; then echo "[skip] $name 已安装"; return 0; fi
    if target=$(apt_pkg_of "$name"); then
        echo "[apt] 安装 $name ($target)"
        $SUDO apt-get update -qq
        $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y "$target"
    elif target=$(go_path_of "$name"); then
        command -v go >/dev/null 2>&1 || { echo "[fail] $name 需要 Go，请先运行 setup.sh"; return 1; }
        echo "[go] 安装 $name ($target@latest)"
        $SUDO env GOBIN="$GOBIN" PATH="$PATH" go install "${target}@latest"
    elif is_manual "$name"; then
        echo "[manual] $name 需手动安装，见 tools-manager.sh list"
        return 1
    else
        echo "[fail] 未知工具: $name"
        return 1
    fi
}

do_update_one() {
    local name="$1" target
    if target=$(apt_pkg_of "$name"); then
        echo "[apt] 更新 $name"
        $SUDO apt-get update -qq
        $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade "$target"
    elif target=$(go_path_of "$name"); then
        echo "[go] 更新 $name → latest"
        $SUDO env GOBIN="$GOBIN" PATH="$PATH" go install "${target}@latest"
    else
        echo "[skip] $name 不支持自动更新"
    fi
}

expand_targets() {
    if [ $# -eq 0 ] || [ "$1" = "all" ]; then all_names
    elif [ "$1" = "core" ]; then printf "%s\n" "${CORE_NAMES[@]}"
    else printf "%s\n" "$@"; fi
}

cmd_install() { local t; for t in $(expand_targets "$@"); do do_install_one "$t"; done; }
cmd_update()  { local t; for t in $(expand_targets "$@"); do do_update_one "$t"; done; }

case "${1:-help}" in
    list)    cmd_list ;;
    check|status) cmd_check ;;
    install) shift; cmd_install "$@" ;;
    update)  shift; cmd_update "$@" ;;
    *)       grep -E '^\#   tools-manager' "$0" | sed 's/^# //' ;;
esac
