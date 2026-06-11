package engine

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestDNSManagerListAllRecords(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gateway", "dnsmasq")
	ocDir := filepath.Join(dir, "hosts", "gateway", "openclash")
	hsDir := filepath.Join(dir, "hosts", "keeper", "headscale")
	for _, d := range []string{gwDir, ocDir, hsDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}

	os.WriteFile(filepath.Join(gwDir, "dnsmasq.conf"), []byte("address=/web.example.com/192.168.1.1\n"), 0644)
	os.WriteFile(filepath.Join(ocDir, "hosts.list"), []byte("'db.example.com': 10.0.0.5\n"), 0644)
	os.WriteFile(filepath.Join(hsDir, "config.yaml"), []byte(`dns:
  extra_records:
      - name: "api.example.com"
        type: "A"
        value: "10.0.0.10"
`), 0644)

	m := &DNSManager{
		baseDir:       dir,
		gatewayHost:   "gateway",
		headscaleHost: "keeper",
	}

	records, err := m.ListDNSRecords()
	if err != nil {
		t.Fatalf("ListDNSRecords: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("got %d records, want 3", len(records))
	}

	found := map[string]string{}
	for _, r := range records {
		found[r.Domain] = r.IP
	}
	if found["web.example.com"] != "192.168.1.1" {
		t.Errorf("dnsmasq record: got %v", found)
	}
	if found["db.example.com"] != "10.0.0.5" {
		t.Errorf("openclash record: got %v", found)
	}
	if found["api.example.com"] != "10.0.0.10" {
		t.Errorf("headscale record: got %v", found)
	}
}

func TestDNSManagerAddDomainDefaultIP(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gateway", "dnsmasq")
	ocDir := filepath.Join(dir, "hosts", "gateway", "openclash")
	for _, d := range []string{gwDir, ocDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(gwDir, "dnsmasq.conf"), []byte(""), 0644)
	os.WriteFile(filepath.Join(ocDir, "hosts.list"), []byte(""), 0644)

	m := &DNSManager{
		baseDir:       dir,
		gatewayHost:   "gateway",
		headscaleHost: "keeper",
		defaultIP:     "192.168.1.1",
	}

	if err := m.AddDomain("test.example.com", ""); err != nil {
		t.Fatalf("AddDomain with empty IP: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(gwDir, "dnsmasq.conf"))
	if !containsPattern(string(data), "test.example.com") {
		t.Error("domain should be added to dnsmasq")
	}
}

func TestDNSManagerRemoveDomainNonExistent(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gateway", "dnsmasq")
	ocDir := filepath.Join(dir, "hosts", "gateway", "openclash")
	hsDir := filepath.Join(dir, "hosts", "keeper", "headscale")
	for _, d := range []string{gwDir, ocDir, hsDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(gwDir, "dnsmasq.conf"), []byte(""), 0644)
	os.WriteFile(filepath.Join(ocDir, "hosts.list"), []byte(""), 0644)
	os.WriteFile(filepath.Join(hsDir, "config.yaml"), []byte(""), 0644)

	m := &DNSManager{
		baseDir:       dir,
		gatewayHost:   "gateway",
		headscaleHost: "keeper",
		defaultIP:     "192.168.1.1",
	}

	err := m.RemoveDomain("nonexistent.example.com")
	if err != nil {
		t.Fatalf("RemoveDomain for nonexistent should not error: %v", err)
	}
}

func TestAddDnsmasqRecordMissingDir(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), gatewayHost: "nohost"}
	err := m.addDnsmasqRecord("test.com", "1.2.3.4")
	if err == nil {
		t.Error("expected error for missing dnsmasq dir")
	}
}

func TestRemoveDnsmasqRecordMissingDir(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), gatewayHost: "nohost"}
	err := m.removeDnsmasqRecord("test.com")
	if err == nil {
		t.Error("expected error for missing dnsmasq dir")
	}
}

func TestAddOpenClashRecordMissingDir(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), gatewayHost: "nohost"}
	err := m.addOpenClashRecord("test.com", "1.2.3.4")
	if err == nil {
		t.Error("expected error for missing openclash dir")
	}
}

func TestRemoveOpenClashRecordMissingDir(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), gatewayHost: "nohost"}
	err := m.removeOpenClashRecord("test.com")
	if err == nil {
		t.Error("expected error for missing openclash dir")
	}
}

func TestAddHeadscaleRecordMissingDir(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), headscaleHost: "nohost"}
	err := m.addHeadscaleRecord("test.com", "1.2.3.4")
	if err != nil {
		t.Errorf("addHeadscaleRecord on missing config should return nil, got %v", err)
	}
}

func TestRemoveHeadscaleRecordMissingDir(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), headscaleHost: "nohost"}
	err := m.removeHeadscaleRecord("test.com")
	if err != nil {
		t.Errorf("removeHeadscaleRecord on missing config should return nil, got %v", err)
	}
}

func TestAddHeadscaleRecordWithConfig(t *testing.T) {
	dir := t.TempDir()
	hsDir := filepath.Join(dir, "hosts", "keeper", "headscale")
	if err := os.MkdirAll(hsDir, 0755); err != nil {
		t.Fatal(err)
	}

	configContent := `dns:
  split_dns:
          - 100.100.100.100
  extra_records:
      - name: "existing.example.com"
        type: "A"
        value: "10.0.0.1"
`
	os.WriteFile(filepath.Join(hsDir, "config.yaml"), []byte(configContent), 0644)

	m := &DNSManager{
		baseDir:       dir,
		headscaleHost: "keeper",
		headscaleDNS:  "100.100.100.100",
		defaultIP:     "10.0.0.1",
	}

	err := m.addHeadscaleRecord("new.example.com", "10.0.0.2")
	if err != nil {
		t.Fatalf("addHeadscaleRecord: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(hsDir, "config.yaml"))
	content := string(data)
	if !containsPattern(content, "new.example.com") {
		t.Error("new domain should be added to headscale config")
	}
}

func TestRemoveHeadscaleRecordWithConfig(t *testing.T) {
	dir := t.TempDir()
	hsDir := filepath.Join(dir, "hosts", "keeper", "headscale")
	if err := os.MkdirAll(hsDir, 0755); err != nil {
		t.Fatal(err)
	}

	configContent := `dns:
  split_dns:
        old.example.com:
          - 100.100.100.100
  extra_records:
      - name: "old.example.com"
        type: "A"
        value: "10.0.0.1"
`
	os.WriteFile(filepath.Join(hsDir, "config.yaml"), []byte(configContent), 0644)

	m := &DNSManager{
		baseDir:       dir,
		headscaleHost: "keeper",
		headscaleDNS:  "100.100.100.100",
		defaultIP:     "10.0.0.1",
	}

	err := m.removeHeadscaleRecord("old.example.com")
	if err != nil {
		t.Fatalf("removeHeadscaleRecord: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(hsDir, "config.yaml"))
	content := string(data)
	if containsPattern(content, `name: "old.example.com"`) {
		t.Error("old domain should be removed from headscale extra_records")
	}
}

func TestDNSRecordStructFields(t *testing.T) {
	r := DNSRecord{Domain: "a.b.c", IP: "1.2.3.4"}
	if r.Domain != "a.b.c" || r.IP != "1.2.3.4" {
		t.Errorf("DNSRecord = %+v", r)
	}
}

func TestListDnsmasqRecordsMissingPath(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), gatewayHost: "nohost"}
	records := m.listDnsmasqRecords()
	if len(records) != 0 {
		t.Errorf("expected 0 records for missing path, got %d", len(records))
	}
}

func TestListOpenClashRecordsMissingPath(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), gatewayHost: "nohost"}
	records := m.listOpenClashRecords()
	if len(records) != 0 {
		t.Errorf("expected 0 records for missing path, got %d", len(records))
	}
}

func TestListHeadscaleRecordsMissingPath(t *testing.T) {
	m := &DNSManager{baseDir: t.TempDir(), headscaleHost: "nohost"}
	records := m.listHeadscaleRecords()
	if len(records) != 0 {
		t.Errorf("expected 0 records for missing path, got %d", len(records))
	}
}

func TestDnsmasqUpdateExistingIP(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	os.WriteFile(confPath, []byte("address=/web.example.com/192.168.1.1\naddress=/db.example.com/10.0.0.5\n"), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addDnsmasqRecord("web.example.com", "10.0.0.99"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(confPath)
	if !containsPattern(string(data), "10.0.0.99") {
		t.Error("IP should be updated to 10.0.0.99")
	}
	if !containsPattern(string(data), "db.example.com") {
		t.Error("other records should remain")
	}
}

func TestOpenClashUpdateExistingIP(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gw", "openclash")
	os.MkdirAll(ocDir, 0755)
	hostsPath := filepath.Join(ocDir, "hosts.list")
	os.WriteFile(hostsPath, []byte("'web.example.com': 192.168.1.1\n'db.example.com': 10.0.0.5\n"), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addOpenClashRecord("web.example.com", "10.0.0.99"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hostsPath)
	content := string(data)
	if !containsPattern(content, "'web.example.com': 10.0.0.99") {
		t.Errorf("IP should be updated, got: %s", content)
	}
	if !containsPattern(content, "'db.example.com': 10.0.0.5") {
		t.Error("other records should remain")
	}
}

func TestIsHeadscaleConfigPresentEmptyDir(t *testing.T) {
	dir := t.TempDir()
	if isHeadscaleConfigPresent(dir, "nohost") {
		t.Error("should return false for empty hosts dir")
	}
}

func TestDNSManagerDefaultDomainField(t *testing.T) {
	m := &DNSManager{defaultDomain: "singll.net"}
	if m.defaultDomain != "singll.net" {
		t.Errorf("defaultDomain = %q, want %q", m.defaultDomain, "singll.net")
	}
}

func TestDNSManagerSSHKeyField(t *testing.T) {
	m := &DNSManager{sshKey: "/path/to/key"}
	if m.sshKey != "/path/to/key" {
		t.Errorf("sshKey = %q, want %q", m.sshKey, "/path/to/key")
	}
}

func TestNewDNSManagerMissingConfig(t *testing.T) {
	_, err := NewDNSManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestAddDomainCoreProvidersFail(t *testing.T) {
	m := &DNSManager{
		baseDir:       t.TempDir(),
		gatewayHost:   "nohost",
		headscaleHost: "nohost",
		defaultIP:     "192.168.1.1",
	}
	err := m.AddDomain("test.com", "")
	if err == nil {
		t.Error("expected error when core DNS providers fail")
	}
}

func TestDNSManagerConfigFields(t *testing.T) {
	m := &DNSManager{
		baseDir:       "/opt/spool",
		gatewayHost:   "gw",
		headscaleHost: "hs",
		defaultIP:     "10.0.0.1",
		headscaleDNS:  "100.100.100.100",
		defaultDomain: "example.com",
		sshKey:        "/keys/spool",
	}
	if m.baseDir != "/opt/spool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.gatewayHost != "gw" {
		t.Errorf("gatewayHost = %q", m.gatewayHost)
	}
	if m.headscaleDNS != "100.100.100.100" {
		t.Errorf("headscaleDNS = %q", m.headscaleDNS)
	}
}

func TestBackupRuleConfig(t *testing.T) {
	rule := config.BackupRule{Type: "volume", Source: "mydata", Name: "backup1"}
	if rule.Type != "volume" {
		t.Errorf("Type = %q", rule.Type)
	}
	if rule.Source != "mydata" {
		t.Errorf("Source = %q", rule.Source)
	}
}
