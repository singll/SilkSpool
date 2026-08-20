#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 安全工具管理器（spool bundle 推送，远程按需执行）
# 用法：
#   bash tools-manager.sh install [tool ...]   安装（默认装 tools.list 全部，幂等跳过已装）
#   bash tools-manager.sh upgrade [tool ...]   升级（go/bin 通道重装到最新）
#   bash tools-manager.sh remove  <tool ...>   卸载
#   bash tools-manager.sh status               清单核对（已装/缺失/版本）
# 清单格式见 tools.list：name|channel|install_spec|verify_cmd
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
LIST_FILE="$BASE_DIR/tools.list"
GOBIN="/usr/local/bin"
export PATH="/usr/local/go/bin:$GOBIN:$PATH"

log()  { echo "[tools] $*"; }
warn() { echo "[tools][WARN] $*"; }
err()  { echo "[tools][ERROR] $*" >&2; }

SUDO=''
if [ "$(id -u)" -ne 0 ]; then SUDO='sudo'; fi

[ -f "$LIST_FILE" ] || { err "清单不存在: $LIST_FILE"; exit 1; }

# -------------------- 清单解析 --------------------
# get_spec <name> → "channel|install_spec|verify_cmd"
get_spec() {
    awk -F'|' -v n="$1" '!/^#/ && NF>=4 && $1==n {print $2"|"$3"|"$4; exit}' "$LIST_FILE"
}

list_all() {
    awk -F'|' '!/^#/ && NF>=4 {print $1}' "$LIST_FILE"
}

bin_path() { echo "$GOBIN/$1"; }

is_installed() { [ -x "$(bin_path "$1")" ]; }

# -------------------- 通道安装器 --------------------
install_go() {
    local name="$1" spec="$2"
    case "$spec" in *@*) ;; *) spec="$spec@latest" ;; esac
    log "go install $spec"
    local tmpdir
    tmpdir=$(mktemp -d)
    # 先构建到临时 GOBIN，再提权拷贝，避免 sudo 环境污染
    GOBIN="$tmpdir" go install "$spec"
    $SUDO install -m 0755 "$tmpdir/$name" "$(bin_path "$name")"
    rm -rf "$tmpdir"
}

install_bin() {
    local name="$1" spec="$2"
    local repo="$spec" tag=""
    case "$spec" in *@*) repo="${spec%@*}"; tag="${spec##*@}" ;; esac
    local arch
    case "$(uname -m)" in
        x86_64)  arch="amd64|x86_64|x64" ;;
        aarch64) arch="arm64|aarch64" ;;
        *) err "不支持的架构: $(uname -m)"; return 1 ;;
    esac
    local api
    if [ -n "$tag" ]; then
        api="https://api.github.com/repos/$repo/releases/tags/$tag"
        log "下载 $repo@$tag (linux/$arch)"
    else
        api="https://api.github.com/repos/$repo/releases/latest"
        log "下载 $repo latest release (linux/$arch)"
    fi
    local url
    url=$(curl -fsSL --connect-timeout 15 "$api" \
        | python3 -c '
import json, sys, re
d = json.load(sys.stdin)
arch_re = re.compile(sys.argv[1], re.I)
for a in d.get("assets", []):
    n = a["name"]
    if "linux" in n.lower() and arch_re.search(n) and not n.endswith((".sig", ".sha256", ".md5", ".txt", ".deb", ".rpm", ".msi")):
        print(a["browser_download_url"]); break
' "$arch")
    [ -n "$url" ] || { err "$repo 未找到匹配的 release 资产"; return 1; }
    local tmpdir
    tmpdir=$(mktemp -d)
    curl -fsSL "$url" -o "$tmpdir/pkg"
    case "$url" in
        *.zip)    (cd "$tmpdir" && python3 -c 'import zipfile;zipfile.ZipFile("pkg").extractall()') ;;
        *.tar.gz|*.tgz) (cd "$tmpdir" && tar xzf pkg) ;;
        *)        (cd "$tmpdir" && mv pkg "$name") ;;
    esac
    local bin
    # 依次尝试：精确文件名 → 去掉常见后缀的文件名 → 最大的常规文件（zip 解压可能丢执行位，install 统一赋权）
    bin=$(find "$tmpdir" -maxdepth 3 -type f -name "$name" | head -1)
    [ -n "$bin" ] || bin=$(find "$tmpdir" -maxdepth 3 -type f -name "${name}_*" | head -1)
    [ -n "$bin" ] || bin=$(find "$tmpdir" -maxdepth 3 -type f ! -name pkg ! -name "*.txt" ! -name "*.md" -exec du -b {} + | sort -rn | head -1 | cut -f2)
    [ -n "$bin" ] || { err "$repo 解压后未找到可执行文件"; rm -rf "$tmpdir"; return 1; }
    $SUDO install -m 0755 "$bin" "$(bin_path "$name")"
    rm -rf "$tmpdir"
}

install_apt() {
    local name="$1" pkg="$2"
    log "apt install $pkg"
    $SUDO apt-get update -qq
    $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg"
}

do_install() {
    local name="$1" spec channel installer verify
    spec=$(get_spec "$name")
    [ -n "$spec" ] || { warn "$name 不在 tools.list 中，跳过"; return 0; }
    channel="${spec%%|*}"; rest="${spec#*|}"; installer="${rest%%|*}"; verify="${rest##*|}"
    if is_installed "$name"; then
        log "$name 已安装，跳过（upgrade 可强制重装）"
        return 0
    fi
    case "$channel" in
        go)  install_go "$name" "$installer" ;;
        bin) install_bin "$name" "$installer" ;;
        apt) install_apt "$name" "$installer" ;;
        *)   warn "$name 未知通道 $channel，跳过"; return 0 ;;
    esac
    if bash -c "$verify" >/dev/null 2>&1; then
        log "$name 安装成功 ✓"
    else
        warn "$name 已安装但验证命令失败: $verify"
    fi
}

do_upgrade() {
    local name="$1"
    if is_installed "$name"; then
        log "$name 重装升级"
        $SUDO rm -f "$(bin_path "$name")"
    fi
    do_install "$name"
}

do_remove() {
    local name="$1"
    if is_installed "$name"; then
        $SUDO rm -f "$(bin_path "$name")"
        log "$name 已卸载"
    else
        log "$name 未安装"
    fi
}

do_status() {
    local name installed_count=0 missing_count=0
    printf '%-16s %-8s %s\n' "TOOL" "STATE" "PATH"
    while IFS= read -r name; do
        if is_installed "$name"; then
            printf '%-16s %-8s %s\n' "$name" "installed" "$(bin_path "$name")"
            installed_count=$((installed_count+1))
        else
            printf '%-16s %-8s %s\n' "$name" "missing" "-"
            missing_count=$((missing_count+1))
        fi
    done < <(list_all)
    log "合计: installed=$installed_count missing=$missing_count"
}

# -------------------- 主流程 --------------------
ACTION="${1:-status}"; shift || true
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ] && [ "$ACTION" != "status" ]; then
    mapfile -t TARGETS < <(list_all)
fi

case "$ACTION" in
    install) for t in "${TARGETS[@]}"; do do_install "$t"; done ;;
    upgrade) for t in "${TARGETS[@]}"; do do_upgrade "$t"; done ;;
    remove)  [ ${#TARGETS[@]} -gt 0 ] || { err "remove 需要指定工具名"; exit 1; }
             for t in "${TARGETS[@]}"; do do_remove "$t"; done ;;
    status)  do_status ;;
    *) err "unknown action: $ACTION (install|upgrade|remove|status)"; exit 1 ;;
esac
log "完成"
