#!/bin/bash
# ==============================================================================
#  SilkSpool DNS 管理模块 (v3 - 重构版)
#  功能: 管理内网域名解析，同时更新:
#    1. iStoreOS dnsmasq (/etc/dnsmasq.conf) - 主 DNS 服务器
#    2. iStoreOS OpenClash (openclash_custom_hosts.list) - 代理模式 DNS
#    3. TXHK Headscale (config.yaml) - VPN 远程访问 DNS
#
#  站点管理 (site 子命令):
#    4. Caddy (Caddyfile) - 反向代理配置
#    5. Homepage (services.yaml) - 仪表盘入口
#
#  优化说明:
#    - 所有配置项从 config.ini 读取，无硬编码
#    - 文件推送复用 sync.sh 模块
#    - 服务重启复用 service.sh 模块
#    - push 分离为"推送文件"和"提示重启"两步
# ==============================================================================

BASE_DIR=$(cd "$(dirname "$0")/../.." && pwd)
LIB_DIR="$BASE_DIR/lib/core"
source "$BASE_DIR/config.ini"
source "$LIB_DIR/utils.sh"

# ==================== 配置路径 (从 config.ini 读取) ====================
# 网关主机
GATEWAY_HOST="${DNS_GATEWAY_HOST:-istoreos}"
HEADSCALE_HOST="${DNS_HEADSCALE_HOST:-txhk}"

# 默认 IP
DEFAULT_IP="${DNS_GATEWAY_IP:-192.168.1.1}"
HEADSCALE_DNS="${DNS_HEADSCALE_SERVER:-100.100.100.100}"

# 本地配置文件路径 (基于 hosts/<host>/ 目录)
DNSMASQ_CONFIG="$BASE_DIR/hosts/$GATEWAY_HOST/${DNS_DNSMASQ_LOCAL:-dnsmasq/dnsmasq.conf}"
OPENCLASH_HOSTS="$BASE_DIR/hosts/$GATEWAY_HOST/${DNS_OPENCLASH_LOCAL:-openclash/hosts.list}"
HEADSCALE_CONFIG="$BASE_DIR/hosts/$HEADSCALE_HOST/${DNS_HEADSCALE_LOCAL:-headscale/config.yaml}"
CADDY_CONFIG="$BASE_DIR/hosts/$GATEWAY_HOST/${DNS_CADDY_LOCAL:-caddy/Caddyfile}"
HOMEPAGE_CONFIG="$BASE_DIR/hosts/$GATEWAY_HOST/${DNS_HOMEPAGE_LOCAL:-homepage/services.yaml}"

# ==================== 工具函数 ====================
ensure_local_dirs() {
    mkdir -p "$(dirname "$DNSMASQ_CONFIG")"
    mkdir -p "$(dirname "$OPENCLASH_HOSTS")"
}

# ==================== dnsmasq 本地操作 ====================
dnsmasq_add_domain() {
    local domain=$1
    local ip=$2

    [ ! -f "$DNSMASQ_CONFIG" ] && return 1

    if grep -q "address=/$domain/" "$DNSMASQ_CONFIG" 2>/dev/null; then
        sed -i "s|address=/$domain/.*|address=/$domain/$ip|" "$DNSMASQ_CONFIG"
    else
        echo "address=/$domain/$ip" >> "$DNSMASQ_CONFIG"
    fi
}

dnsmasq_remove_domain() {
    local domain=$1
    [ -f "$DNSMASQ_CONFIG" ] && sed -i "/address=\\/$domain\\//d" "$DNSMASQ_CONFIG"
}

# ==================== OpenClash 本地操作 ====================
openclash_add_domain() {
    local domain=$1
    local ip=$2

    [ ! -f "$OPENCLASH_HOSTS" ] && return 1

    if grep -q "'$domain'" "$OPENCLASH_HOSTS" 2>/dev/null; then
        sed -i "s|'$domain':.*|'$domain': $ip|" "$OPENCLASH_HOSTS"
    else
        [ -s "$OPENCLASH_HOSTS" ] && [ "$(tail -c1 "$OPENCLASH_HOSTS")" != "" ] && echo "" >> "$OPENCLASH_HOSTS"
        echo "'$domain': $ip" >> "$OPENCLASH_HOSTS"
    fi
}

openclash_remove_domain() {
    local domain=$1
    [ -f "$OPENCLASH_HOSTS" ] && sed -i "/'$domain'/d" "$OPENCLASH_HOSTS"
}

# ==================== Headscale 本地操作 ====================
headscale_add_domain() {
    local domain=$1
    local ip=$2

    [ ! -f "$HEADSCALE_CONFIG" ] && return 1

    local tmp_file="${HEADSCALE_CONFIG}.tmp"

    # 1. 添加到 split DNS
    if ! grep -q "^        $domain:" "$HEADSCALE_CONFIG" 2>/dev/null; then
        local split_insert_line=$(grep -n "          - $HEADSCALE_DNS" "$HEADSCALE_CONFIG" | tail -1 | cut -d: -f1)
        if [ -n "$split_insert_line" ] && [ "$split_insert_line" -gt 0 ]; then
            head -n "$split_insert_line" "$HEADSCALE_CONFIG" > "$tmp_file"
            echo "        $domain:" >> "$tmp_file"
            echo "          - $HEADSCALE_DNS" >> "$tmp_file"
            tail -n +$((split_insert_line + 1)) "$HEADSCALE_CONFIG" >> "$tmp_file"
            mv "$tmp_file" "$HEADSCALE_CONFIG"
        fi
    fi

    # 2. 添加到 extra_records
    if ! grep -q "name: \"$domain\"" "$HEADSCALE_CONFIG" 2>/dev/null; then
        local record_insert_line=$(grep -n "value: \"$DEFAULT_IP\"" "$HEADSCALE_CONFIG" | tail -1 | cut -d: -f1)
        if [ -n "$record_insert_line" ] && [ "$record_insert_line" -gt 0 ]; then
            head -n "$record_insert_line" "$HEADSCALE_CONFIG" > "$tmp_file"
            echo "      - name: \"$domain\"" >> "$tmp_file"
            echo "        type: \"A\"" >> "$tmp_file"
            echo "        value: \"$ip\"" >> "$tmp_file"
            tail -n +$((record_insert_line + 1)) "$HEADSCALE_CONFIG" >> "$tmp_file"
            mv "$tmp_file" "$HEADSCALE_CONFIG"
        fi
    fi
}

headscale_remove_domain() {
    local domain=$1

    [ ! -f "$HEADSCALE_CONFIG" ] && return 1

    # 从 split DNS 中删除
    local split_line=$(grep -n "^        $domain:" "$HEADSCALE_CONFIG" | cut -d: -f1)
    if [ -n "$split_line" ]; then
        local next_line=$((split_line + 1))
        sed -i "${split_line},${next_line}d" "$HEADSCALE_CONFIG"
    fi

    # 从 extra_records 中删除
    local name_line=$(grep -n "name: \"$domain\"" "$HEADSCALE_CONFIG" | cut -d: -f1)
    if [ -n "$name_line" ]; then
        local end_line=$((name_line + 2))
        sed -i "${name_line},${end_line}d" "$HEADSCALE_CONFIG"
    fi
}

# ==================== Caddy 本地操作 ====================
caddy_add_site() {
    local domain=$1
    local backend=$2

    [ ! -f "$CADDY_CONFIG" ] && return 1

    if grep -q "^$domain {" "$CADDY_CONFIG" 2>/dev/null; then
        log_warn "Caddy: Site $domain already exists"
        return 0
    fi

    [[ "$backend" != http* ]] && backend="http://$backend"

    local caddy_block="
$domain {
    import common
    import authelia
    reverse_proxy $backend
}
"
    echo "$caddy_block" >> "$CADDY_CONFIG"
    log_success "Caddy: Added $domain -> $backend"
}

caddy_remove_site() {
    local domain=$1

    [ ! -f "$CADDY_CONFIG" ] && return 1

    awk -v domain="$domain" '
        $0 ~ "^" domain " \\{" { skip = 1; next }
        skip && /^}$/ { skip = 0; next }
        skip { next }
        { print }
    ' "$CADDY_CONFIG" > "${CADDY_CONFIG}.tmp" && mv "${CADDY_CONFIG}.tmp" "$CADDY_CONFIG"
}

# ==================== Homepage 本地操作 ====================
homepage_add_site() {
    local domain=$1
    local name=$2
    local description=$3
    local icon=${4:-mdi-application}
    local category=${5:-Services}

    [ ! -f "$HOMEPAGE_CONFIG" ] && return 1

    if grep -q "href: https://$domain" "$HOMEPAGE_CONFIG" 2>/dev/null; then
        log_warn "Homepage: Site $domain already exists"
        return 0
    fi

    local entry="
    - $name:
        href: https://$domain
        description: $description
        icon: $icon
        ping: https://$domain"

    local category_line=$(grep -n "^- $category:" "$HOMEPAGE_CONFIG" | head -1 | cut -d: -f1)

    if [ -n "$category_line" ]; then
        local next_category_line=$(awk -v start="$category_line" 'NR > start && /^- / {print NR; exit}' "$HOMEPAGE_CONFIG")

        if [ -n "$next_category_line" ]; then
            local insert_line=$((next_category_line - 1))
            head -n "$insert_line" "$HOMEPAGE_CONFIG" > "${HOMEPAGE_CONFIG}.tmp"
            echo "$entry" >> "${HOMEPAGE_CONFIG}.tmp"
            tail -n +$next_category_line "$HOMEPAGE_CONFIG" >> "${HOMEPAGE_CONFIG}.tmp"
            mv "${HOMEPAGE_CONFIG}.tmp" "$HOMEPAGE_CONFIG"
        else
            echo "$entry" >> "$HOMEPAGE_CONFIG"
        fi
        log_success "Homepage: Added $name ($domain)"
    else
        log_warn "Homepage: Category '$category' not found, appending to end of file"
        echo "$entry" >> "$HOMEPAGE_CONFIG"
    fi
}

homepage_remove_site() {
    local domain=$1

    [ ! -f "$HOMEPAGE_CONFIG" ] && return 1

    local href_line=$(grep -n "href: https://$domain" "$HOMEPAGE_CONFIG" | head -1 | cut -d: -f1)

    if [ -n "$href_line" ]; then
        local name_line=$((href_line - 1))
        local end_line=$(awk -v start="$href_line" 'NR > start && (/^    - / || /^- /) {print NR - 1; exit}' "$HOMEPAGE_CONFIG")
        [ -z "$end_line" ] && end_line=$(wc -l < "$HOMEPAGE_CONFIG")
        sed -i "${name_line},${end_line}d" "$HOMEPAGE_CONFIG"
    fi
}

# ==================== DNS 核心命令 ====================

dns_list() {
    echo -e "${BLUE}=== Internal DNS Records ===${NC}"

    if [ -f "$DNSMASQ_CONFIG" ]; then
        echo -e "\n${YELLOW}[dnsmasq]${NC} $DNSMASQ_CONFIG"
        grep "^address=/" "$DNSMASQ_CONFIG" | while read -r line; do
            domain=$(echo "$line" | sed 's|address=/\([^/]*\)/.*|\1|')
            ip=$(echo "$line" | sed 's|address=/[^/]*/||')
            printf "  %-35s -> %s\n" "$domain" "$ip"
        done
    fi

    if [ -f "$OPENCLASH_HOSTS" ]; then
        echo -e "\n${YELLOW}[OpenClash]${NC} $OPENCLASH_HOSTS"
        local oc_count=$(grep -c "^'" "$OPENCLASH_HOSTS" 2>/dev/null || echo "0")
        echo "  $oc_count domains configured"
    fi

    if [ -f "$HEADSCALE_CONFIG" ]; then
        echo -e "\n${YELLOW}[Headscale]${NC} $HEADSCALE_CONFIG"
        local hs_count=$(grep -c "name: \".*\.${DEFAULT_DOMAIN}\"" "$HEADSCALE_CONFIG" 2>/dev/null || echo "0")
        echo "  $hs_count domains configured"
    fi

    echo ""
    echo -e "${GREEN}Hint:${NC} ./spool.sh dns add <domain> [ip] to add domain"
}

dns_add() {
    local domain=$1
    local ip=${2:-$DEFAULT_IP}

    if [ -z "$domain" ]; then
        log_err "Usage: dns add <domain> [ip]"
        echo "Example: dns add firecrawl.\$DEFAULT_DOMAIN"
        exit 1
    fi

    ensure_local_dirs

    echo -e "${BLUE}=== Adding DNS record: $domain -> $ip ===${NC}"

    # 1. dnsmasq (如果配置不存在则先拉取)
    if [ ! -f "$DNSMASQ_CONFIG" ]; then
        log_info "dnsmasq config not found, pulling..."
        bash "$LIB_DIR/sync.sh" pull "$GATEWAY_HOST" 2>/dev/null
    fi
    dnsmasq_add_domain "$domain" "$ip" && log_success "dnsmasq: $domain"

    # 2. OpenClash (如果配置不存在则先拉取)
    if [ ! -f "$OPENCLASH_HOSTS" ]; then
        log_info "OpenClash config not found, pulling..."
        bash "$LIB_DIR/sync.sh" pull "$GATEWAY_HOST" 2>/dev/null
    fi
    openclash_add_domain "$domain" "$ip" && log_success "OpenClash: $domain"

    # 3. Headscale
    if [ -f "$HEADSCALE_CONFIG" ]; then
        headscale_add_domain "$domain" "$ip" && log_success "Headscale: $domain"
    else
        log_warn "Headscale config not found, skipping (run: ./spool.sh sync pull $HEADSCALE_HOST)"
    fi

    echo ""
    log_info "Config modified. Use './spool.sh dns push' to push to remote"
}

dns_remove() {
    local domain=$1

    if [ -z "$domain" ]; then
        log_err "Usage: dns remove <domain>"
        exit 1
    fi

    echo -e "${BLUE}=== Removing DNS record: $domain ===${NC}"

    dnsmasq_remove_domain "$domain" && log_success "dnsmasq: removed"
    openclash_remove_domain "$domain" && log_success "OpenClash: removed"
    headscale_remove_domain "$domain" && log_success "Headscale: removed"

    echo ""
    log_info "Config modified. Use './spool.sh dns push' to push to remote"
}

dns_pull() {
    echo -e "${BLUE}=== Pulling DNS config ===${NC}"

    log_step "Pulling $GATEWAY_HOST config (dnsmasq, OpenClash)..."
    bash "$LIB_DIR/sync.sh" pull "$GATEWAY_HOST"

    log_step "Pulling $HEADSCALE_HOST config (Headscale)..."
    bash "$LIB_DIR/sync.sh" pull "$HEADSCALE_HOST"

    log_success "DNS config pulled to local"
}

dns_push() {
    echo -e "${BLUE}=== Pushing DNS config ===${NC}"

    # 1. 推送到网关主机 (dnsmasq, openclash)
    log_step "Pushing to $GATEWAY_HOST..."
    bash "$LIB_DIR/sync.sh" push "$GATEWAY_HOST"

    # 2. 推送到 Headscale 主机
    if [ -f "$HEADSCALE_CONFIG" ]; then
        log_step "Pushing to $HEADSCALE_HOST..."
        bash "$LIB_DIR/sync.sh" push "$HEADSCALE_HOST"
    fi

    echo ""
    log_success "DNS config pushed"
    echo ""
    echo -e "${YELLOW}Hint: Config files pushed. To reload services run:${NC}"
    echo "  ./spool.sh restart $GATEWAY_HOST dnsmasq openclash"
    [ -f "$HEADSCALE_CONFIG" ] && echo "  ./spool.sh restart $HEADSCALE_HOST headscale"
}

dns_deploy() {
    local domain=$1
    local ip=${2:-$DEFAULT_IP}

    if [ -z "$domain" ]; then
        log_err "Usage: dns deploy <domain> [ip]"
        echo "Example: dns deploy couchdb.singll.net"
        echo ""
        echo "This command will:"
        echo "  1. Add DNS record to local configs"
        echo "  2. Push configs to remote servers"
        echo "  3. Restart DNS services (dnsmasq, openclash, headscale)"
        exit 1
    fi

    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  DNS One-Click Deploy: $domain${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""

    # Step 1: Add DNS record
    log_step "Step 1/3: Adding DNS record..."
    dns_add "$domain" "$ip"

    # Step 2: Push to remote
    log_step "Step 2/3: Pushing configs to remote servers..."
    dns_push

    # Step 3: Restart services
    log_step "Step 3/3: Restarting DNS services..."
    echo ""

    # Restart gateway DNS services
    log_info "Restarting $GATEWAY_HOST services..."
    bash "$LIB_DIR/service.sh" restart "$GATEWAY_HOST" dnsmasq
    bash "$LIB_DIR/service.sh" restart "$GATEWAY_HOST" openclash

    # Restart Headscale if configured
    if [ -f "$HEADSCALE_CONFIG" ]; then
        log_info "Restarting $HEADSCALE_HOST services..."
        bash "$LIB_DIR/service.sh" restart "$HEADSCALE_HOST" headscale
    fi

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  DNS Deploy Complete!                  ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo "Domain $domain -> $ip is now active on:"
    echo "  - Internal: dnsmasq + OpenClash ($GATEWAY_HOST)"
    [ -f "$HEADSCALE_CONFIG" ] && echo "  - VPN: Headscale ($HEADSCALE_HOST)"
}

dns_sync_caddy() {
    if [ ! -f "$CADDY_CONFIG" ]; then
        log_err "Caddyfile not found: $CADDY_CONFIG"
        exit 1
    fi

    ensure_local_dirs

    # 确保本地配置存在
    [ ! -f "$DNSMASQ_CONFIG" ] && bash "$LIB_DIR/sync.sh" pull "$GATEWAY_HOST" 2>/dev/null
    [ ! -f "$OPENCLASH_HOSTS" ] && bash "$LIB_DIR/sync.sh" pull "$GATEWAY_HOST" 2>/dev/null

    log_step "Syncing domains from Caddyfile..."

    local caddy_domains=$(grep -E "^[a-z0-9].*\.${DEFAULT_DOMAIN}" "$CADDY_CONFIG" | sed 's/ {.*//' | sort -u)
    local added=0

    for domain in $caddy_domains; do
        if ! grep -q "address=/$domain/" "$DNSMASQ_CONFIG" 2>/dev/null; then
            dns_add "$domain" "$DEFAULT_IP"
            ((added++))
        fi
    done

    if [ $added -eq 0 ]; then
        log_info "All domains already synced"
    else
        log_success "Synced $added domains"
        echo ""
        read -p "Push now? [y/N] " -n 1 -r
        echo
        [[ $REPLY =~ ^[Yy]$ ]] && dns_push
    fi
}

# ==================== Site 核心命令 ====================

site_add() {
    local domain=$1
    local backend=$2
    local name=$3
    local description=${4:-""}
    local icon=${5:-mdi-application}
    local category=${6:-Services}

    if [ -z "$domain" ] || [ -z "$backend" ] || [ -z "$name" ]; then
        log_err "Usage: site add <domain> <backend> <name> [description] [icon] [category]"
        echo ""
        echo "Parameters:"
        echo "  domain      Domain name (e.g. myapp.example.com)"
        echo "  backend     Backend address (e.g. 192.168.1.10:8080)"
        echo "  name        Display name (e.g. MyApp)"
        echo "  description Description (optional)"
        echo "  icon        Icon (optional, default mdi-application)"
        echo "  category    Homepage category (optional, default 'Services')"
        echo ""
        echo "Example:"
        echo "  ./spool.sh site add myapp.example.com 192.168.1.10:8080 MyApp 'My App' mdi-apps"
        exit 1
    fi

    [ -z "$description" ] && description="$name service"

    echo -e "${BLUE}=== Adding site: $domain ===${NC}"

    # 1. 添加 DNS (已包含拉取逻辑)
    dns_add "$domain" "$DEFAULT_IP"

    # 2. 添加 Caddy
    caddy_add_site "$domain" "$backend"

    # 3. 添加 Homepage
    homepage_add_site "$domain" "$name" "$description" "$icon" "$category"

    echo ""
    log_success "Site config generated"
    log_info "Use './spool.sh site push' to push all configs"
}

site_remove() {
    local domain=$1

    if [ -z "$domain" ]; then
        log_err "Usage: site remove <domain>"
        exit 1
    fi

    echo -e "${BLUE}=== Removing site: $domain ===${NC}"

    dns_remove "$domain"
    caddy_remove_site "$domain" && log_success "Caddy: removed"
    homepage_remove_site "$domain" && log_success "Homepage: removed"

    echo ""
    log_info "Use './spool.sh site push' to push config"
}

site_push() {
    echo -e "${BLUE}=== Pushing site config ===${NC}"

    # 1. 推送所有配置到网关主机 (包含 DNS, Caddy, Homepage)
    log_step "Pushing to $GATEWAY_HOST..."
    bash "$LIB_DIR/sync.sh" push "$GATEWAY_HOST"

    # 2. 推送 Headscale 配置
    if [ -f "$HEADSCALE_CONFIG" ]; then
        log_step "Pushing to $HEADSCALE_HOST..."
        bash "$LIB_DIR/sync.sh" push "$HEADSCALE_HOST"
    fi

    echo ""
    log_success "Site config pushed"
    echo ""
    echo -e "${YELLOW}Hint: Config files pushed. To reload services run:${NC}"
    echo "  ./spool.sh restart $GATEWAY_HOST dnsmasq openclash caddy homepage"
    [ -f "$HEADSCALE_CONFIG" ] && echo "  ./spool.sh restart $HEADSCALE_HOST headscale"
}

site_deploy() {
    local domain=$1
    local backend=$2
    local name=$3
    local description=${4:-""}
    local icon=${5:-mdi-application}
    local category=${6:-Services}

    if [ -z "$domain" ] || [ -z "$backend" ] || [ -z "$name" ]; then
        log_err "Usage: site deploy <domain> <backend> <name> [description] [icon] [category]"
        echo ""
        echo "This command will:"
        echo "  1. Add DNS record (dnsmasq, OpenClash, Headscale)"
        echo "  2. Add Caddy reverse proxy"
        echo "  3. Add Homepage dashboard entry"
        echo "  4. Push all configs to remote"
        echo "  5. Restart all services"
        echo ""
        echo "Example:"
        echo "  ./spool.sh site deploy myapp.singll.net 192.168.1.10:8080 MyApp 'My App'"
        exit 1
    fi

    [ -z "$description" ] && description="$name service"

    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Site One-Click Deploy: $name${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""

    # Step 1: Add site config
    log_step "Step 1/3: Adding site configuration..."
    site_add "$domain" "$backend" "$name" "$description" "$icon" "$category"

    # Step 2: Push to remote
    log_step "Step 2/3: Pushing configs to remote servers..."
    site_push

    # Step 3: Restart services
    log_step "Step 3/3: Restarting services..."
    echo ""

    # Restart gateway services
    log_info "Restarting $GATEWAY_HOST services..."
    bash "$LIB_DIR/service.sh" restart "$GATEWAY_HOST" dnsmasq
    bash "$LIB_DIR/service.sh" restart "$GATEWAY_HOST" openclash
    bash "$LIB_DIR/service.sh" restart "$GATEWAY_HOST" caddy
    bash "$LIB_DIR/service.sh" restart "$GATEWAY_HOST" homepage

    # Restart Headscale if configured
    if [ -f "$HEADSCALE_CONFIG" ]; then
        log_info "Restarting $HEADSCALE_HOST services..."
        bash "$LIB_DIR/service.sh" restart "$HEADSCALE_HOST" headscale
    fi

    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  Site Deploy Complete!                 ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo "Site $name is now live:"
    echo "  URL:     https://$domain"
    echo "  Backend: $backend"
    echo ""
    echo "Active on:"
    echo "  - DNS: dnsmasq + OpenClash ($GATEWAY_HOST)"
    echo "  - Proxy: Caddy ($GATEWAY_HOST)"
    echo "  - Dashboard: Homepage ($GATEWAY_HOST)"
    [ -f "$HEADSCALE_CONFIG" ] && echo "  - VPN DNS: Headscale ($HEADSCALE_HOST)"
}

site_list() {
    echo -e "${BLUE}=== Configured Sites ===${NC}"

    if [ -f "$CADDY_CONFIG" ]; then
        echo -e "\n${YELLOW}[Caddy Reverse Proxy]${NC}"
        grep -E "^[a-z0-9].*\.${DEFAULT_DOMAIN} \{" "$CADDY_CONFIG" | sed 's/ {//' | while read -r domain; do
            local backend=$(grep -A5 "^$domain {" "$CADDY_CONFIG" | grep "reverse_proxy" | head -1 | awk '{print $2}')
            printf "  %-35s -> %s\n" "$domain" "$backend"
        done
    fi

    if [ -f "$HOMEPAGE_CONFIG" ]; then
        echo -e "\n${YELLOW}[Homepage Dashboard]${NC}"
        local hp_count=$(grep -c "href: https://.*\.${DEFAULT_DOMAIN}" "$HOMEPAGE_CONFIG" 2>/dev/null || echo "0")
        echo "  $hp_count service entries configured"
    fi

    echo ""
    echo -e "${GREEN}Hint:${NC} ./spool.sh site add <domain> <backend> <name> to add site"
}

# ==================== 帮助信息 ====================
dns_help() {
    echo -e "${BLUE}========= DNS Management Tool =========${NC}"
    echo "Usage: ./spool.sh dns <command> [args]"
    echo ""
    echo -e "${GREEN}Quick Commands (Recommended):${NC}"
    echo "  deploy <domain> [ip]    One-click: add + push + restart all services"
    echo ""
    echo "Step-by-Step Commands:"
    echo "  add <domain> [ip]       Add domain to local configs"
    echo "  push                    Push config to remote servers"
    echo ""
    echo "Other Commands:"
    echo "  list                    List all DNS records"
    echo "  remove <domain>         Remove domain"
    echo "  pull                    Pull config from remote"
    echo "  sync-caddy              Sync missing domains from Caddyfile"
    echo ""
    echo "Examples:"
    echo "  ./spool.sh dns deploy couchdb.singll.net           # One-click deploy"
    echo "  ./spool.sh dns deploy myapp.singll.net 10.0.0.5    # With custom IP"
    echo ""
    echo "Config files (local):"
    echo "  dnsmasq:   $DNSMASQ_CONFIG"
    echo "  OpenClash: $OPENCLASH_HOSTS"
    echo "  Headscale: $HEADSCALE_CONFIG"
}

site_help() {
    echo -e "${BLUE}========= Site Management Tool =========${NC}"
    echo "Usage: ./spool.sh site <command> [args]"
    echo ""
    echo -e "${GREEN}Quick Commands (Recommended):${NC}"
    echo "  deploy <domain> <backend> <name> [desc] [icon]"
    echo "         One-click: add DNS + Caddy + Homepage + push + restart"
    echo ""
    echo "Step-by-Step Commands:"
    echo "  add <domain> <backend> <name> [desc] [icon]   Add site to local configs"
    echo "  push                                          Push all configs"
    echo ""
    echo "Other Commands:"
    echo "  list                    List all sites"
    echo "  remove <domain>         Remove site"
    echo ""
    echo "Examples:"
    echo "  ./spool.sh site deploy myapp.singll.net 192.168.7.100:8080 MyApp 'My Application'"
    echo "  ./spool.sh site list"
}

# ==================== 主入口 ====================
CMD=$1; shift

case "$CMD" in
    # DNS 命令
    list|ls)      dns_list ;;
    add)          dns_add "$@" ;;
    deploy)       dns_deploy "$@" ;;
    remove|rm)    dns_remove "$@" ;;
    pull)         dns_pull ;;
    push)         dns_push ;;
    sync-caddy)   dns_sync_caddy ;;

    # Site 命令 (通过 spool.sh site 调用)
    site-list)    site_list ;;
    site-add)     site_add "$@" ;;
    site-deploy)  site_deploy "$@" ;;
    site-remove)  site_remove "$@" ;;
    site-push)    site_push ;;
    site-help)    site_help ;;

    help|--help)  dns_help ;;
    *)            dns_help ;;
esac
