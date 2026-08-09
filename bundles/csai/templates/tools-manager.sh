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

# -------------------- 工具清单 --------------------
# APT 组格式: name:apt_pkg[:check_cmd]（check_cmd 省略时按 name 检测；py_ 前缀表示 python 模块检测）
APT_TOOLS=(
    # 网络扫描
    nmap:nmap masscan:masscan arp-scan:arp-scan nbtscan:nbtscan onesixtyone:onesixtyone
    # Web 应用扫描
    sqlmap:sqlmap nikto:nikto dirb:dirb gobuster:gobuster whatweb:whatweb wafw00f:wafw00f
    # 漏洞/口令
    hydra:hydra hashcat:hashcat john:john sslscan:sslscan
    # DNS/枚举
    dnsenum:dnsenum fierce:fierce dnsutils:dnsutils:dig snmp:snmp:snmpwalk smbclient:smbclient
    # 二进制/取证
    gdb:gdb radare2:radare2 binwalk:binwalk foremost:foremost steghide:steghide exiftool:libimage-exiftool-perl
    # 后渗透/辅助
    impacket:python3-impacket:py_impacket netcat:netcat-traditional socat:socat rlwrap:rlwrap
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
    gau:github.com/lc/gau/v2/cmd/gau
    kube-bench:github.com/aquasecurity/kube-bench
)

# PIP 组（装入应用 venv，systemd PATH 已含）格式: name:pip_ref[:check_cmd]
VENV="{{BASE_DIR}}/CyberStrikeAI/venv"
PIP_TOOLS=(
    ropgadget:ropgadget:ROPgadget
    volatility3:volatility3:vol
    pycurl:pycurl:py_pycurl
    netifaces:netifaces:py_netifaces
)

# 特殊安装（git 克隆/脚本化资源）
SPECIAL_TOOLS=(seclists wordlists paramspider enum4linux-ng x8 pwninit cloudmapper falco wpscan responder)

MANUAL_TOOLS=(
    metasploit-framework   # https://docs.metasploit.com/docs/using-metasploit/getting-started/nightly-installers.html
    bloodhound             # https://github.com/SpecterOps/BloodHound
    ghidra                 # https://github.com/NationalSecurityAgency/ghidra/releases (analyzeHeadless)
    xsser                  # https://github.com/epsylon/xsser
)

CORE_NAMES=(nmap masscan sqlmap nikto gobuster ffuf nuclei subfinder httpx hydra hashcat john)

# -------------------- 辅助 --------------------
field() { echo "$2" | cut -d: -f"$1"; }

entry_of() { # $1=array名 $2=工具名 → 输出条目
    local -n arr=$1
    for e in "${arr[@]}"; do [ "$(field 1 "$e")" = "$2" ] && { echo "$e"; return 0; }; done
    return 1
}

is_special() { for m in "${SPECIAL_TOOLS[@]}"; do [ "$m" = "$1" ] && return 0; done; return 1; }
is_manual()  { for m in "${MANUAL_TOOLS[@]}"; do [ "${m%% *}" = "$1" ] && return 0; done; return 1; }

all_names() {
    for e in "${APT_TOOLS[@]}"; do field 1 "$e"; done
    for e in "${GO_TOOLS[@]}"; do field 1 "$e"; done
    for e in "${PIP_TOOLS[@]}"; do field 1 "$e"; done
    printf "%s\n" "${SPECIAL_TOOLS[@]}"
}

# check_cmd_for $1=条目 → 输出检测方式（默认工具名；py:xxx 表示 python 模块）
check_cmd_for() {
    local e="$1" c
    c=$(field 3 "$e")
    [ -n "$c" ] && echo "$c" || field 1 "$e"
}

tool_present() { # $1=检测方式
    case "$1" in
        py_*) "$VENV/bin/python3" -c "import ${1#py_}" >/dev/null 2>&1 ;;
        *)    command -v "$1" >/dev/null 2>&1 || [ -x "$VENV/bin/$1" ] || [ -x "/usr/sbin/$1" ] || [ -x "/sbin/$1" ] ;;
    esac
}

tool_check_spec() { # $1=工具名 → 输出检测方式，未定义返回 1
    local e
    e=$(entry_of APT_TOOLS "$1")  && { check_cmd_for "$e"; return 0; }
    e=$(entry_of GO_TOOLS "$1")   && { field 1 "$e"; return 0; }
    e=$(entry_of PIP_TOOLS "$1")  && { check_cmd_for "$e"; return 0; }
    case "$1" in
        seclists)    echo "dir:/usr/share/seclists" ;;
        wordlists)   echo "file:/usr/share/wordlists/rockyou.txt" ;;
        paramspider) echo "$VENV/bin/paramspider" ;;
        enum4linux-ng) echo "$VENV/bin/enum4linux-ng" ;;
        cloudmapper) echo "/usr/local/bin/cloudmapper" ;;
        x8)          echo "/usr/local/bin/x8" ;;
        pwninit)     echo "/usr/local/bin/pwninit" ;;
        falco)       echo "/usr/bin/falco" ;;
        wpscan)      echo "/usr/local/bin/wpscan" ;;
        responder)   echo "/usr/local/bin/responder" ;;
        *) return 1 ;;
    esac
}

tool_version() {
    local out
    out=$("$1" --version 2>/dev/null | head -1 || "$1" -V 2>/dev/null | head -1 || "$1" version 2>/dev/null | head -1 || true)
    [ -n "$out" ] && echo "$out" || echo "-"
}

# -------------------- 特殊安装 --------------------
install_special() {
    case "$1" in
        seclists)
            [ -d /usr/share/seclists ] && { echo "[skip] seclists 已存在"; return 0; }
            echo "[git] 克隆 SecLists → /usr/share/seclists"
$SUDO git clone --depth 1 https://github.com/danielmiessler/SecLists.git /usr/share/seclists ;;
        wordlists)
            [ -f /usr/share/wordlists/rockyou.txt ] && { echo "[skip] rockyou 已存在"; return 0; }
            install_special seclists
            echo "[extract] rockyou.txt → /usr/share/wordlists/"
$SUDO mkdir -p /usr/share/wordlists
$SUDO tar -xzf /usr/share/seclists/Passwords/Leaked-Databases/rockyou.txt.tar.gz -C /usr/share/wordlists/
$SUDO chmod 644 /usr/share/wordlists/rockyou.txt ;;
        paramspider)
            [ -x "$VENV/bin/paramspider" ] && { echo "[skip] paramspider 已安装"; return 0; }
            echo "[git+pip] 安装 ParamSpider（PyPI 上为占位包，须从 GitHub 安装）"
            [ -d /usr/share/paramspider ] || $SUDO git clone --depth 1 https://github.com/devanshbatham/ParamSpider.git /usr/share/paramspider
            $SUDO chown -R "$(id -u):$(id -g)" /usr/share/paramspider
            "$VENV/bin/pip" install -q /usr/share/paramspider ;;
        enum4linux-ng)
            [ -x "$VENV/bin/enum4linux-ng" ] && { echo "[skip] enum4linux-ng 已安装"; return 0; }
            echo "[pip] 安装 enum4linux-ng（PyPI 无此包，从 GitHub 安装）"
            "$VENV/bin/pip" install -q 'git+https://github.com/cddmp/enum4linux-ng.git' ;;
        x8)
            command -v x8 >/dev/null 2>&1 && { echo "[skip] x8 已安装"; return 0; }
            echo "[release] 安装 x8（Rust 参数发现工具，GitHub 预编译）"
            local tmp; tmp=$(mktemp -d)
            curl -fsSL -o "$tmp/x8.gz" "https://github.com/Sh1Yo/x8/releases/latest/download/x86_64-linux-x8.gz"
            gzip -d "$tmp/x8.gz" && $SUDO install -m 755 "$tmp/x8" /usr/local/bin/x8
            rm -rf "$tmp" ;;
        pwninit)
            command -v pwninit >/dev/null 2>&1 && { echo "[skip] pwninit 已安装"; return 0; }
            echo "[release] 安装 pwninit"
            curl -fsSL -o /tmp/pwninit.bin "https://github.com/io12/pwninit/releases/latest/download/pwninit"
            $SUDO install -m 755 /tmp/pwninit.bin /usr/local/bin/pwninit; rm -f /tmp/pwninit.bin ;;
        cloudmapper)
            [ -x /usr/local/bin/cloudmapper ] && { echo "[skip] cloudmapper 已安装"; return 0; }
            echo "[git+pip] 安装 CloudMapper"
            [ -d /usr/share/cloudmapper ] || $SUDO git clone --depth 1 https://github.com/duo-labs/cloudmapper.git /usr/share/cloudmapper
            $SUDO chown -R "$(id -u):$(id -g)" /usr/share/cloudmapper
            "$VENV/bin/pip" install -q -r /usr/share/cloudmapper/requirements.txt || echo "[warn] 部分依赖安装失败，基本功能可用"
            printf '#!/bin/bash\nexec %s/bin/python3 /usr/share/cloudmapper/cloudmapper.py "$@"\n' "$VENV" | $SUDO tee /usr/local/bin/cloudmapper >/dev/null
            $SUDO chmod 755 /usr/local/bin/cloudmapper ;;
        falco)
            command -v falco >/dev/null 2>&1 && { echo "[skip] falco 已安装"; return 0; }
            echo "[apt-repo] 安装 Falco（官方仓库）"
            echo "注意: LXC/无内核头环境下 falco 内核驱动不可用，仅安装用户态"
            curl -fsSL 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x65106822B35B1B1F' -o /tmp/falco.key
            $SUDO rm -f /usr/share/keyrings/falco-archive-keyring.gpg
            $SUDO gpg --batch --dearmor -o /usr/share/keyrings/falco-archive-keyring.gpg /tmp/falco.key
            echo 'deb [signed-by=/usr/share/keyrings/falco-archive-keyring.gpg] https://download.falco.org/packages/deb stable main' | $SUDO tee /etc/apt/sources.list.d/falcosecurity.list >/dev/null
            $SUDO apt-get update -qq
            $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y falco || {
                echo "[warn] postinst 驱动构建失败（LXC），跳过驱动编译"
                $SUDO sed -i '1a exit 0  # spool: skip driver build' /var/lib/dpkg/info/falco.postinst
                $SUDO dpkg --configure falco
            } ;;
        wpscan)
            [ -x /usr/local/bin/wpscan ] && { echo "[skip] wpscan 已安装"; return 0; }
            echo "[gem] 安装 WPScan（Ubuntu 仓库无此包，走 RubyGems）"
            $SUDO apt-get update -qq
            $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ruby ruby-dev libcurl4-openssl-dev libxml2-dev libxslt1-dev zlib1g-dev
            $SUDO gem install wpscan --no-document ;;
        responder)
            [ -x /usr/local/bin/responder ] && { echo "[skip] responder 已安装"; return 0; }
            echo "[git] 安装 Responder（Ubuntu 仓库无此包，从 GitHub 克隆 + wrapper）"
            [ -d /opt/Responder ] || $SUDO git clone --depth 1 https://github.com/lgandx/Responder.git /opt/Responder
            printf '#!/bin/sh\nexec python3 /opt/Responder/Responder.py "$@"\n' | $SUDO tee /usr/local/bin/responder >/dev/null
            $SUDO chmod 755 /usr/local/bin/responder ;;
    esac
}

# -------------------- 命令 --------------------
cmd_list() {
    echo "== APT 组 =="
    for e in "${APT_TOOLS[@]}"; do printf "  %-16s (apt: %s)\n" "$(field 1 "$e")" "$(field 2 "$e")"; done
    echo "== Go 组 =="
    for e in "${GO_TOOLS[@]}"; do printf "  %-16s (go: %s)\n" "$(field 1 "$e")" "$(field 2 "$e")"; done
    echo "== PIP 组 (应用 venv) =="
    for e in "${PIP_TOOLS[@]}"; do printf "  %-16s (pip: %s)\n" "$(field 1 "$e")" "$(field 2 "$e")"; done
    echo "== 特殊 =="
    printf "  %s\n" "${SPECIAL_TOOLS[@]}"
    echo "== 手动安装 =="
    for m in "${MANUAL_TOOLS[@]}"; do echo "  $m"; done
}

cmd_check() {
    local ok=0 miss=0 name spec
    printf "%-16s %-10s %s\n" "TOOL" "STATUS" "VERSION"
    for name in $(all_names); do
        spec=$(tool_check_spec "$name")
        case "$spec" in
            dir:*)  [ -d "${spec#dir:}" ]  && spec="" || spec="MISSING" ;;
            file:*) [ -f "${spec#file:}" ] && spec="" || spec="MISSING" ;;
            py_*)   "$VENV/bin/python3" -c "import ${spec#py_}" >/dev/null 2>&1 && spec="" || spec="MISSING" ;;
            */*)    [ -x "$spec" ] && spec="" || spec="MISSING" ;;
            *)      tool_present "$spec" && spec=$(tool_version "$spec") || spec="MISSING" ;;
        esac
        if [ "$spec" = "MISSING" ]; then
            printf "%-16s %-10s %s\n" "$name" "MISSING" "-"; miss=$((miss+1))
        else
            printf "%-16s %-10s %s\n" "$name" "OK" "${spec:--}"; ok=$((ok+1))
        fi
    done
    echo "----"
    echo "已安装 $ok，缺失 $miss。安装全部: tools-manager.sh install all；核心集: install core"
}

do_install_one() {
    local name="$1" e
    if e=$(entry_of APT_TOOLS "$name"); then
        tool_present "$(check_cmd_for "$e")" && { echo "[skip] $name 已安装"; return 0; }
        echo "[apt] 安装 $name ($(field 2 "$e"))"
        $SUDO apt-get update -qq
        $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y "$(field 2 "$e")"
    elif e=$(entry_of GO_TOOLS "$name"); then
        command -v "$name" >/dev/null 2>&1 && { echo "[skip] $name 已安装"; return 0; }
        command -v go >/dev/null 2>&1 || { echo "[fail] $name 需要 Go，请先运行 setup.sh"; return 1; }
        echo "[go] 安装 $name ($(field 2 "$e")@latest)"
        $SUDO env GOBIN="$GOBIN" PATH="$PATH" go install "$(field 2 "$e")@latest"
    elif e=$(entry_of PIP_TOOLS "$name"); then
        tool_present "$(check_cmd_for "$e")" && { echo "[skip] $name 已安装"; return 0; }
        [ -x "$VENV/bin/pip" ] || { echo "[fail] $name 需要应用 venv，请先运行 setup.sh"; return 1; }
        echo "[pip] 安装 $name ($(field 2 "$e")) → venv"
        "$VENV/bin/pip" install -q "$(field 2 "$e")"
    elif is_special "$name"; then
        install_special "$name"
    elif is_manual "$name"; then
        echo "[manual] $name 需手动安装，见 tools-manager.sh list"
        return 1
    else
        echo "[fail] 未知工具: $name"
        return 1
    fi
}

do_update_one() {
    local name="$1" e
    if e=$(entry_of APT_TOOLS "$name"); then
        echo "[apt] 更新 $name"
        $SUDO apt-get update -qq
        $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade "$(field 2 "$e")"
    elif e=$(entry_of GO_TOOLS "$name"); then
        echo "[go] 更新 $name → latest"
        $SUDO env GOBIN="$GOBIN" PATH="$PATH" go install "$(field 2 "$e")@latest"
    elif e=$(entry_of PIP_TOOLS "$name"); then
        echo "[pip] 更新 $name"
        "$VENV/bin/pip" install -q --upgrade "$(field 2 "$e")"
    elif [ "$name" = "seclists" ]; then
        echo "[git] 更新 SecLists"
        $SUDO git -C /usr/share/seclists pull --ff-only || true
    elif [ "$name" = "x8" ] || [ "$name" = "pwninit" ] || [ "$name" = "cloudmapper" ] || [ "$name" = "falco" ] || [ "$name" = "wpscan" ] || [ "$name" = "responder" ]; then
        echo "[reinstall] $name 更新即重装"
        case "$name" in
            x8|pwninit) $SUDO rm -f /usr/local/bin/$name ;;
            cloudmapper) $SUDO rm -f /usr/local/bin/cloudmapper; sudo git -C /usr/share/cloudmapper pull --ff-only || true ;;
            falco) $SUDO apt-get update -qq && $SUDO apt-get install -y --only-upgrade falco; return 0 ;;
            wpscan) $SUDO gem update wpscan --no-document; return 0 ;;
            responder) $SUDO git -C /opt/Responder pull --ff-only; return 0 ;;
        esac
        install_special "$name"
    elif [ "$name" = "enum4linux-ng" ]; then
        echo "[pip] 更新 enum4linux-ng"
        "$VENV/bin/pip" install -q --upgrade 'git+https://github.com/cddmp/enum4linux-ng.git'
    elif [ "$name" = "paramspider" ]; then
        echo "[git+pip] 更新 ParamSpider"
        $SUDO git -C /usr/share/paramspider pull --ff-only || true
        "$VENV/bin/pip" install -q --upgrade /usr/share/paramspider
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
