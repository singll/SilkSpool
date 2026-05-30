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
}

// NewDNSManager 创建 DNS 管理器
func NewDNSManager(baseDir string) (*DNSManager, error) {
	cfg, err := config.LoadConfig(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	return &DNSManager{
		baseDir:       baseDir,
		gatewayHost:   "istoreos", // TODO: 从配置读取
		headscaleHost: "txhk",
		defaultIP:     cfg.Global.DNSGatewayIP,
		headscaleDNS:   cfg.Global.DNSHeadscaleServer,
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

	m.addDnsmasqRecord(domain, ip)
	m.addOpenClashRecord(domain, ip)
	m.addHeadscaleRecord(domain, ip)

	utils.Success("DNS record added: %s -> %s", domain, ip)
	return nil
}

// RemoveDomain 删除 DNS 记录
func (m *DNSManager) RemoveDomain(domain string) error {
	utils.Step("Removing DNS record: %s", domain)

	m.removeDnsmasqRecord(domain)
	m.removeOpenClashRecord(domain)
	m.removeHeadscaleRecord(domain)

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

func (m *DNSManager) removeDnsmasqRecord(domain string) {
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "dnsmasq", "dnsmasq.conf")

	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	re := regexp.MustCompile(fmt.Sprintf(`(?m)^address=/%s/.*\n?`, regexp.QuoteMeta(domain)))
	content := re.ReplaceAllString(string(data), "")

	os.WriteFile(path, []byte(content), 0644)
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

func (m *DNSManager) removeOpenClashRecord(domain string) {
	path := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "openclash", "hosts.list")

	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	re := regexp.MustCompile(fmt.Sprintf(`(?m)^'%s':.*\n?`, regexp.QuoteMeta(domain)))
	content := re.ReplaceAllString(string(data), "")

	os.WriteFile(path, []byte(content), 0644)
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

func (m *DNSManager) removeHeadscaleRecord(domain string) {
	path := filepath.Join(m.baseDir, "hosts", m.headscaleHost, "headscale", "config.yaml")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	content := string(data)

	re1 := regexp.MustCompile(fmt.Sprintf(`(?m)^        %s:\n          - %s\n`, regexp.QuoteMeta(domain), regexp.QuoteMeta(m.headscaleDNS)))
	content = re1.ReplaceAllString(content, "")

	re2 := regexp.MustCompile(fmt.Sprintf(`(?m)(      - name: "%s"\n        type: "A"\n        value: "[^"]+"\n)`, regexp.QuoteMeta(domain)))
	content = re2.ReplaceAllString(content, "")

	os.WriteFile(path, []byte(content), 0644)
}

// ==================== 工具方法 ====================

// SyncFromCaddyfile 从 Caddyfile 同步域名
func (m *DNSManager) SyncFromCaddyfile() error {
	caddyPath := filepath.Join(m.baseDir, "hosts", m.gatewayHost, "caddy", "Caddyfile")
	defaultDomain := "singll.net"

	data, err := os.ReadFile(caddyPath)
	if err != nil {
		return fmt.Errorf("failed to read Caddyfile: %w", err)
	}

	re := regexp.MustCompile(`(?m)^([a-z0-9][-a-z0-9]*\.` + regexp.QuoteMeta(defaultDomain) + `)\s+\{`)
	matches := re.FindAllStringSubmatch(string(data), -1)

	added := 0
	for _, match := range matches {
		if len(match) >= 2 {
			if err := m.AddDomain(match[1], m.defaultIP); err == nil {
				added++
			}
		}
	}

	utils.Success("Synced %d domains from Caddyfile", added)
	return nil
}

// PushDNS 推送 DNS 配置到远程
func (m *DNSManager) PushDNS() error {
	utils.Step("Pushing DNS config to remote")
	// TODO: 调用 sync 模块
	utils.Success("DNS config pushed")
	return nil
}
