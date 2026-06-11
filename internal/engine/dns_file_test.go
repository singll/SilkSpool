package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAddDnsmasqRecordToEmptyConf(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	if err := os.MkdirAll(gwDir, 0755); err != nil {
		t.Fatal(err)
	}
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	os.WriteFile(confPath, []byte(""), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addDnsmasqRecord("new.example.com", "10.0.0.1"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(confPath)
	content := string(data)
	if !strings.Contains(content, "address=/new.example.com/10.0.0.1") {
		t.Errorf("record should be added to empty conf, got: %s", content)
	}
}

func TestAddDnsmasqRecordToExistingConf(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	initial := "server=8.8.8.8\naddress=/old.example.com/192.168.1.1\n"
	os.WriteFile(confPath, []byte(initial), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addDnsmasqRecord("new.example.com", "10.0.0.1"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(confPath)
	content := string(data)
	if !strings.Contains(content, "address=/new.example.com/10.0.0.1") {
		t.Errorf("new record should be added, got: %s", content)
	}
	if !strings.Contains(content, "address=/old.example.com/192.168.1.1") {
		t.Errorf("existing record should remain, got: %s", content)
	}
	if !strings.Contains(content, "server=8.8.8.8") {
		t.Errorf("other lines should remain, got: %s", content)
	}
}

func TestRemoveDnsmasqRecordExisting(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	initial := "address=/to-remove.example.com/10.0.0.1\naddress=/keep.example.com/10.0.0.2\n"
	os.WriteFile(confPath, []byte(initial), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.removeDnsmasqRecord("to-remove.example.com"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(confPath)
	content := string(data)
	if strings.Contains(content, "to-remove.example.com") {
		t.Error("record should be removed")
	}
	if !strings.Contains(content, "keep.example.com") {
		t.Error("other record should remain")
	}
}

func TestRemoveDnsmasqRecordNonExistent(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	initial := "address=/keep.example.com/10.0.0.2\n"
	os.WriteFile(confPath, []byte(initial), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.removeDnsmasqRecord("nonexistent.example.com"); err != nil {
		t.Fatalf("removing non-existent record should not error: %v", err)
	}

	data, _ := os.ReadFile(confPath)
	content := string(data)
	if !strings.Contains(content, "keep.example.com") {
		t.Error("existing record should remain")
	}
}

func TestAddOpenClashRecordToEmptyFile(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gw", "openclash")
	os.MkdirAll(ocDir, 0755)
	hostsPath := filepath.Join(ocDir, "hosts.list")
	os.WriteFile(hostsPath, []byte(""), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addOpenClashRecord("new.example.com", "10.0.0.1"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hostsPath)
	if !strings.Contains(string(data), "'new.example.com': 10.0.0.1") {
		t.Errorf("record should be added, got: %s", string(data))
	}
}

func TestAddOpenClashRecordUpdateExisting(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gw", "openclash")
	os.MkdirAll(ocDir, 0755)
	hostsPath := filepath.Join(ocDir, "hosts.list")
	initial := "'web.example.com': 192.168.1.1\n'db.example.com': 10.0.0.5\n"
	os.WriteFile(hostsPath, []byte(initial), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addOpenClashRecord("web.example.com", "10.0.0.99"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hostsPath)
	content := string(data)
	if !strings.Contains(content, "'web.example.com': 10.0.0.99") {
		t.Errorf("IP should be updated, got: %s", content)
	}
	if !strings.Contains(content, "'db.example.com': 10.0.0.5") {
		t.Errorf("other record should remain, got: %s", content)
	}
}

func TestRemoveOpenClashRecordExisting(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gw", "openclash")
	os.MkdirAll(ocDir, 0755)
	hostsPath := filepath.Join(ocDir, "hosts.list")
	initial := "'to-remove.example.com': 10.0.0.1\n'keep.example.com': 10.0.0.2\n"
	os.WriteFile(hostsPath, []byte(initial), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.removeOpenClashRecord("to-remove.example.com"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hostsPath)
	content := string(data)
	if strings.Contains(content, "'to-remove.example.com'") {
		t.Error("record should be removed")
	}
	if !strings.Contains(content, "'keep.example.com'") {
		t.Error("other record should remain")
	}
}

func TestRemoveOpenClashRecordNonExistent(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gw", "openclash")
	os.MkdirAll(ocDir, 0755)
	hostsPath := filepath.Join(ocDir, "hosts.list")
	initial := "'keep.example.com': 10.0.0.2\n"
	os.WriteFile(hostsPath, []byte(initial), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.removeOpenClashRecord("nonexistent.example.com"); err != nil {
		t.Fatalf("removing non-existent should not error: %v", err)
	}

	data, _ := os.ReadFile(hostsPath)
	if !strings.Contains(string(data), "'keep.example.com'") {
		t.Error("existing record should remain")
	}
}

func TestAddHeadscaleRecordWithSplitDNS(t *testing.T) {
	dir := t.TempDir()
	hsDir := filepath.Join(dir, "hosts", "hs", "headscale")
	os.MkdirAll(hsDir, 0755)
	configPath := filepath.Join(hsDir, "config.yaml")
	configContent := `dns:
  split_dns:
          - 100.100.100.100
  extra_records:
      - name: "existing.example.com"
        type: "A"
        value: "10.0.0.1"
`
	os.WriteFile(configPath, []byte(configContent), 0644)

	m := &DNSManager{
		baseDir:       dir,
		headscaleHost: "hs",
		headscaleDNS:  "100.100.100.100",
		defaultIP:     "10.0.0.1",
	}
	if err := m.addHeadscaleRecord("new.example.com", "10.0.0.2"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(configPath)
	content := string(data)
	if !strings.Contains(content, "new.example.com:") {
		t.Errorf("domain should be added to split_dns, got: %s", content)
	}
	if !strings.Contains(content, `name: "new.example.com"`) {
		t.Errorf("domain should be added to extra_records, got: %s", content)
	}
}

func TestAddHeadscaleRecordExistingDomainNoop(t *testing.T) {
	dir := t.TempDir()
	hsDir := filepath.Join(dir, "hosts", "hs", "headscale")
	os.MkdirAll(hsDir, 0755)
	configPath := filepath.Join(hsDir, "config.yaml")
	configContent := `dns:
  split_dns:
    existing.example.com:
      - 100.100.100.100
  extra_records:
      - name: "existing.example.com"
        type: "A"
        value: "10.0.0.1"
`
	os.WriteFile(configPath, []byte(configContent), 0644)

	m := &DNSManager{
		baseDir:       dir,
		headscaleHost: "hs",
		headscaleDNS:  "100.100.100.100",
		defaultIP:     "10.0.0.1",
	}
	if err := m.addHeadscaleRecord("existing.example.com", "10.0.0.2"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(configPath)
	if strings.Count(string(data), "existing.example.com") < 2 {
		t.Error("existing domain should not be duplicated but original entries should remain")
	}
}

func TestRemoveHeadscaleRecordExisting(t *testing.T) {
	dir := t.TempDir()
	hsDir := filepath.Join(dir, "hosts", "hs", "headscale")
	os.MkdirAll(hsDir, 0755)
	configPath := filepath.Join(hsDir, "config.yaml")
	configContent := `dns:
  split_dns:
    to-remove.example.com:
      - 100.100.100.100
    keep.example.com:
      - 100.100.100.100
  extra_records:
      - name: "to-remove.example.com"
        type: "A"
        value: "10.0.0.1"
      - name: "keep.example.com"
        type: "A"
        value: "10.0.0.2"
`
	os.WriteFile(configPath, []byte(configContent), 0644)

	m := &DNSManager{
		baseDir:       dir,
		headscaleHost: "hs",
		headscaleDNS:  "100.100.100.100",
		defaultIP:     "10.0.0.1",
	}
	if err := m.removeHeadscaleRecord("to-remove.example.com"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(configPath)
	content := string(data)
	if strings.Contains(content, `name: "to-remove.example.com"`) {
		t.Error("to-remove domain should be removed from extra_records")
	}
	if !strings.Contains(content, `name: "keep.example.com"`) {
		t.Error("keep domain should remain")
	}
}

func TestListDNSRecordsFromAllSources(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{
		filepath.Join(dir, "hosts", "gw", "dnsmasq"),
		filepath.Join(dir, "hosts", "gw", "openclash"),
		filepath.Join(dir, "hosts", "hs", "headscale"),
	} {
		os.MkdirAll(d, 0755)
	}

	os.WriteFile(filepath.Join(dir, "hosts", "gw", "dnsmasq", "dnsmasq.conf"),
		[]byte("address=/dnsmasq.example.com/192.168.1.1\n"), 0644)
	os.WriteFile(filepath.Join(dir, "hosts", "gw", "openclash", "hosts.list"),
		[]byte("'openclash.example.com': 10.0.0.5\n"), 0644)
	os.WriteFile(filepath.Join(dir, "hosts", "hs", "headscale", "config.yaml"),
		[]byte(`dns:
  extra_records:
      - name: "headscale.example.com"
        type: "A"
        value: "10.0.0.10"
`), 0644)

	m := &DNSManager{
		baseDir:       dir,
		gatewayHost:   "gw",
		headscaleHost: "hs",
	}
	records, err := m.ListDNSRecords()
	if err != nil {
		t.Fatal(err)
	}

	found := map[string]string{}
	for _, r := range records {
		found[r.Domain] = r.IP
	}
	if found["dnsmasq.example.com"] != "192.168.1.1" {
		t.Errorf("dnsmasq record: got %v", found)
	}
	if found["openclash.example.com"] != "10.0.0.5" {
		t.Errorf("openclash record: got %v", found)
	}
	if found["headscale.example.com"] != "10.0.0.10" {
		t.Errorf("headscale record: got %v", found)
	}
}

func TestListDNSRecordsPartialSources(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	os.WriteFile(filepath.Join(gwDir, "dnsmasq.conf"),
		[]byte("address=/only-dnsmasq.example.com/192.168.1.1\n"), 0644)

	m := &DNSManager{
		baseDir:       dir,
		gatewayHost:   "gw",
		headscaleHost: "nohost",
	}
	records, err := m.ListDNSRecords()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1", len(records))
	}
	if records[0].Domain != "only-dnsmasq.example.com" {
		t.Errorf("Domain = %q", records[0].Domain)
	}
}

func TestAddDnsmasqRecordIdempotent(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	os.WriteFile(confPath, []byte("address=/web.example.com/192.168.1.1\n"), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addDnsmasqRecord("web.example.com", "10.0.0.99"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(confPath)
	content := string(data)
	if !strings.Contains(content, "address=/web.example.com/10.0.0.99") {
		t.Errorf("existing record IP should be updated, got: %s", content)
	}
	count := strings.Count(content, "address=/web.example.com/")
	if count != 1 {
		t.Errorf("should have exactly 1 entry for web.example.com, got %d", count)
	}
}

func TestAddDnsmasqRecordSpecialChars(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	os.WriteFile(confPath, []byte(""), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addDnsmasqRecord("my-app.example.com", "10.0.0.1"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(confPath)
	if !strings.Contains(string(data), "address=/my-app.example.com/10.0.0.1") {
		t.Errorf("record with hyphen should work, got: %s", string(data))
	}
}

func TestRemoveDnsmasqRecordOnlyEntry(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gw", "dnsmasq")
	os.MkdirAll(gwDir, 0755)
	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	os.WriteFile(confPath, []byte("address=/only.example.com/10.0.0.1\n"), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.removeDnsmasqRecord("only.example.com"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(confPath)
	if strings.Contains(string(data), "only.example.com") {
		t.Error("only entry should be removed")
	}
}

func TestAddOpenClashRecordIdempotent(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gw", "openclash")
	os.MkdirAll(ocDir, 0755)
	hostsPath := filepath.Join(ocDir, "hosts.list")
	os.WriteFile(hostsPath, []byte("'web.example.com': 192.168.1.1\n"), 0644)

	m := &DNSManager{baseDir: dir, gatewayHost: "gw"}
	if err := m.addOpenClashRecord("web.example.com", "10.0.0.99"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hostsPath)
	content := string(data)
	count := strings.Count(content, "'web.example.com':")
	if count != 1 {
		t.Errorf("should have exactly 1 entry for web.example.com, got %d", count)
	}
}
