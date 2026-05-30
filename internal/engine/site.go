package engine

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/pkg/utils"
)

type SiteManager struct {
	baseDir  string
	dnsMgr   *DNSManager
	sshKey   string
}

type Site struct {
	Domain   string
	Backend  string
	Name     string
	Desc     string
	Icon     string
	Enabled  bool
}

func NewSiteManager(baseDir string) *SiteManager {
	return &SiteManager{
		baseDir: baseDir,
	}
}

// ListSites 列出所有站点
func (m *SiteManager) ListSites() ([]Site, error) {
	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return nil, err
	}

	// 从 DNS 配置中提取站点信息
	sites := []Site{}

	// 遍历所有主机的 DNS 配置
	for host := range cfg.Hosts {
		dnsPath := filepath.Join(m.baseDir, "hosts", host, "dns.conf")
		data, err := os.ReadFile(dnsPath)
		if err != nil {
			continue
		}

		// 解析 DNS 配置中的站点
		content := string(data)
		// 简化解析：查找 Caddy 反向代理配置
		for _, line := range splitLines(content) {
			if contains(line, "reverse_proxy") || contains(line, "->") {
				// 提取域名
				if domain := extractDomain(line); domain != "" {
					sites = append(sites, Site{
						Domain:  domain,
						Backend: extractBackend(line),
						Name:    domainToName(domain),
						Enabled: !contains(line, "#"),
					})
				}
			}
		}
	}

	return sites, nil
}

// AddSite 添加站点
func (m *SiteManager) AddSite(domain, backend, name, desc, icon string) error {
	utils.Info("Adding site: %s", domain)

	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return fmt.Errorf("failed to load config: %v", err)
	}

	// 确定目标主机 (默认使用 n8n 配置的主机)
	host := cfg.N8N.Host
	if host == "" {
		host = "keeper"
	}

	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host not found: %s", host)
	}

	// 写入 DNS 配置
	dnsPath := filepath.Join(m.baseDir, "hosts", host, "dns.conf")
	f, err := os.OpenFile(dnsPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("failed to open dns.conf: %w", err)
	}
	defer f.Close()

	entry := fmt.Sprintf("\n# Site: %s\n%s {\n  reverse_proxy %s\n}\n",
		name, domain, backend)
	_, err = f.WriteString(entry)
	if err != nil {
		return fmt.Errorf("failed to write dns.conf: %w", err)
	}

	utils.Success("Site added: %s", domain)
	return nil
}

// DeploySite 一键部署站点
func (m *SiteManager) DeploySite(domain, backend, name string) error {
	utils.Info("Deploying site: %s", domain)

	// 1. 添加 DNS/Caddy 配置
	if err := m.AddSite(domain, backend, name, "", ""); err != nil {
		return err
	}

	// 2. 推送配置到远程
	syncMgr, err := NewSyncManager(m.baseDir)
	if err != nil {
		return fmt.Errorf("failed to create sync manager: %w", err)
	}

	cfg, _ := config.LoadConfig(m.baseDir)
	host := cfg.N8N.Host
	if host == "" {
		host = "keeper"
	}

	// 推送 DNS 配置
	hostCfg := cfg.GetHost(host)
	if hostCfg == nil {
		return fmt.Errorf("host not found: %s", host)
	}

	for _, rule := range hostCfg.SyncRules {
		if contains(rule.Local, "dns.conf") || contains(rule.Local, "Caddyfile") {
			localPath := filepath.Join(m.baseDir, "hosts", host, rule.Local)
			if _, err := os.Stat(localPath); err == nil {
				utils.Info("Pushing config: %s", rule.Local)
				if err := syncMgr.pushFile(hostCfg.Address, localPath, rule.Remote); err != nil {
					utils.Warn("Push failed: %v", err)
				}
			}
		}
	}

	// 3. 重启 Caddy
	sshClient, err := NewSSHClient(hostCfg.Address, m.sshKey)
	if err != nil {
		return fmt.Errorf("failed to create SSH client: %w", err)
	}
	defer sshClient.Close()

	utils.Info("Restarting Caddy...")
	if _, err := sshClient.Execute("sudo systemctl reload caddy"); err != nil {
		utils.Warn("Caddy reload failed: %v", err)
	}

	utils.Success("Site deployed: %s", domain)
	return nil
}

// PushSites 推送所有站点配置
func (m *SiteManager) PushSites() error {
	utils.Info("Pushing all site configurations...")

	syncMgr, err := NewSyncManager(m.baseDir)
	if err != nil {
		return err
	}

	cfg, err := config.LoadConfig(m.baseDir)
	if err != nil {
		return err
	}

	host := cfg.N8N.Host
	if host == "" {
		host = "keeper"
	}

	return syncMgr.SyncHost(host, "push")
}

// Helper functions
func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr ||
		(len(s) > 0 && len(substr) > 0 && findSubstring(s, substr) >= 0))
}

func findSubstring(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}

func extractDomain(line string) string {
	// 简单提取: 找到第一个不在引号中的域名
	start := -1
	for i := 0; i < len(line); i++ {
		if line[i] == '{' && start == -1 {
			start = i + 1
		}
		if line[i] == '}' && start != -1 {
			return line[start:i]
		}
	}
	// 尝试提取 reverse_proxy 后的地址
	if idx := findSubstring(line, "reverse_proxy"); idx >= 0 {
		rest := line[idx+14:]
		for i, c := range rest {
			if c == ' ' || c == '\t' {
				continue
			}
			if c == ':' {
				continue
			}
			end := i
			for end < len(rest) && rest[end] != ' ' && rest[end] != '\t' && rest[end] != '\n' {
				end++
			}
			if end > i {
				return rest[i:end]
			}
		}
	}
	return ""
}

func extractBackend(line string) string {
	if idx := findSubstring(line, "reverse_proxy"); idx >= 0 {
		rest := line[idx+14:]
		for i, c := range rest {
			if c == ' ' || c == '\t' {
				continue
			}
			end := i
			for end < len(rest) && rest[end] != ' ' && rest[end] != '\t' && rest[end] != '\n' {
				end++
			}
			if end > i {
				return rest[i:end]
			}
		}
	}
	return ""
}

func domainToName(domain string) string {
	// 简单转换: sub.domain.com -> SubDomain
	name := ""
	parts := splitByDot(domain)
	for i, part := range parts {
		if part == "" || part == "com" || part == "net" || part == "org" {
			continue
		}
		if len(part) > 0 {
			if part[0] >= 'a' && part[0] <= 'z' {
				name += string(part[0]-'a'+'A') + part[1:]
			} else {
				name += part
			}
			if i < len(parts)-1 {
				name += "."
			}
		}
	}
	return name
}

func splitByDot(s string) []string {
	var parts []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == '.' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	return parts
}
