package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

// SiteManager 站点管理器: 编排 DNS + Caddy 反向代理 + Homepage 仪表盘三联动
type SiteManager struct {
	baseDir       string
	gatewayHost   string
	headscaleHost string
	defaultIP     string
	defaultDomain string
	sshKey        string
	caddyPath     string // 本地 Caddyfile 路径
	homepagePath  string // 本地 Homepage services.yaml 路径
	dns           *DNSManager
}

// Site 站点信息
type Site struct {
	Domain  string
	Backend string
	Name    string
	Desc    string
	Icon    string
}

// NewSiteManager 创建站点管理器
func NewSiteManager(baseDir string) (*SiteManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	dns, err := NewDNSManager(baseDir)
	if err != nil {
		return nil, err
	}

	gw := cfg.Global.DNSGatewayHost
	return &SiteManager{
		baseDir:       baseDir,
		gatewayHost:   gw,
		headscaleHost: cfg.Global.DNSHeadscaleHost,
		defaultIP:     cfg.Global.DNSGatewayIP,
		defaultDomain: cfg.Global.DefaultDomain,
		sshKey:        filepath.Join(baseDir, cfg.Global.SSHKeyPath),
		caddyPath:     filepath.Join(baseDir, "hosts", gw, "caddy", "Caddyfile"),
		homepagePath:  filepath.Join(baseDir, "hosts", gw, "homepage", "services.yaml"),
		dns:           dns,
	}, nil
}

// ==================== 站点编排 ====================

// AddSite 添加站点 (DNS + Caddy + Homepage)
func (m *SiteManager) AddSite(domain, backend, name, desc, icon string) error {
	if domain == "" || backend == "" || name == "" {
		return fmt.Errorf("usage: site add <domain> <backend> <name> [desc] [icon]")
	}
	if desc == "" {
		desc = name + " service"
	}
	if icon == "" {
		icon = "mdi-application"
	}

	utils.Step("Adding site: %s -> %s", domain, backend)

	// 1. DNS 记录 (dnsmasq + openclash + headscale)
	if err := m.dns.AddDomain(domain, m.defaultIP); err != nil {
		return fmt.Errorf("DNS add failed: %w", err)
	}

	// 2. Caddy 反向代理
	if err := m.caddyAddSite(domain, backend); err != nil {
		utils.Warn("Caddy add failed: %v", err)
	}

	// 3. Homepage 仪表盘入口
	if err := m.homepageAddSite(domain, name, desc, icon, "Services"); err != nil {
		utils.Warn("Homepage add failed: %v", err)
	}

	utils.Success("Site config generated: %s", domain)
	return nil
}

// RemoveSite 删除站点
func (m *SiteManager) RemoveSite(domain string) error {
	if domain == "" {
		return fmt.Errorf("usage: site remove <domain>")
	}

	utils.Step("Removing site: %s", domain)

	if err := m.dns.RemoveDomain(domain); err != nil {
		utils.Warn("DNS remove failed: %v", err)
	}
	if err := m.caddyRemoveSite(domain); err != nil {
		utils.Warn("Caddy remove failed: %v", err)
	}
	if err := m.homepageRemoveSite(domain); err != nil {
		utils.Warn("Homepage remove failed: %v", err)
	}

	utils.Success("Site removed: %s", domain)
	return nil
}

// DeploySite 一键部署: 添加 + 推送 + 重启
func (m *SiteManager) DeploySite(domain, backend, name, desc, icon string) error {
	utils.Step("Step 1/3: Adding site configuration...")
	if err := m.AddSite(domain, backend, name, desc, icon); err != nil {
		return err
	}

	utils.Step("Step 2/3: Pushing configs to remote...")
	if err := m.PushSites(); err != nil {
		return err
	}

	utils.Step("Step 3/3: Restarting services...")
	m.restartSiteServices()

	utils.Success("Site deploy complete: %s (https://%s)", name, domain)
	return nil
}

// PushSites 推送站点配置到远程 (网关主机 + Headscale)
func (m *SiteManager) PushSites() error {
	utils.Step("Pushing site configs to remote")

	syncMgr, err := NewSyncManager(m.baseDir)
	if err != nil {
		return err
	}

	if err := syncMgr.SyncHost(m.gatewayHost, "push"); err != nil {
		return fmt.Errorf("push to %s failed: %w", m.gatewayHost, err)
	}

	// Headscale 配置存在则一并推送
	if m.headscaleConfigExists() {
		if err := syncMgr.SyncHost(m.headscaleHost, "push"); err != nil {
			utils.Warn("push to %s failed: %v", m.headscaleHost, err)
		}
	}

	utils.Success("Site config pushed")
	return nil
}

// ListSites 列出所有站点 (从 Caddyfile 解析)
func (m *SiteManager) ListSites() ([]Site, error) {
	data, err := os.ReadFile(m.caddyPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read Caddyfile: %w", err)
	}

	lines := strings.Split(string(data), "\n")
	blockRe := regexp.MustCompile(`^([a-z0-9][-a-z0-9.]*\.` + regexp.QuoteMeta(m.defaultDomain) + `)\s*\{`)

	var sites []Site
	var current *Site
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		if mm := blockRe.FindStringSubmatch(trimmed); mm != nil {
			if current != nil {
				sites = append(sites, *current)
			}
			current = &Site{Domain: mm[1], Name: domainToName(mm[1])}
			continue
		}

		if current != nil {
			if strings.HasPrefix(trimmed, "reverse_proxy ") {
				current.Backend = strings.TrimSpace(strings.TrimPrefix(trimmed, "reverse_proxy "))
			}
			if trimmed == "}" {
				sites = append(sites, *current)
				current = nil
			}
		}
	}
	if current != nil {
		sites = append(sites, *current)
	}

	return sites, nil
}

// ==================== Caddy 本地操作 ====================

func (m *SiteManager) caddyAddSite(domain, backend string) error {
	data, err := os.ReadFile(m.caddyPath)
	if err != nil {
		return fmt.Errorf("Caddyfile not found: %s", m.caddyPath)
	}
	content := string(data)

	// 已存在则跳过
	if regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(domain) + `\s*\{`).MatchString(content) {
		utils.Info("Caddy: site %s already exists", domain)
		return nil
	}

	if !strings.HasPrefix(backend, "http") {
		backend = "http://" + backend
	}

	block := fmt.Sprintf("\n%s {\n    import common\n    reverse_proxy %s\n}\n", domain, backend)
	content += block

	if err := os.WriteFile(m.caddyPath, []byte(content), 0644); err != nil {
		return err
	}
	utils.Success("Caddy: added %s -> %s", domain, backend)
	return nil
}

func (m *SiteManager) caddyRemoveSite(domain string) error {
	data, err := os.ReadFile(m.caddyPath)
	if err != nil {
		return err
	}

	lines := strings.Split(string(data), "\n")
	startRe := regexp.MustCompile(`^` + regexp.QuoteMeta(domain) + `\s*\{`)

	var out []string
	skip := false
	for _, line := range lines {
		if !skip && startRe.MatchString(strings.TrimSpace(line)) {
			skip = true
			continue
		}
		if skip {
			if strings.TrimSpace(line) == "}" {
				skip = false
			}
			continue
		}
		out = append(out, line)
	}

	return os.WriteFile(m.caddyPath, []byte(strings.Join(out, "\n")), 0644)
}

// ==================== Homepage 本地操作 ====================

func (m *SiteManager) homepageAddSite(domain, name, desc, icon, category string) error {
	data, err := os.ReadFile(m.homepagePath)
	if err != nil {
		return fmt.Errorf("Homepage config not found: %s", m.homepagePath)
	}
	content := string(data)

	if strings.Contains(content, "href: https://"+domain) {
		utils.Info("Homepage: site %s already exists", domain)
		return nil
	}

	entry := fmt.Sprintf("    - %s:\n        href: https://%s\n        description: %s\n        icon: %s\n        ping: https://%s",
		name, domain, desc, icon, domain)

	lines := strings.Split(content, "\n")

	// 查找目标分类行 (顶层 "- Category:")
	catRe := regexp.MustCompile(`^- ` + regexp.QuoteMeta(category) + `:`)
	catLine := -1
	for i, line := range lines {
		if catRe.MatchString(line) {
			catLine = i
			break
		}
	}

	if catLine == -1 {
		// 分类不存在: 新建分类并追加
		utils.Warn("Homepage: category '%s' not found, creating it", category)
		content = strings.TrimRight(content, "\n") + "\n- " + category + ":\n" + entry + "\n"
		if err := os.WriteFile(m.homepagePath, []byte(content), 0644); err != nil {
			return err
		}
		utils.Success("Homepage: added %s (%s)", name, domain)
		return nil
	}

	// 找到该分类下一个顶层 "- " 的位置 (分类区块结束处)
	topRe := regexp.MustCompile(`^- `)
	nextCat := len(lines)
	for i := catLine + 1; i < len(lines); i++ {
		if topRe.MatchString(lines[i]) {
			nextCat = i
			break
		}
	}

	entryLines := strings.Split(entry, "\n")
	newLines := append([]string{}, lines[:nextCat]...)
	newLines = append(newLines, entryLines...)
	newLines = append(newLines, lines[nextCat:]...)

	if err := os.WriteFile(m.homepagePath, []byte(strings.Join(newLines, "\n")), 0644); err != nil {
		return err
	}
	utils.Success("Homepage: added %s (%s)", name, domain)
	return nil
}

func (m *SiteManager) homepageRemoveSite(domain string) error {
	data, err := os.ReadFile(m.homepagePath)
	if err != nil {
		return err
	}

	lines := strings.Split(string(data), "\n")

	hrefLine := -1
	for i, line := range lines {
		if strings.Contains(line, "href: https://"+domain) {
			hrefLine = i
			break
		}
	}
	if hrefLine == -1 {
		return nil // 不存在
	}

	// entry 起点: href 上一行 ("    - Name:")
	start := hrefLine - 1
	if start < 0 {
		start = 0
	}

	// entry 终点: 下一个列表项 ("- " 或 "    - ") 之前
	itemRe := regexp.MustCompile(`^\s*-\s`)
	end := len(lines)
	for i := hrefLine + 1; i < len(lines); i++ {
		if itemRe.MatchString(lines[i]) {
			end = i
			break
		}
	}

	newLines := append([]string{}, lines[:start]...)
	newLines = append(newLines, lines[end:]...)

	return os.WriteFile(m.homepagePath, []byte(strings.Join(newLines, "\n")), 0644)
}

// ==================== 内部辅助 ====================

// restartSiteServices 重启站点相关服务 (DNS + Caddy + Homepage + Headscale)
func (m *SiteManager) restartSiteServices() {
	svcMgr, err := NewServiceManager(m.baseDir)
	if err != nil {
		utils.Warn("Failed to init service manager: %v", err)
		return
	}

	for _, svc := range []string{"dnsmasq", "openclash", "caddy", "homepage"} {
		if err := svcMgr.RestartService(m.gatewayHost, svc); err != nil {
			utils.Warn("Restart %s failed: %v", svc, err)
		}
	}

	if m.headscaleConfigExists() {
		if err := svcMgr.RestartService(m.headscaleHost, "headscale"); err != nil {
			utils.Warn("Restart headscale failed: %v", err)
		}
	}
}

func (m *SiteManager) headscaleConfigExists() bool {
	return isHeadscaleConfigPresent(m.baseDir, m.headscaleHost)
}

// domainToName 从域名生成展示名 (sub.example.com -> Sub)
func domainToName(domain string) string {
	parts := strings.Split(domain, ".")
	if len(parts) == 0 || parts[0] == "" {
		return domain
	}
	first := parts[0]
	return strings.ToUpper(first[:1]) + first[1:]
}
