package engine

import (
	"errors"
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

// SiteStepResult 描述站点操作中单个步骤的结果。
type SiteStepResult struct {
	Step   string `json:"step"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// SiteOperationError 表示部分成功/失败的结构化错误。
type SiteOperationError struct {
	Operation string           `json:"operation"`
	Steps     []SiteStepResult `json:"steps"`
}

func (e *SiteOperationError) Error() string {
	parts := make([]string, 0, len(e.Steps))
	for _, step := range e.Steps {
		if step.Error != "" {
			parts = append(parts, step.Step+"="+step.Status+" ("+step.Error+")")
		} else {
			parts = append(parts, step.Step+"="+step.Status)
		}
	}
	return e.Operation + ": " + strings.Join(parts, ", ")
}

func (e *SiteOperationError) Unwrap() []error {
	var errs []error
	for _, step := range e.Steps {
		if step.Error != "" {
			errs = append(errs, fmt.Errorf("%s: %s", step.Step, step.Error))
		}
	}
	return errs
}

func siteStep(step string, err error) SiteStepResult {
	if err != nil {
		return SiteStepResult{Step: step, Status: "failed", Error: err.Error()}
	}
	return SiteStepResult{Step: step, Status: "ok"}
}

// Site 站点信息
type Site struct {
	Domain  string `json:"domain"`
	Backend string `json:"backend"`
	Name    string `json:"name"`
	Desc    string `json:"desc,omitempty"`
	Icon    string `json:"icon,omitempty"`
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
		sshKey:        config.ResolveSSHKeyPath(baseDir, cfg.Global.SSHKeyPath),
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

	steps := make([]SiteStepResult, 0, 5)
	// 1. DNS 记录 (dnsmasq + openclash + headscale)，逐 provider 记录结果。
	ip := m.defaultIP
	if ip == "" {
		ip = m.dns.defaultIP
	}
	dnsResults := m.dns.AddDomainDetailed(domain, ip)
	var coreErrs []error
	for _, result := range dnsResults {
		var stepErr error
		if result.Error != "" {
			stepErr = fmt.Errorf("%s", result.Error)
			utils.Warn("%s add failed: %v", result.Provider, stepErr)
			if result.Provider == "dnsmasq" || result.Provider == "openclash" {
				coreErrs = append(coreErrs, fmt.Errorf("%s: %w", result.Provider, stepErr))
			}
		}
		steps = append(steps, siteStep("dns."+result.Provider, stepErr))
	}
	var dnsErr error
	if len(coreErrs) == len(dnsResults)-1 && len(coreErrs) > 0 {
		dnsErr = fmt.Errorf("core DNS providers failed; run 'spool sync pull %s' first: %v", m.gatewayHost, errors.Join(coreErrs...))
		steps = append(steps, SiteStepResult{Step: "dns", Status: "failed", Error: dnsErr.Error()})
	}

	// 2. Caddy 反向代理
	caddyErr := m.caddyAddSite(domain, backend)
	steps = append(steps, siteStep("caddy", caddyErr))
	if caddyErr != nil {
		utils.Warn("Caddy add failed: %v", caddyErr)
	}

	// 3. Homepage 仪表盘入口
	homepageErr := m.homepageAddSite(domain, name, desc, icon, "Services")
	steps = append(steps, siteStep("homepage", homepageErr))
	if homepageErr != nil {
		utils.Warn("Homepage add failed: %v", homepageErr)
	}

	if dnsErr != nil || caddyErr != nil || homepageErr != nil {
		return &SiteOperationError{Operation: "site add", Steps: steps}
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

	steps := make([]SiteStepResult, 0, 3)
	dnsErr := m.dns.RemoveDomain(domain)
	steps = append(steps, siteStep("dns", dnsErr))
	caddyErr := m.caddyRemoveSite(domain)
	steps = append(steps, siteStep("caddy", caddyErr))
	homepageErr := m.homepageRemoveSite(domain)
	steps = append(steps, siteStep("homepage", homepageErr))
	if dnsErr != nil || caddyErr != nil || homepageErr != nil {
		return &SiteOperationError{Operation: "site remove", Steps: steps}
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
	if err := m.restartSiteServices(); err != nil {
		return err
	}

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

	// Headscale 配置存在则一并推送（可选步骤失败也要上报）
	if m.headscaleConfigExists() {
		if err := syncMgr.SyncHost(m.headscaleHost, "push"); err != nil {
			return fmt.Errorf("push to %s failed: %w", m.headscaleHost, err)
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

	if !strings.HasPrefix(backend, "http") {
		backend = "http://" + backend
	}

	// 已存在则按期望状态更新 reverse_proxy，而不是保留旧 backend。
	if regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(domain) + `\s*\{`).MatchString(content) {
		lines := strings.Split(content, "\n")
		startRe := regexp.MustCompile(`^` + regexp.QuoteMeta(domain) + `\s*\{`)
		inBlock := false
		updated := false
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if !inBlock && startRe.MatchString(trimmed) {
				inBlock = true
				continue
			}
			if !inBlock {
				continue
			}
			if strings.HasPrefix(trimmed, "reverse_proxy ") {
				if strings.TrimSpace(strings.TrimPrefix(trimmed, "reverse_proxy ")) != backend {
					lines[i] = "    reverse_proxy " + backend
					updated = true
				}
				break
			}
			if trimmed == "}" {
				break
			}
		}
		if updated {
			if err := os.WriteFile(m.caddyPath, []byte(strings.Join(lines, "\n")), 0644); err != nil {
				return err
			}
			utils.Success("Caddy: updated %s -> %s", domain, backend)
			return nil
		}
		utils.Info("Caddy: site %s already exists", domain)
		return nil
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
func (m *SiteManager) restartSiteServices() error {
	svcMgr, err := NewServiceManager(m.baseDir)
	if err != nil {
		return fmt.Errorf("failed to init service manager: %w", err)
	}

	steps := make([]SiteStepResult, 0, 5)
	for _, svc := range []string{"dnsmasq", "openclash", "caddy", "homepage"} {
		err := svcMgr.RestartService(m.gatewayHost, svc)
		steps = append(steps, siteStep("restart."+svc, err))
		utils.Warn("Restart %s failed: %v", svc, err)
	}

	if m.headscaleConfigExists() {
		err := svcMgr.RestartService(m.headscaleHost, "headscale")
		steps = append(steps, siteStep("restart.headscale", err))
		if err != nil {
			utils.Warn("Restart headscale failed: %v", err)
		}
	}
	for _, step := range steps {
		if step.Error != "" {
			return &SiteOperationError{Operation: "site restart", Steps: steps}
		}
	}
	return nil
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
