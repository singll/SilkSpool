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

// DNSManager DNS 配置管理器
type DNSManager struct {
	baseDir       string
	gatewayHost   string
	headscaleHost string
	defaultIP     string
	headscaleDNS  string
	defaultDomain string
	sshKey        string
}

// NewDNSManager 创建 DNS 管理器
func NewDNSManager(baseDir string) (*DNSManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	return &DNSManager{
		baseDir:       baseDir,
		gatewayHost:   cfg.Global.DNSGatewayHost,
		headscaleHost: cfg.Global.DNSHeadscaleHost,
		defaultIP:     cfg.Global.DNSGatewayIP,
		headscaleDNS:   cfg.Global.DNSHeadscaleServer,
		defaultDomain: cfg.Global.DefaultDomain,
		sshKey:        filepath.Join(baseDir, cfg.Global.SSHKeyPath),
	}, nil
}

// ==================== DNS 记录 ====================

// DNSRecord DNS 记录
type DNSRecord struct {
	Domain string
	IP     string
}

// ListDNSRecords 列出所有 DNS 记录
func (m *DNSManager) ListDNSRecords() ([]DNSRecord, error) {
	var records []DNSRecord

	records = append(records, m.listDnsmasqRecords()...)
	records = append(records, m.listOpenClashRecords()...)
	records = append(records, m.listHeadscaleRecords()...)

	return records, nil
}

func (m *DNSManager) listDnsmasqRecords() []DNSRecord {
	var records []DNSRecord
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "dnsmasq", "dnsmasq.conf")

	data, err := os.ReadFile(path)
	if err != nil {
		return records
	}

	re := regexp.MustCompile(`(?m)^address=/([^/]+)/(\S+)`)
	matches := re.FindAllStringSubmatch(string(data), -1)

	for _, match := range matches {
		if len(match) >= 3 {
			records = append(records, DNSRecord{
				Domain: match[1],
				IP:     match[2],
			})
		}
	}

	return records
}

func (m *DNSManager) listOpenClashRecords() []DNSRecord {
	var records []DNSRecord
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "openclash", "hosts.list")

	data, err := os.ReadFile(path)
	if err != nil {
		return records
	}

	re := regexp.MustCompile(`(?m)'(.+?)':\s*(\S+)`)
	matches := re.FindAllStringSubmatch(string(data), -1)

	for _, match := range matches {
		if len(match) >= 3 {
			records = append(records, DNSRecord{
				Domain: match[1],
				IP:     match[2],
			})
		}
	}

	return records
}

// ==================== DNS 操作 ====================

// AddDomain 添加 DNS 记录
func (m *DNSManager) AddDomain(domain, ip string) error {
	if ip == "" {
		ip = m.defaultIP
	}

	utils.Step("Adding DNS record: %s -> %s", domain, ip)

	dnsmasqErr := m.addDnsmasqRecord(domain, ip)
	openclashErr := m.addOpenClashRecord(domain, ip)
	headscaleErr := m.addHeadscaleRecord(domain, ip)

	// dnsmasq + openclash 为核心 provider，二者皆失败通常意味着本地配置缺失
	if dnsmasqErr != nil && openclashErr != nil {
		return fmt.Errorf("core DNS providers failed (dnsmasq: %v, openclash: %v); run 'spool sync pull %s' first",
			dnsmasqErr, openclashErr, m.gatewayHost)
	}
	if dnsmasqErr != nil {
		utils.Warn("dnsmasq add failed: %v", dnsmasqErr)
	}
	if openclashErr != nil {
		utils.Warn("openclash add failed: %v", openclashErr)
	}
	if headscaleErr != nil {
		utils.Warn("headscale add failed: %v", headscaleErr)
	}

	utils.Success("DNS record added: %s -> %s", domain, ip)
	return nil
}

// RemoveDomain 删除 DNS 记录
func (m *DNSManager) RemoveDomain(domain string) error {
	utils.Step("Removing DNS record: %s", domain)

	var errs []error

	if err := m.removeDnsmasqRecord(domain); err != nil {
		errs = append(errs, fmt.Errorf("dnsmasq: %w", err))
	}
	if err := m.removeOpenClashRecord(domain); err != nil {
		errs = append(errs, fmt.Errorf("openclash: %w", err))
	}
	if err := m.removeHeadscaleRecord(domain); err != nil {
		errs = append(errs, fmt.Errorf("headscale: %w", err))
	}

	if len(errs) > 0 {
		return fmt.Errorf("some DNS providers failed: %v", errs)
	}

	utils.Success("DNS record removed: %s", domain)
	return nil
}

// ==================== Dnsmasq ====================

func (m *DNSManager) addDnsmasqRecord(domain, ip string) error {
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "dnsmasq", "dnsmasq.conf")

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	content := string(data)
	pattern := fmt.Sprintf(`(?m)^address=/%s/`, regexp.QuoteMeta(domain))

	// 检查是否已存在
	exists, _ := regexp.MatchString(pattern, content)
	if exists {
		re := regexp.MustCompile(pattern + `.*`)
		content = re.ReplaceAllString(content, fmt.Sprintf("address=/%s/%s", domain, ip))
	} else {
		content += fmt.Sprintf("\naddress=/%s/%s", domain, ip)
	}

	return os.WriteFile(path, []byte(content), 0644)
}

func (m *DNSManager) removeDnsmasqRecord(domain string) error {
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "dnsmasq", "dnsmasq.conf")

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	re := regexp.MustCompile(fmt.Sprintf(`(?m)^address=/%s/.*\n?`, regexp.QuoteMeta(domain)))
	content := re.ReplaceAllString(string(data), "")

	return os.WriteFile(path, []byte(content), 0644)
}

// ==================== OpenClash ====================

func (m *DNSManager) addOpenClashRecord(domain, ip string) error {
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "openclash", "hosts.list")

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	content := string(data)
	pattern := fmt.Sprintf(`'%s':`, regexp.QuoteMeta(domain))

	if strings.Contains(content, pattern) {
		re := regexp.MustCompile(fmt.Sprintf(`'%s':.*`, regexp.QuoteMeta(domain)))
		content = re.ReplaceAllString(content, fmt.Sprintf("'%s': %s", domain, ip))
	} else {
		content += fmt.Sprintf("\n'%s': %s", domain, ip)
	}

	return os.WriteFile(path, []byte(content), 0644)
}

func (m *DNSManager) removeOpenClashRecord(domain string) error {
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "openclash", "hosts.list")

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	re := regexp.MustCompile(fmt.Sprintf(`(?m)^'%s':.*\n?`, regexp.QuoteMeta(domain)))
	content := re.ReplaceAllString(string(data), "")

	return os.WriteFile(path, []byte(content), 0644)
}

// ==================== Headscale ====================

func (m *DNSManager) addHeadscaleRecord(domain, ip string) error {
	path := filepath.Join(m.baseDir, "hosts", m.headscaleHost, "headscale", "config.yaml")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	content := string(data)

	// 添加到 split DNS
	splitPattern := fmt.Sprintf(`(?m)^        %s:`, regexp.QuoteMeta(domain))
	exists, _ := regexp.MatchString(splitPattern, content)
	if !exists {
		re := regexp.MustCompile(`(          - ` + regexp.QuoteMeta(m.headscaleDNS) + `\n)`)
		if loc := re.FindStringIndex(content); loc != nil {
			insertPos := loc[1]
			newContent := fmt.Sprintf("        %s:\n          - %s\n", domain, m.headscaleDNS)
			content = content[:insertPos] + newContent + content[insertPos:]
		}
	}

	// 添加到 extra_records
	recordPattern := fmt.Sprintf(`name: "%s"`, regexp.QuoteMeta(domain))
	exists, _ = regexp.MatchString(recordPattern, content)
	if !exists {
		re := regexp.MustCompile(`(value: "` + regexp.QuoteMeta(m.defaultIP) + `"\n)`)
		if loc := re.FindStringIndex(content); loc != nil {
			insertPos := loc[1]
			newContent := fmt.Sprintf(`      - name: "%s"
        type: "A"
        value: "%s"
`, domain, ip)
			content = content[:insertPos] + newContent + content[insertPos:]
		}
	}

	return os.WriteFile(path, []byte(content), 0644)
}

func (m *DNSManager) removeHeadscaleRecord(domain string) error {
	path := filepath.Join(m.baseDir, "hosts", m.headscaleHost, "headscale", "config.yaml")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	content := string(data)

	re1 := regexp.MustCompile(fmt.Sprintf(`(?m)^        %s:\n          - %s\n`, regexp.QuoteMeta(domain), regexp.QuoteMeta(m.headscaleDNS)))
	content = re1.ReplaceAllString(content, "")

	re2 := regexp.MustCompile(fmt.Sprintf(`(?m)(      - name: "%s"\n        type: "A"\n        value: "[^"]+"\n)`, regexp.QuoteMeta(domain)))
	content = re2.ReplaceAllString(content, "")

	return os.WriteFile(path, []byte(content), 0644)
}

// ==================== 工具方法 ====================

// SyncFromCaddyfile 从 Caddyfile 同步域名
func (m *DNSManager) SyncFromCaddyfile() error {
	caddyPath := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "caddy", "Caddyfile")

	data, err := os.ReadFile(caddyPath)
	if err != nil {
		return fmt.Errorf("failed to read Caddyfile: %w", err)
	}

	re := regexp.MustCompile(`(?m)^([a-z0-9][-a-z0-9.]*\.` + regexp.QuoteMeta(m.defaultDomain) + `)\s*\{`)
	matches := re.FindAllStringSubmatch(string(data), -1)

	// 已存在的 dnsmasq 域名集合，用于只统计真正新增的数量
	existing := make(map[string]bool)
	for _, r := range m.listDnsmasqRecords() {
		existing[r.Domain] = true
	}

	added := 0
	for _, match := range matches {
		if len(match) >= 2 {
			domain := match[1]
			if existing[domain] {
				continue
			}
			if err := m.AddDomain(domain, m.defaultIP); err == nil {
				existing[domain] = true
				added++
			}
		}
	}

	utils.Success("Synced %d new domains from Caddyfile", added)
	return nil
}

// listHeadscaleRecords 解析 Headscale extra_records 中的 A 记录
func (m *DNSManager) listHeadscaleRecords() []DNSRecord {
	var records []DNSRecord
	path := filepath.Join(m.baseDir, "hosts", m.headscaleHost, "headscale", "config.yaml")

	data, err := os.ReadFile(path)
	if err != nil {
		return records
	}

	re := regexp.MustCompile(`name:\s*"([^"]+)"\s*\n\s*type:\s*"A"\s*\n\s*value:\s*"(\S+)"`)
	matches := re.FindAllStringSubmatch(string(data), -1)
	for _, match := range matches {
		if len(match) >= 3 {
			records = append(records, DNSRecord{Domain: match[1], IP: match[2]})
		}
	}
	return records
}

func (m *DNSManager) headscaleConfigExists() bool {
	return isHeadscaleConfigPresent(m.baseDir, m.headscaleHost)
}

func isHeadscaleConfigPresent(baseDir, headscaleHost string) bool {
	path := filepath.Join(baseDir, "hosts", headscaleHost, "headscale", "config.yaml")
	_, err := os.Stat(path)
	return err == nil
}

// PushDNS 推送 DNS 配置到远程 (dnsmasq/openclash + headscale)
func (m *DNSManager) PushDNS() error {
	utils.Step("Pushing DNS config to remote")

	syncMgr, err := NewSyncManager(m.baseDir)
	if err != nil {
		return err
	}

	// 1. 推送网关主机 (dnsmasq + openclash)
	utils.Step("Pushing to %s...", m.gatewayHost)
	if err := syncMgr.SyncHost(m.gatewayHost, "push"); err != nil {
		return fmt.Errorf("push to %s failed: %w", m.gatewayHost, err)
	}

	// 2. 推送 Headscale 主机 (仅当本地存在 headscale 配置)
	if m.headscaleConfigExists() {
		utils.Step("Pushing to %s...", m.headscaleHost)
		if err := syncMgr.SyncHost(m.headscaleHost, "push"); err != nil {
			utils.Warn("push to %s failed: %v", m.headscaleHost, err)
		}
	}

	utils.Success("DNS config pushed")
	return nil
}

// PullDNS 从远程拉取 DNS 配置到本地
func (m *DNSManager) PullDNS() error {
	utils.Step("Pulling DNS config from remote")

	syncMgr, err := NewSyncManager(m.baseDir)
	if err != nil {
		return err
	}

	utils.Step("Pulling from %s...", m.gatewayHost)
	if err := syncMgr.SyncHost(m.gatewayHost, "pull"); err != nil {
		return fmt.Errorf("pull from %s failed: %w", m.gatewayHost, err)
	}

	utils.Step("Pulling from %s...", m.headscaleHost)
	if err := syncMgr.SyncHost(m.headscaleHost, "pull"); err != nil {
		utils.Warn("pull from %s failed: %v", m.headscaleHost, err)
	}

	utils.Success("DNS config pulled to local")
	return nil
}

// DeployDomain 一键部署: 添加记录 + 推送配置 + 重启服务
func (m *DNSManager) DeployDomain(domain, ip string) error {
	utils.Step("Step 1/3: Adding DNS record...")
	if err := m.AddDomain(domain, ip); err != nil {
		return err
	}

	utils.Step("Step 2/3: Pushing configs to remote...")
	if err := m.PushDNS(); err != nil {
		return err
	}

	utils.Step("Step 3/3: Restarting DNS services...")
	m.restartDNSServices()

	utils.Success("DNS deploy complete: %s -> %s", domain, ip)
	return nil
}

// restartDNSServices 重启网关 DNS 服务 (dnsmasq, openclash) 及 Headscale
func (m *DNSManager) restartDNSServices() {
	svcMgr, err := NewServiceManager(m.baseDir)
	if err != nil {
		utils.Warn("Failed to init service manager: %v", err)
		return
	}

	for _, svc := range []string{"dnsmasq", "openclash"} {
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
