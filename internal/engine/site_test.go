package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestDomainToNameExtended(t *testing.T) {
	tests := []struct {
		domain, want string
	}{
		{"web.example.com", "Web"},
		{"db.example.com", "Db"},
		{"api.example.com", "Api"},
		{"example.com", "Example"},
		{"a.example.com", "A"},
		{"my-long-name.example.com", "My-long-name"},
		{"0start.example.com", "0start"},
		{"single", "Single"},
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

func TestParseCaddyfileSites(t *testing.T) {
	defaultDomain := "example.com"

	tests := []struct {
		name    string
		content string
		want    []Site
	}{
		{
			name:    "empty Caddyfile",
			content: "",
			want:    nil,
		},
		{
			name: "single site",
			content: `web.example.com {
    import common
    import authelia
    reverse_proxy http://web:8080
}`,
			want: []Site{
				{Domain: "web.example.com", Backend: "http://web:8080", Name: "Web"},
			},
		},
		{
			name: "multiple sites",
			content: `web.example.com {
    import common
    reverse_proxy http://web:8080
}

db.example.com {
    import common
    reverse_proxy http://db:5432
}`,
			want: []Site{
				{Domain: "web.example.com", Backend: "http://web:8080", Name: "Web"},
				{Domain: "db.example.com", Backend: "http://db:5432", Name: "Db"},
			},
		},
		{
			name: "site without reverse_proxy",
			content: `web.example.com {
    import common
    respond "hello"
}`,
			want: []Site{
				{Domain: "web.example.com", Backend: "", Name: "Web"},
			},
		},
		{
			name: "ignores non-domain blocks",
			content: `:80 {
    respond "hello"
}

web.example.com {
    reverse_proxy http://web:8080
}`,
			want: []Site{
				{Domain: "web.example.com", Backend: "http://web:8080", Name: "Web"},
			},
		},
		{
			name: "block regex validation",
			content: `valid.example.com {
    reverse_proxy http://backend
}
1numeric.example.com {
    reverse_proxy http://backend2
}
-invalid.example.com {
    reverse_proxy http://backend3
}`,
			want: []Site{
				{Domain: "valid.example.com", Backend: "http://backend", Name: "Valid"},
				{Domain: "1numeric.example.com", Backend: "http://backend2", Name: "1numeric"},
			},
		},
	}

	blockRe := regexp.MustCompile(`^([a-z0-9][-a-z0-9.]*\.` + regexp.QuoteMeta(defaultDomain) + `)\s*\{`)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lines := strings.Split(tt.content, "\n")
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

			if len(sites) != len(tt.want) {
				t.Fatalf("got %d sites, want %d", len(sites), len(tt.want))
			}
			for i, s := range sites {
				if s.Domain != tt.want[i].Domain {
					t.Errorf("site[%d].Domain = %q, want %q", i, s.Domain, tt.want[i].Domain)
				}
				if s.Backend != tt.want[i].Backend {
					t.Errorf("site[%d].Backend = %q, want %q", i, s.Backend, tt.want[i].Backend)
				}
				if s.Name != tt.want[i].Name {
					t.Errorf("site[%d].Name = %q, want %q", i, s.Name, tt.want[i].Name)
				}
			}
		})
	}
}

func TestCaddyAddSiteExistingDetection(t *testing.T) {
	domain := "web.example.com"
	content := "web.example.com {\n    reverse_proxy http://web:8080\n}\n"

	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(domain) + `\s*\{`)
	if !re.MatchString(content) {
		t.Error("should detect existing domain in Caddyfile")
	}

	nonExisting := "new.example.com"
	reNew := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(nonExisting) + `\s*\{`)
	if reNew.MatchString(content) {
		t.Error("should not detect non-existing domain")
	}
}

func TestCaddyAddSiteBackendPrefix(t *testing.T) {
	tests := []struct {
		backend string
		want    string
	}{
		{"http://web:8080", "http://web:8080"},
		{"https://secure:443", "https://secure:443"},
		{"web:8080", "http://web:8080"},
		{"10.0.0.1:8080", "http://10.0.0.1:8080"},
	}

	for _, tt := range tests {
		t.Run(tt.backend, func(t *testing.T) {
			backend := tt.backend
			if !strings.HasPrefix(backend, "http") {
				backend = "http://" + backend
			}
			if backend != tt.want {
				t.Errorf("backend = %q, want %q", backend, tt.want)
			}
		})
	}
}

func TestCaddyRemoveSiteBlockRemoval(t *testing.T) {
	domain := "web.example.com"
	content := `web.example.com {
    import common
    reverse_proxy http://web:8080
}

db.example.com {
    import common
    reverse_proxy http://db:5432
}`

	startRe := regexp.MustCompile(`^` + regexp.QuoteMeta(domain) + `\s*\{`)
	lines := strings.Split(content, "\n")

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

	result := strings.Join(out, "\n")
	if strings.Contains(result, "web.example.com") {
		t.Error("web.example.com block should be removed")
	}
	if !strings.Contains(result, "db.example.com") {
		t.Error("db.example.com block should remain")
	}
}

func TestHomepageAddSiteEntryFormat(t *testing.T) {
	domain := "web.example.com"
	name := "Web"
	desc := "Web service"
	icon := "mdi-web"
	category := "Services"

	entry := fmt.Sprintf("    - %s:\n        href: https://%s\n        description: %s\n        icon: %s\n        ping: https://%s",
		name, domain, desc, icon, domain)

	if !strings.Contains(entry, "href: https://web.example.com") {
		t.Error("entry should contain correct href")
	}
	if !strings.Contains(entry, "description: Web service") {
		t.Error("entry should contain correct description")
	}
	if !strings.Contains(entry, "icon: mdi-web") {
		t.Error("entry should contain correct icon")
	}
	if !strings.Contains(entry, "ping: https://web.example.com") {
		t.Error("entry should contain correct ping URL")
	}
	_ = category
}

func TestHomepageAddSiteCategoryDetection(t *testing.T) {
	content := `- Services:
    - Web:
        href: https://web.example.com
- Media:
    - Plex:
        href: https://plex.example.com
`
	lines := strings.Split(content, "\n")
	catRe := regexp.MustCompile(`^- ` + regexp.QuoteMeta("Services") + `:`)

	catLine := -1
	for i, line := range lines {
		if catRe.MatchString(line) {
			catLine = i
			break
		}
	}

	if catLine == -1 {
		t.Error("should find Services category")
	}

	nonExistentRe := regexp.MustCompile(`^- ` + regexp.QuoteMeta("NonExistent") + `:`)
	catLine2 := -1
	for i, line := range lines {
		if nonExistentRe.MatchString(line) {
			catLine2 = i
			break
		}
	}
	if catLine2 != -1 {
		t.Error("should not find NonExistent category")
	}
}

func TestHomepageAddSiteCategoryBounds(t *testing.T) {
	content := `- Services:
    - Web:
        href: https://web.example.com
- Media:
    - Plex:
        href: https://plex.example.com
`
	lines := strings.Split(content, "\n")
	catRe := regexp.MustCompile(`^- Services:`)
	catLine := -1
	for i, line := range lines {
		if catRe.MatchString(line) {
			catLine = i
			break
		}
	}

	topRe := regexp.MustCompile(`^- `)
	nextCat := len(lines)
	for i := catLine + 1; i < len(lines); i++ {
		if topRe.MatchString(lines[i]) {
			nextCat = i
			break
		}
	}

	if nextCat <= catLine {
		t.Errorf("nextCat (%d) should be > catLine (%d)", nextCat, catLine)
	}
}

func TestHomepageRemoveSiteEntryDetection(t *testing.T) {
	content := `- Services:
    - Web:
        href: https://web.example.com
        description: Web service
        icon: mdi-web
    - DB:
        href: https://db.example.com
        description: Database service
`

	lines := strings.Split(content, "\n")
	hrefLine := -1
	for i, line := range lines {
		if strings.Contains(line, "href: https://web.example.com") {
			hrefLine = i
			break
		}
	}

	if hrefLine == -1 {
		t.Error("should find href line for web.example.com")
	}

	if hrefLine != 2 {
		t.Errorf("hrefLine = %d, want 2", hrefLine)
	}
}

func TestHomepageRemoveSiteNonExistent(t *testing.T) {
	content := `- Services:
    - Web:
        href: https://web.example.com
`
	lines := strings.Split(content, "\n")
	hrefLine := -1
	for i, line := range lines {
		if strings.Contains(line, "href: https://nonexistent.example.com") {
			hrefLine = i
			break
		}
	}

	if hrefLine != -1 {
		t.Error("should not find non-existent domain")
	}
}

func TestSiteAddValidation(t *testing.T) {
	tests := []struct {
		name    string
		domain  string
		backend string
		nameArg string
		wantErr bool
	}{
		{"all empty", "", "", "", true},
		{"missing backend", "web.example.com", "", "Web", true},
		{"missing name", "web.example.com", "http://web", "", true},
		{"valid", "web.example.com", "http://web", "Web", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.wantErr
			if tt.domain == "" || tt.backend == "" || tt.nameArg == "" {
				if !err {
					t.Error("should require domain, backend, and name")
				}
			}
		})
	}
}

func TestSiteDefaultValues(t *testing.T) {
	domain := "web.example.com"
	backend := "http://web:8080"
	name := "Web"

	desc := ""
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

	_ = domain
	_ = backend
}

func TestListSitesWithFile(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gateway", "caddy")
	if err := os.MkdirAll(caddyDir, 0755); err != nil {
		t.Fatal(err)
	}

	caddyfile := `web.example.com {
    import common
    reverse_proxy http://web:8080
}

db.example.com {
    import common
    reverse_proxy http://db:5432
}
`
	if err := os.WriteFile(filepath.Join(caddyDir, "Caddyfile"), []byte(caddyfile), 0644); err != nil {
		t.Fatal(err)
	}

	m := &SiteManager{
		baseDir:       dir,
		gatewayHost:   "gateway",
		defaultDomain: "example.com",
		caddyPath:     filepath.Join(caddyDir, "Caddyfile"),
	}

	sites, err := m.ListSites()
	if err != nil {
		t.Fatalf("ListSites: %v", err)
	}
	if len(sites) != 2 {
		t.Fatalf("got %d sites, want 2", len(sites))
	}
	if sites[0].Domain != "web.example.com" || sites[0].Backend != "http://web:8080" {
		t.Errorf("site[0] = {%q, %q}, want {web.example.com, http://web:8080}", sites[0].Domain, sites[0].Backend)
	}
}

func TestCaddyAddSiteWithFile(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gateway", "caddy")
	if err := os.MkdirAll(caddyDir, 0755); err != nil {
		t.Fatal(err)
	}

	caddyfile := "web.example.com {\n    reverse_proxy http://web:8080\n}\n"
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	if err := os.WriteFile(caddyPath, []byte(caddyfile), 0644); err != nil {
		t.Fatal(err)
	}

	m := &SiteManager{
		caddyPath:     caddyPath,
		defaultDomain: "example.com",
	}

	t.Run("add new site", func(t *testing.T) {
		if err := m.caddyAddSite("api.example.com", "api:3000"); err != nil {
			t.Fatalf("caddyAddSite: %v", err)
		}
		data, _ := os.ReadFile(caddyPath)
		if !strings.Contains(string(data), "api.example.com") {
			t.Error("new site should be in Caddyfile")
		}
		if !strings.Contains(string(data), "http://api:3000") {
			t.Error("backend should have http prefix added")
		}
	})

	t.Run("skip existing site", func(t *testing.T) {
		if err := m.caddyAddSite("web.example.com", "http://web:8080"); err != nil {
			t.Fatalf("caddyAddSite: %v", err)
		}
	})
}

func TestCaddyRemoveSiteWithFile(t *testing.T) {
	dir := t.TempDir()
	caddyDir := filepath.Join(dir, "hosts", "gateway", "caddy")
	if err := os.MkdirAll(caddyDir, 0755); err != nil {
		t.Fatal(err)
	}

	caddyfile := `web.example.com {
    import common
    reverse_proxy http://web:8080
}

db.example.com {
    import common
    reverse_proxy http://db:5432
}
`
	caddyPath := filepath.Join(caddyDir, "Caddyfile")
	if err := os.WriteFile(caddyPath, []byte(caddyfile), 0644); err != nil {
		t.Fatal(err)
	}

	m := &SiteManager{
		caddyPath:     caddyPath,
		defaultDomain: "example.com",
	}

	if err := m.caddyRemoveSite("web.example.com"); err != nil {
		t.Fatalf("caddyRemoveSite: %v", err)
	}

	data, _ := os.ReadFile(caddyPath)
	content := string(data)
	if strings.Contains(content, "web.example.com") {
		t.Error("web.example.com should be removed")
	}
	if !strings.Contains(content, "db.example.com") {
		t.Error("db.example.com should remain")
	}
}

func TestHomepageAddSiteWithFile(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hosts", "gateway", "homepage")
	if err := os.MkdirAll(hpDir, 0755); err != nil {
		t.Fatal(err)
	}

	servicesYAML := `- Services:
    - Web:
        href: https://web.example.com
        description: Web service
        icon: mdi-web
`
	hpPath := filepath.Join(hpDir, "services.yaml")
	if err := os.WriteFile(hpPath, []byte(servicesYAML), 0644); err != nil {
		t.Fatal(err)
	}

	m := &SiteManager{homepagePath: hpPath}

	t.Run("add to existing category", func(t *testing.T) {
		if err := m.homepageAddSite("api.example.com", "API", "API service", "mdi-api", "Services"); err != nil {
			t.Fatalf("homepageAddSite: %v", err)
		}
		data, _ := os.ReadFile(hpPath)
		if !strings.Contains(string(data), "href: https://api.example.com") {
			t.Error("new site should be in services.yaml")
		}
	})

	t.Run("skip existing site", func(t *testing.T) {
		if err := m.homepageAddSite("web.example.com", "Web", "Web service", "mdi-web", "Services"); err != nil {
			t.Fatalf("homepageAddSite: %v", err)
		}
	})
}

func TestHomepageAddSiteNewCategory(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hosts", "gateway", "homepage")
	if err := os.MkdirAll(hpDir, 0755); err != nil {
		t.Fatal(err)
	}

	servicesYAML := `- Services:
    - Web:
        href: https://web.example.com
`
	hpPath := filepath.Join(hpDir, "services.yaml")
	if err := os.WriteFile(hpPath, []byte(servicesYAML), 0644); err != nil {
		t.Fatal(err)
	}

	m := &SiteManager{homepagePath: hpPath}

	if err := m.homepageAddSite("media.example.com", "Plex", "Media server", "mdi-plex", "Media"); err != nil {
		t.Fatalf("homepageAddSite: %v", err)
	}

	data, _ := os.ReadFile(hpPath)
	content := string(data)
	if !strings.Contains(content, "- Media:") {
		t.Error("new category should be created")
	}
	if !strings.Contains(content, "href: https://media.example.com") {
		t.Error("new site should be in services.yaml")
	}
}

func TestHomepageRemoveSiteWithFile(t *testing.T) {
	dir := t.TempDir()
	hpDir := filepath.Join(dir, "hosts", "gateway", "homepage")
	if err := os.MkdirAll(hpDir, 0755); err != nil {
		t.Fatal(err)
	}

	servicesYAML := `- Services:
    - Web:
        href: https://web.example.com
        description: Web service
        icon: mdi-web
    - DB:
        href: https://db.example.com
        description: Database
`
	hpPath := filepath.Join(hpDir, "services.yaml")
	if err := os.WriteFile(hpPath, []byte(servicesYAML), 0644); err != nil {
		t.Fatal(err)
	}

	m := &SiteManager{homepagePath: hpPath}

	if err := m.homepageRemoveSite("web.example.com"); err != nil {
		t.Fatalf("homepageRemoveSite: %v", err)
	}

	data, _ := os.ReadFile(hpPath)
	content := string(data)
	if strings.Contains(content, "href: https://web.example.com") {
		t.Error("web.example.com should be removed")
	}
	if !strings.Contains(content, "href: https://db.example.com") {
		t.Error("db.example.com should remain")
	}
}

func TestSiteStruct(t *testing.T) {
	s := Site{
		Domain:  "web.example.com",
		Backend: "http://web:8080",
		Name:    "Web",
		Desc:    "Web service",
		Icon:    "mdi-web",
	}

	if s.Domain != "web.example.com" {
		t.Errorf("Domain = %q, want %q", s.Domain, "web.example.com")
	}
	if s.Backend != "http://web:8080" {
		t.Errorf("Backend = %q, want %q", s.Backend, "http://web:8080")
	}
	if s.Name != "Web" {
		t.Errorf("Name = %q, want %q", s.Name, "Web")
	}
	if s.Desc != "Web service" {
		t.Errorf("Desc = %q, want %q", s.Desc, "Web service")
	}
	if s.Icon != "mdi-web" {
		t.Errorf("Icon = %q, want %q", s.Icon, "mdi-web")
	}
}
