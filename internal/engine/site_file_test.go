package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCaddyAddSiteNewDomain(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gw", "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	os.WriteFile(caddyPath, []byte(""), 0644)

	m := &SiteManager{caddyPath: caddyPath, defaultDomain: "example.com"}
	if err := m.caddyAddSite("api.example.com", "api:3000"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(caddyPath)
	content := string(data)
	if !strings.Contains(content, "api.example.com {") {
		t.Errorf("new site block should exist, got: %s", content)
	}
	if !strings.Contains(content, "reverse_proxy http://api:3000") {
		t.Errorf("backend should have http prefix, got: %s", content)
	}
	if !strings.Contains(content, "import common") {
		t.Errorf("block should contain import common, got: %s", content)
	}
	if strings.Contains(content, "import authelia") {
		t.Errorf("block should not contain import authelia (snippet 不存在于现网 Caddyfile), got: %s", content)
	}
}

func TestCaddyAddSiteWithHTTPSPrefix(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	os.WriteFile(caddyPath, []byte(""), 0644)

	m := &SiteManager{caddyPath: caddyPath, defaultDomain: "example.com"}
	if err := m.caddyAddSite("secure.example.com", "https://backend:443"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(caddyPath)
	content := string(data)
	if strings.Contains(content, "http://https://backend:443") {
		t.Error("should not double-prefix https://")
	}
	if !strings.Contains(content, "reverse_proxy https://backend:443") {
		t.Errorf("should preserve https prefix, got: %s", content)
	}
}

func TestCaddyAddSiteSkipExisting(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	initial := "existing.example.com {\n    reverse_proxy http://backend\n}\n"
	os.WriteFile(caddyPath, []byte(initial), 0644)

	m := &SiteManager{caddyPath: caddyPath, defaultDomain: "example.com"}
	if err := m.caddyAddSite("existing.example.com", "http://other"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(caddyPath)
	content := string(data)
	if strings.Contains(content, "http://other") {
		t.Error("existing site should not be modified")
	}
}

func TestCaddyRemoveSiteSpecificBlock(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	initial := `first.example.com {
    import common
    reverse_proxy http://first:80
}

second.example.com {
    import common
    reverse_proxy http://second:9090
}

third.example.com {
    import common
    reverse_proxy http://third:3000
}
`
	os.WriteFile(caddyPath, []byte(initial), 0644)

	m := &SiteManager{caddyPath: caddyPath, defaultDomain: "example.com"}
	if err := m.caddyRemoveSite("second.example.com"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(caddyPath)
	content := string(data)
	if strings.Contains(content, "second.example.com") {
		t.Error("second.example.com should be removed")
	}
	if !strings.Contains(content, "first.example.com") {
		t.Error("first.example.com should remain")
	}
	if !strings.Contains(content, "third.example.com") {
		t.Error("third.example.com should remain")
	}
}

func TestHomepageAddSiteToExistingCategory(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hp")
	os.MkdirAll(hpDir, 0755)
	hpPath := filepath.Join(hpDir, "services.yaml")
	content := `- Services:
    - Web:
        href: https://web.example.com
        description: Web service
        icon: mdi-web
- Media:
    - Plex:
        href: https://plex.example.com
        description: Media
        icon: mdi-plex
`
	os.WriteFile(hpPath, []byte(content), 0644)

	m := &SiteManager{homepagePath: hpPath}
	if err := m.homepageAddSite("api.example.com", "API", "API service", "mdi-api", "Services"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hpPath)
	result := string(data)
	if !strings.Contains(result, "href: https://api.example.com") {
		t.Error("new site should be added to Services category")
	}
	if !strings.Contains(result, "href: https://plex.example.com") {
		t.Error("Media category should remain intact")
	}
}

func TestHomepageAddSiteToNewCategory(t *testing.T) {
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
	if err := m.homepageAddSite("grafana.example.com", "Grafana", "Monitoring", "mdi-chart", "Monitoring"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hpPath)
	result := string(data)
	if !strings.Contains(result, "- Monitoring:") {
		t.Error("new category should be created")
	}
	if !strings.Contains(result, "href: https://grafana.example.com") {
		t.Error("new site should be in the new category")
	}
}

func TestHomepageAddSiteSkipExisting(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hp")
	os.MkdirAll(hpDir, 0755)
	hpPath := filepath.Join(hpDir, "services.yaml")
	content := `- Services:
    - Web:
        href: https://web.example.com
        description: Web service
        icon: mdi-web
`
	os.WriteFile(hpPath, []byte(content), 0644)

	m := &SiteManager{homepagePath: hpPath}
	if err := m.homepageAddSite("web.example.com", "Web", "Different desc", "mdi-web", "Services"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hpPath)
	result := string(data)
	if strings.Contains(result, "Different desc") {
		t.Error("existing site should not be modified")
	}
}

func TestHomepageRemoveSiteSpecificEntry(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hp")
	os.MkdirAll(hpDir, 0755)
	hpPath := filepath.Join(hpDir, "services.yaml")
	content := `- Services:
    - Web:
        href: https://web.example.com
        description: Web service
        icon: mdi-web
    - API:
        href: https://api.example.com
        description: API service
        icon: mdi-api
- Media:
    - Plex:
        href: https://plex.example.com
        description: Media
        icon: mdi-plex
`
	os.WriteFile(hpPath, []byte(content), 0644)

	m := &SiteManager{homepagePath: hpPath}
	if err := m.homepageRemoveSite("api.example.com"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(hpPath)
	result := string(data)
	if strings.Contains(result, "href: https://api.example.com") {
		t.Error("api.example.com should be removed")
	}
	if !strings.Contains(result, "href: https://web.example.com") {
		t.Error("web.example.com should remain")
	}
	if !strings.Contains(result, "href: https://plex.example.com") {
		t.Error("Media category should remain intact")
	}
}

func TestListSitesFromCaddyfile(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gw", "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	caddyfile := `web.example.com {
    import common
    import authelia
    reverse_proxy http://web:8080
}

api.example.com {
    import common
    reverse_proxy https://api:443
}

db.example.com {
    import common
    reverse_proxy http://db:5432
}
`
	os.WriteFile(caddyPath, []byte(caddyfile), 0644)

	m := &SiteManager{
		baseDir:       dir,
		gatewayHost:   "gw",
		defaultDomain: "example.com",
		caddyPath:     caddyPath,
	}

	sites, err := m.ListSites()
	if err != nil {
		t.Fatal(err)
	}
	if len(sites) != 3 {
		t.Fatalf("got %d sites, want 3", len(sites))
	}

	found := map[string]string{}
	for _, s := range sites {
		found[s.Domain] = s.Backend
	}
	if found["web.example.com"] != "http://web:8080" {
		t.Errorf("web backend = %q", found["web.example.com"])
	}
	if found["api.example.com"] != "https://api:443" {
		t.Errorf("api backend = %q", found["api.example.com"])
	}
	if found["db.example.com"] != "http://db:5432" {
		t.Errorf("db backend = %q", found["db.example.com"])
	}
}

func TestListSitesWithNonDomainBlocks(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gw", "caddy")
	os.MkdirAll(caddyDir, 0755)
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	caddyfile := `:443 {
    tls internal
    respond "catch-all"
}

web.example.com {
    reverse_proxy http://web:8080
}
`
	os.WriteFile(caddyPath, []byte(caddyfile), 0644)

	m := &SiteManager{
		baseDir:       dir,
		gatewayHost:   "gw",
		defaultDomain: "example.com",
		caddyPath:     caddyPath,
	}

	sites, err := m.ListSites()
	if err != nil {
		t.Fatal(err)
	}
	if len(sites) != 1 {
		t.Fatalf("got %d sites, want 1 (non-domain blocks ignored)", len(sites))
	}
	if sites[0].Domain != "web.example.com" {
		t.Errorf("Domain = %q", sites[0].Domain)
	}
}

func TestDomainToNameCapitalization(t *testing.T) {
	tests := []struct {
		domain, want string
	}{
		{"web.example.com", "Web"},
		{"api.example.com", "Api"},
		{"my-long-name.example.com", "My-long-name"},
		{"example.com", "Example"},
		{"single", "Single"},
		{"0start.example.com", "0start"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.domain, func(t *testing.T) {
			got := domainToName(tt.domain)
			if got != tt.want {
				t.Errorf("domainToName(%q) = %q, want %q", tt.domain, got, tt.want)
			}
		})
	}
}

func TestSiteAddSiteValidation(t *testing.T) {
	m := &SiteManager{}
	if err := m.AddSite("", "http://backend", "Name", "", ""); err == nil {
		t.Error("empty domain should error")
	}
	if err := m.AddSite("web.example.com", "", "Name", "", ""); err == nil {
		t.Error("empty backend should error")
	}
	if err := m.AddSite("web.example.com", "http://backend", "", "", ""); err == nil {
		t.Error("empty name should error")
	}
}

func TestSiteRemoveSiteValidation(t *testing.T) {
	m := &SiteManager{}
	if err := m.RemoveSite(""); err == nil {
		t.Error("empty domain should error")
	}
}

func TestSiteDefaultDescAndIcon(t *testing.T) {
	desc := ""
	name := "Web"
	if desc == "" {
		desc = name + " service"
	}
	if desc != "Web service" {
		t.Errorf("desc = %q, want %q", desc, "Web service")
	}

	icon := ""
	if icon == "" {
		icon = "mdi-application"
	}
	if icon != "mdi-application" {
		t.Errorf("icon = %q, want %q", icon, "mdi-application")
	}
}

func TestCaddyAddSiteMissingFile(t *testing.T) {
	m := &SiteManager{caddyPath: "/nonexistent/Caddyfile", defaultDomain: "example.com"}
	err := m.caddyAddSite("test.example.com", "http://backend")
	if err == nil {
		t.Error("expected error for missing Caddyfile")
	}
}

func TestCaddyRemoveSiteMissingFile(t *testing.T) {
	m := &SiteManager{caddyPath: "/nonexistent/Caddyfile"}
	err := m.caddyRemoveSite("test.example.com")
	if err == nil {
		t.Error("expected error for missing Caddyfile")
	}
}

func TestHomepageAddSiteMissingFile(t *testing.T) {
	m := &SiteManager{homepagePath: "/nonexistent/services.yaml"}
	err := m.homepageAddSite("test.example.com", "Test", "desc", "icon", "Services")
	if err == nil {
		t.Error("expected error for missing services.yaml")
	}
}

func TestHomepageRemoveSiteMissingFile(t *testing.T) {
	m := &SiteManager{homepagePath: "/nonexistent/services.yaml"}
	err := m.homepageRemoveSite("test.example.com")
	if err == nil {
		t.Error("expected error for missing services.yaml")
	}
}

func TestHomepageRemoveSiteNonExistentDomain(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hp")
	os.MkdirAll(hpDir, 0755)
	hpPath := filepath.Join(hpDir, "services.yaml")
	os.WriteFile(hpPath, []byte("- Services:\n    - Web:\n        href: https://web.example.com\n"), 0644)

	m := &SiteManager{homepagePath: hpPath}
	if err := m.homepageRemoveSite("nonexistent.example.com"); err != nil {
		t.Errorf("removing non-existent domain should not error: %v", err)
	}
}

func TestListSitesMissingCaddyfile(t *testing.T) {
	m := &SiteManager{caddyPath: "/nonexistent/Caddyfile", defaultDomain: "example.com"}
	_, err := m.ListSites()
	if err == nil {
		t.Error("expected error for missing Caddyfile")
	}
}
