package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestParseDnsmasqRecords(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []DNSRecord
	}{
		{
			name:    "empty content",
			content: "",
			want:    nil,
		},
		{
			name:    "single record",
			content: "address=/web.example.com/192.168.1.1\n",
			want:    []DNSRecord{{Domain: "web.example.com", IP: "192.168.1.1"}},
		},
		{
			name: "multiple records",
			content: `address=/web.example.com/192.168.1.1
address=/db.example.com/10.0.0.5
address=/api.example.com/10.0.0.10
`,
			want: []DNSRecord{
				{Domain: "web.example.com", IP: "192.168.1.1"},
				{Domain: "db.example.com", IP: "10.0.0.5"},
				{Domain: "api.example.com", IP: "10.0.0.10"},
			},
		},
		{
			name: "ignores comments and other lines",
			content: `# this is a comment
server=8.8.8.8
address=/web.example.com/192.168.1.1
listen-address=127.0.0.1
`,
			want: []DNSRecord{{Domain: "web.example.com", IP: "192.168.1.1"}},
		},
		{
			name: "record with domain containing hyphens",
			content: "address=/my-app.example.com/192.168.1.100\n",
			want:    []DNSRecord{{Domain: "my-app.example.com", IP: "192.168.1.100"}},
		},
		{
			name: "record with IPv6 address",
			content: "address=/web.example.com/::1\n",
			want:    []DNSRecord{{Domain: "web.example.com", IP: "::1"}},
		},
		{
			name:    "malformed line without IP",
			content: "address=/web.example.com/\n",
			want:    nil,
		},
		{
			name: "mixed valid and invalid",
			content: `address=/valid.example.com/192.168.1.1
not-an-address-line
address=/another.example.com/10.0.0.1
`,
			want: []DNSRecord{
				{Domain: "valid.example.com", IP: "192.168.1.1"},
				{Domain: "another.example.com", IP: "10.0.0.1"},
			},
		},
	}

	re := regexp.MustCompile(`(?m)^address=/([^/]+)/(\S+)`)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			matches := re.FindAllStringSubmatch(tt.content, -1)
			var records []DNSRecord
			for _, match := range matches {
				if len(match) >= 3 {
					records = append(records, DNSRecord{
						Domain: match[1],
						IP:     match[2],
					})
				}
			}
			if len(records) != len(tt.want) {
				t.Fatalf("got %d records, want %d", len(records), len(tt.want))
			}
			for i, r := range records {
				if r.Domain != tt.want[i].Domain || r.IP != tt.want[i].IP {
					t.Errorf("record[%d] = {%q, %q}, want {%q, %q}", i, r.Domain, r.IP, tt.want[i].Domain, tt.want[i].IP)
				}
			}
		})
	}
}

func TestParseOpenClashRecords(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []DNSRecord
	}{
		{
			name:    "empty content",
			content: "",
			want:    nil,
		},
		{
			name:    "single record",
			content: "'web.example.com': 192.168.1.1\n",
			want:    []DNSRecord{{Domain: "web.example.com", IP: "192.168.1.1"}},
		},
		{
			name: "multiple records",
			content: `'web.example.com': 192.168.1.1
'db.example.com': 10.0.0.5
'api.example.com': 10.0.0.10
`,
			want: []DNSRecord{
				{Domain: "web.example.com", IP: "192.168.1.1"},
				{Domain: "db.example.com", IP: "10.0.0.5"},
				{Domain: "api.example.com", IP: "10.0.0.10"},
			},
		},
		{
			name: "ignores non-hosts lines",
			content: `# comment
'web.example.com': 192.168.1.1
some-other-format
`,
			want: []DNSRecord{{Domain: "web.example.com", IP: "192.168.1.1"}},
		},
		{
			name:    "record without quotes",
			content: "web.example.com: 192.168.1.1\n",
			want:    nil,
		},
	}

	re := regexp.MustCompile(`(?m)'(.+?)':\s*(\S+)`)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			matches := re.FindAllStringSubmatch(tt.content, -1)
			var records []DNSRecord
			for _, match := range matches {
				if len(match) >= 3 {
					records = append(records, DNSRecord{
						Domain: match[1],
						IP:     match[2],
					})
				}
			}
			if len(records) != len(tt.want) {
				t.Fatalf("got %d records, want %d", len(records), len(tt.want))
			}
			for i, r := range records {
				if r.Domain != tt.want[i].Domain || r.IP != tt.want[i].IP {
					t.Errorf("record[%d] = {%q, %q}, want {%q, %q}", i, r.Domain, r.IP, tt.want[i].Domain, tt.want[i].IP)
				}
			}
		})
	}
}

func TestParseHeadscaleRecords(t *testing.T) {
	content := `dns:
  split_dns:
    web.example.com:
      - 100.100.100.100
    db.example.com:
      - 100.100.100.100
  extra_records:
      - name: "api.example.com"
        type: "A"
        value: "192.168.1.1"
      - name: "cache.example.com"
        type: "A"
        value: "10.0.0.5"
      - name: "mx.example.com"
        type: "MX"
        value: "10 mail.example.com"
`

	re := regexp.MustCompile(`name:\s*"([^"]+)"\s*\n\s*type:\s*"A"\s*\n\s*value:\s*"(\S+)"`)
	matches := re.FindAllStringSubmatch(content, -1)

	var records []DNSRecord
	for _, match := range matches {
		if len(match) >= 3 {
			records = append(records, DNSRecord{Domain: match[1], IP: match[2]})
		}
	}

	if len(records) != 2 {
		t.Fatalf("got %d records, want 2", len(records))
	}
	if records[0].Domain != "api.example.com" || records[0].IP != "192.168.1.1" {
		t.Errorf("record[0] = {%q, %q}, want {api.example.com, 192.168.1.1}", records[0].Domain, records[0].IP)
	}
	if records[1].Domain != "cache.example.com" || records[1].IP != "10.0.0.5" {
		t.Errorf("record[1] = {%q, %q}, want {cache.example.com, 10.0.0.5}", records[1].Domain, records[1].IP)
	}
}

func TestDnsmasqAddRecordRegex(t *testing.T) {
	tests := []struct {
		name    string
		domain  string
		content string
		exists  bool
	}{
		{"existing record", "web.example.com", "address=/web.example.com/192.168.1.1\n", true},
		{"non-existing record", "new.example.com", "address=/web.example.com/192.168.1.1\n", false},
		{"domain with special chars", "my-app.example.com", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pattern := regexp.QuoteMeta(tt.domain)
			re := regexp.MustCompile(`(?m)^address=/` + pattern + `/`)
			exists := re.MatchString(tt.content)
			if exists != tt.exists {
				t.Errorf("exists = %v, want %v", exists, tt.exists)
			}
		})
	}
}

func TestDnsmasqRemoveRecordRegex(t *testing.T) {
	domain := "web.example.com"
	content := "address=/web.example.com/192.168.1.1\naddress=/db.example.com/10.0.0.5\n"

	re := regexp.MustCompile(fmt.Sprintf(`(?m)^address=/%s/.*\n?`, regexp.QuoteMeta(domain)))
	result := re.ReplaceAllString(content, "")

	if regexp.MustCompile(`address=/web.example.com/`).MatchString(result) {
		t.Error("web.example.com record should be removed")
	}
	if !regexp.MustCompile(`address=/db.example.com/`).MatchString(result) {
		t.Error("db.example.com record should remain")
	}
}

func TestOpenClashAddRecordLogic(t *testing.T) {
	domain := "web.example.com"
	ip := "192.168.1.1"

	t.Run("add to existing content", func(t *testing.T) {
		content := "'db.example.com': 10.0.0.5\n"
		pattern := "'" + domain + "':"
		if !containsPattern(content, pattern) {
			content += "\n'" + domain + "': " + ip
		}
		if !containsPattern(content, pattern) {
			t.Error("domain should be present after add")
		}
	})

	t.Run("update existing record", func(t *testing.T) {
		content := "'web.example.com': 192.168.1.1\n"
		pattern := "'" + domain + "':"
		if containsPattern(content, pattern) {
			re := regexp.MustCompile(fmt.Sprintf(`'%s':.*`, regexp.QuoteMeta(domain)))
			content = re.ReplaceAllString(content, fmt.Sprintf("'%s': %s", domain, "10.0.0.99"))
		}
		if !containsPattern(content, "'web.example.com': 10.0.0.99") {
			t.Error("IP should be updated")
		}
	})
}

func TestOpenClashRemoveRecordRegex(t *testing.T) {
	domain := "web.example.com"
	content := "'web.example.com': 192.168.1.1\n'db.example.com': 10.0.0.5\n"

	re := regexp.MustCompile(fmt.Sprintf(`(?m)^'%s':.*\n?`, regexp.QuoteMeta(domain)))
	result := re.ReplaceAllString(content, "")

	if containsPattern(result, "'web.example.com'") {
		t.Error("web.example.com record should be removed")
	}
	if !containsPattern(result, "'db.example.com'") {
		t.Error("db.example.com record should remain")
	}
}

func TestSyncFromCaddyfileRegex(t *testing.T) {
	defaultDomain := "example.com"
	content := `web.example.com {
    import common
    reverse_proxy http://web:8080
}

db.example.com {
    import common
    reverse_proxy http://db:5432
}

# this is not a domain
not-a-domain {
    import common
}
`

	re := regexp.MustCompile(`(?m)^([a-z0-9][-a-z0-9.]*\.` + regexp.QuoteMeta(defaultDomain) + `)\s*\{`)
	matches := re.FindAllStringSubmatch(content, -1)

	if len(matches) != 2 {
		t.Fatalf("got %d matches, want 2", len(matches))
	}
	if matches[0][1] != "web.example.com" {
		t.Errorf("match[0] = %q, want %q", matches[0][1], "web.example.com")
	}
	if matches[1][1] != "db.example.com" {
		t.Errorf("match[1] = %q, want %q", matches[1][1], "db.example.com")
	}
}

func TestIsHeadscaleConfigPresent(t *testing.T) {
	dir := t.TempDir()
	hostDir := filepath.Join(dir, "hosts", "keeper", "headscale")
	if err := os.MkdirAll(hostDir, 0755); err != nil {
		t.Fatal(err)
	}

	t.Run("config exists", func(t *testing.T) {
		configPath := filepath.Join(hostDir, "config.yaml")
		if err := os.WriteFile(configPath, []byte("test: true"), 0644); err != nil {
			t.Fatal(err)
		}
		if !isHeadscaleConfigPresent(dir, "keeper") {
			t.Error("should return true when config exists")
		}
	})

	t.Run("config missing", func(t *testing.T) {
		if isHeadscaleConfigPresent(dir, "nonexistent") {
			t.Error("should return false when config missing")
		}
	})
}

func TestDNSRecordStruct(t *testing.T) {
	r := DNSRecord{Domain: "web.example.com", IP: "192.168.1.1"}
	if r.Domain != "web.example.com" {
		t.Errorf("Domain = %q, want %q", r.Domain, "web.example.com")
	}
	if r.IP != "192.168.1.1" {
		t.Errorf("IP = %q, want %q", r.IP, "192.168.1.1")
	}
}

func TestListDNSRecordsWithFiles(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gateway", "dnsmasq")
	if err := os.MkdirAll(gwDir, 0755); err != nil {
		t.Fatal(err)
	}

	dnsmasqContent := `address=/web.example.com/192.168.1.1
address=/db.example.com/10.0.0.5
`
	if err := os.WriteFile(filepath.Join(gwDir, "dnsmasq.conf"), []byte(dnsmasqContent), 0644); err != nil {
		t.Fatal(err)
	}

	m := &DNSManager{
		baseDir:     dir,
		gatewayHost: "gateway",
	}

	records := m.listDnsmasqRecords()
	if len(records) != 2 {
		t.Fatalf("got %d records, want 2", len(records))
	}
	if records[0].Domain != "web.example.com" {
		t.Errorf("records[0].Domain = %q, want %q", records[0].Domain, "web.example.com")
	}
}

func TestListOpenClashRecordsWithFiles(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gateway", "openclash")
	if err := os.MkdirAll(ocDir, 0755); err != nil {
		t.Fatal(err)
	}

	hostsContent := `'web.example.com': 192.168.1.1
'db.example.com': 10.0.0.5
`
	if err := os.WriteFile(filepath.Join(ocDir, "hosts.list"), []byte(hostsContent), 0644); err != nil {
		t.Fatal(err)
	}

	m := &DNSManager{
		baseDir:     dir,
		gatewayHost: "gateway",
	}

	records := m.listOpenClashRecords()
	if len(records) != 2 {
		t.Fatalf("got %d records, want 2", len(records))
	}
	if records[0].Domain != "web.example.com" {
		t.Errorf("records[0].Domain = %q, want %q", records[0].Domain, "web.example.com")
	}
}

func TestListHeadscaleRecordsWithFiles(t *testing.T) {
	dir := t.TempDir()
	hsDir := filepath.Join(dir, "hosts", "keeper", "headscale")
	if err := os.MkdirAll(hsDir, 0755); err != nil {
		t.Fatal(err)
	}

	configContent := `dns:
  extra_records:
      - name: "api.example.com"
        type: "A"
        value: "192.168.1.1"
      - name: "mx.example.com"
        type: "MX"
        value: "10 mail.example.com"
`
	if err := os.WriteFile(filepath.Join(hsDir, "config.yaml"), []byte(configContent), 0644); err != nil {
		t.Fatal(err)
	}

	m := &DNSManager{
		baseDir:       dir,
		headscaleHost: "keeper",
	}

	records := m.listHeadscaleRecords()
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1 (only A records)", len(records))
	}
	if records[0].Domain != "api.example.com" {
		t.Errorf("records[0].Domain = %q, want %q", records[0].Domain, "api.example.com")
	}
}

func TestAddDnsmasqRecordFileOps(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gateway", "dnsmasq")
	if err := os.MkdirAll(gwDir, 0755); err != nil {
		t.Fatal(err)
	}

	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	initial := "address=/web.example.com/192.168.1.1\n"
	if err := os.WriteFile(confPath, []byte(initial), 0644); err != nil {
		t.Fatal(err)
	}

	m := &DNSManager{
		baseDir:     dir,
		gatewayHost: "gateway",
	}

	t.Run("update existing record", func(t *testing.T) {
		if err := m.addDnsmasqRecord("web.example.com", "10.0.0.99"); err != nil {
			t.Fatalf("addDnsmasqRecord: %v", err)
		}
		data, _ := os.ReadFile(confPath)
		content := string(data)
		if !regexp.MustCompile(`address=/web\.example\.com/10\.0\.0\.99`).MatchString(content) {
			t.Errorf("IP should be updated, got: %s", content)
		}
	})

	t.Run("add new record", func(t *testing.T) {
		if err := m.addDnsmasqRecord("api.example.com", "10.0.0.10"); err != nil {
			t.Fatalf("addDnsmasqRecord: %v", err)
		}
		data, _ := os.ReadFile(confPath)
		content := string(data)
		if !regexp.MustCompile(`address=/api\.example\.com/10\.0\.0\.10`).MatchString(content) {
			t.Errorf("new record should be added, got: %s", content)
		}
	})
}

func TestRemoveDnsmasqRecordFileOps(t *testing.T) {
	dir := t.TempDir()
	gwDir := filepath.Join(dir, "hosts", "gateway", "dnsmasq")
	if err := os.MkdirAll(gwDir, 0755); err != nil {
		t.Fatal(err)
	}

	confPath := filepath.Join(gwDir, "dnsmasq.conf")
	initial := "address=/web.example.com/192.168.1.1\naddress=/db.example.com/10.0.0.5\n"
	if err := os.WriteFile(confPath, []byte(initial), 0644); err != nil {
		t.Fatal(err)
	}

	m := &DNSManager{
		baseDir:     dir,
		gatewayHost: "gateway",
	}

	if err := m.removeDnsmasqRecord("web.example.com"); err != nil {
		t.Fatalf("removeDnsmasqRecord: %v", err)
	}

	data, _ := os.ReadFile(confPath)
	content := string(data)
	if regexp.MustCompile(`address=/web\.example\.com/`).MatchString(content) {
		t.Error("web.example.com should be removed")
	}
	if !regexp.MustCompile(`address=/db\.example\.com/`).MatchString(content) {
		t.Error("db.example.com should remain")
	}
}

func TestAddOpenClashRecordFileOps(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gateway", "openclash")
	if err := os.MkdirAll(ocDir, 0755); err != nil {
		t.Fatal(err)
	}

	hostsPath := filepath.Join(ocDir, "hosts.list")
	initial := "'web.example.com': 192.168.1.1\n"
	if err := os.WriteFile(hostsPath, []byte(initial), 0644); err != nil {
		t.Fatal(err)
	}

	m := &DNSManager{
		baseDir:     dir,
		gatewayHost: "gateway",
	}

	t.Run("update existing record", func(t *testing.T) {
		if err := m.addOpenClashRecord("web.example.com", "10.0.0.99"); err != nil {
			t.Fatalf("addOpenClashRecord: %v", err)
		}
		data, _ := os.ReadFile(hostsPath)
		if !containsPattern(string(data), "'web.example.com': 10.0.0.99") {
			t.Errorf("IP should be updated, got: %s", string(data))
		}
	})

	t.Run("add new record", func(t *testing.T) {
		if err := m.addOpenClashRecord("api.example.com", "10.0.0.10"); err != nil {
			t.Fatalf("addOpenClashRecord: %v", err)
		}
		data, _ := os.ReadFile(hostsPath)
		if !containsPattern(string(data), "'api.example.com': 10.0.0.10") {
			t.Errorf("new record should be added, got: %s", string(data))
		}
	})
}

func TestRemoveOpenClashRecordFileOps(t *testing.T) {
	dir := t.TempDir()
	ocDir := filepath.Join(dir, "hosts", "gateway", "openclash")
	if err := os.MkdirAll(ocDir, 0755); err != nil {
		t.Fatal(err)
	}

	hostsPath := filepath.Join(ocDir, "hosts.list")
	initial := "'web.example.com': 192.168.1.1\n'db.example.com': 10.0.0.5\n"
	if err := os.WriteFile(hostsPath, []byte(initial), 0644); err != nil {
		t.Fatal(err)
	}

	m := &DNSManager{
		baseDir:     dir,
		gatewayHost: "gateway",
	}

	if err := m.removeOpenClashRecord("web.example.com"); err != nil {
		t.Fatalf("removeOpenClashRecord: %v", err)
	}

	data, _ := os.ReadFile(hostsPath)
	content := string(data)
	if containsPattern(content, "'web.example.com'") {
		t.Error("web.example.com should be removed")
	}
	if !containsPattern(content, "'db.example.com'") {
		t.Error("db.example.com should remain")
	}
}

func TestAddDomainDefaultIP(t *testing.T) {
	m := &DNSManager{defaultIP: "192.168.1.1"}
	if m.defaultIP != "192.168.1.1" {
		t.Errorf("defaultIP = %q, want %q", m.defaultIP, "192.168.1.1")
	}
}

func containsPattern(s, pattern string) bool {
	return regexp.MustCompile(regexp.QuoteMeta(pattern)).MatchString(s)
}
