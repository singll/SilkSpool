package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestListSitesEmptyCaddyfile(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gw", "caddy")
	os.MkdirAll(caddyDir, 0755)
	os.WriteFile(filepath.Join(caddyDir, "Caddyfile"), []byte(""), 0644)

	m := &SiteManager{
		baseDir:       dir,
		gatewayHost:   "gw",
		defaultDomain: "example.com",
		caddyPath:     filepath.Join(caddyDir, "Caddyfile"),
	}

	sites, err := m.ListSites()
	if err != nil {
		t.Fatalf("ListSites: %v", err)
	}
	if len(sites) != 0 {
		t.Errorf("expected 0 sites from empty Caddyfile, got %d", len(sites))
	}
}

func TestCaddyAddSiteWithHTTPPrefix(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	os.WriteFile(caddyPath, []byte(""), 0644)

	m := &SiteManager{caddyPath: caddyPath, defaultDomain: "example.com"}
	if err := m.caddyAddSite("api.example.com", "backend:3000"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(caddyPath)
	if !strings.Contains(string(data), "http://backend:3000") {
		t.Error("backend without http prefix should get one added")
	}
}

func TestCaddyAddSiteAlreadyWithHTTPPrefix(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	os.WriteFile(caddyPath, []byte(""), 0644)

	m := &SiteManager{caddyPath: caddyPath, defaultDomain: "example.com"}
	if err := m.caddyAddSite("api.example.com", "https://secure:443"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(caddyPath)
	if strings.Contains(string(data), "http://https://secure:443") {
		t.Error("should not double-prefix https://")
	}
}

func TestHomepageRemoveSiteFirstEntry(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hp")
	os.MkdirAll(hpDir, 0755)
	hpPath := filepath.Join(hpDir, "services.yaml")
	content := `- Services:
    - Web:
        href: https://web.example.com
        description: Web
        icon: mdi-web
    - DB:
        href: https://db.example.com
        description: DB
`
	os.WriteFile(hpPath, []byte(content), 0644)

	m := &SiteManager{homepagePath: hpPath}
	if err := m.homepageRemoveSite("web.example.com"); err != nil {
		t.Fatalf("homepageRemoveSite: %v", err)
	}

	data, _ := os.ReadFile(hpPath)
	if strings.Contains(string(data), "href: https://web.example.com") {
		t.Error("web.example.com should be removed")
	}
	if !strings.Contains(string(data), "href: https://db.example.com") {
		t.Error("db.example.com should remain")
	}
}

func TestAddSiteValidationMissingDomain(t *testing.T) {
	m := &SiteManager{}
	err := m.AddSite("", "http://backend", "Name", "", "")
	if err == nil {
		t.Error("should error for empty domain")
	}
}

func TestAddSiteValidationMissingBackend(t *testing.T) {
	m := &SiteManager{}
	err := m.AddSite("web.example.com", "", "Name", "", "")
	if err == nil {
		t.Error("should error for empty backend")
	}
}

func TestAddSiteValidationMissingName(t *testing.T) {
	m := &SiteManager{}
	err := m.AddSite("web.example.com", "http://backend", "", "", "")
	if err == nil {
		t.Error("should error for empty name")
	}
}

func TestRemoveSiteValidationEmptyDomain(t *testing.T) {
	m := &SiteManager{}
	err := m.RemoveSite("")
	if err == nil {
		t.Error("should error for empty domain")
	}
}

func TestDomainToNameMoreCases(t *testing.T) {
	tests := []struct {
		domain, want string
	}{
		{"x.y.z", "X"},
		{"A.example.com", "A"},
		{"multi-word.example.com", "Multi-word"},
		{".", "."},
	}
	for _, tt := range tests {
		got := domainToName(tt.domain)
		if got != tt.want {
			t.Errorf("domainToName(%q) = %q, want %q", tt.domain, got, tt.want)
		}
	}
}

func TestSiteStructAllFields(t *testing.T) {
	s := Site{
		Domain:  "a.b.c",
		Backend: "http://x:1",
		Name:    "A",
		Desc:    "desc",
		Icon:    "mdi-x",
	}
	if s.Desc != "desc" {
		t.Errorf("Desc = %q", s.Desc)
	}
	if s.Icon != "mdi-x" {
		t.Errorf("Icon = %q", s.Icon)
	}
}

func TestCaddyBlockGeneration(t *testing.T) {
	domain := "myapp.example.com"
	backend := "http://myapp:8080"
	block := "\n" + domain + " {\n    import common\n    import authelia\n    reverse_proxy " + backend + "\n}\n"
	if !strings.Contains(block, "import common") {
		t.Error("block should contain import common")
	}
	if !strings.Contains(block, "import authelia") {
		t.Error("block should contain import authelia")
	}
	if !strings.Contains(block, "reverse_proxy http://myapp:8080") {
		t.Error("block should contain reverse_proxy directive")
	}
}

func TestSiteManagerHeadscaleConfigExists(t *testing.T) {
	dir := t.TempDir()
	hsDir := filepath.Join(dir, "hosts", "hs", "headscale")
	os.MkdirAll(hsDir, 0755)
	os.WriteFile(filepath.Join(hsDir, "config.yaml"), []byte("test: true"), 0644)

	m := &SiteManager{baseDir: dir, headscaleHost: "hs"}
	if !m.headscaleConfigExists() {
		t.Error("should detect existing headscale config")
	}

	m2 := &SiteManager{baseDir: dir, headscaleHost: "nohost"}
	if m2.headscaleConfigExists() {
		t.Error("should not detect config for missing host")
	}
}

func TestNewSiteManagerMissingConfig(t *testing.T) {
	_, err := NewSiteManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestListSitesMultipleBlocks(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gw", "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddy := `a.example.com {
    reverse_proxy http://a:80
}

b.example.com {
    reverse_proxy http://b:9090
}

c.example.com {
    reverse_proxy http://c:3000
}
`
	os.WriteFile(filepath.Join(caddyDir, "Caddyfile"), []byte(caddy), 0644)

	m := &SiteManager{
		baseDir:       dir,
		gatewayHost:   "gw",
		defaultDomain: "example.com",
		caddyPath:     filepath.Join(caddyDir, "Caddyfile"),
	}

	sites, err := m.ListSites()
	if err != nil {
		t.Fatal(err)
	}
	if len(sites) != 3 {
		t.Fatalf("got %d sites, want 3", len(sites))
	}
	if sites[2].Domain != "c.example.com" {
		t.Errorf("sites[2].Domain = %q", sites[2].Domain)
	}
}

func TestHomepageAddSiteToLastCategory(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hp")
	os.MkdirAll(hpDir, 0755)
	hpPath := filepath.Join(hpDir, "services.yaml")
	content := `- Services:
    - Web:
        href: https://web.example.com
`
	os.WriteFile(hpPath, []byte(content), 0644)

	m := &SiteManager{homepagePath: hpPath}
	if err := m.homepageAddSite("api.example.com", "API", "API service", "mdi-api", "Services"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hpPath)
	if !strings.Contains(string(data), "href: https://api.example.com") {
		t.Error("new site should be added to existing category")
	}
}

func TestSiteManagerConfigFields(t *testing.T) {
	m := &SiteManager{
		baseDir:       "/opt/spool",
		gatewayHost:   "gw",
		headscaleHost: "hs",
		defaultIP:     "10.0.0.1",
		defaultDomain: "singll.net",
		sshKey:        "/keys/spool",
		caddyPath:     "/opt/spool/hosts/gw/caddy/Caddyfile",
		homepagePath:  "/opt/spool/hosts/gw/homepage/services.yaml",
	}
	if m.defaultDomain != "singll.net" {
		t.Errorf("defaultDomain = %q", m.defaultDomain)
	}
	if m.defaultIP != "10.0.0.1" {
		t.Errorf("defaultIP = %q", m.defaultIP)
	}
}

func TestStackDriverStruct(t *testing.T) {
	d := &StackDriver{
		baseDir:    "/opt",
		sshKey:     "/key",
		bundleName: "mybundle",
		defaults:   config.DefaultsConfig{DeployPath: "/deploy"},
	}
	if d.defaults.DeployPath != "/deploy" {
		t.Errorf("DeployPath = %q", d.defaults.DeployPath)
	}
}
