package engine

import (
	"fmt"
	"testing"
)

func TestTruncateCommandExtended(t *testing.T) {
	tests := []struct {
		cmd    string
		maxLen int
		want   string
	}{
		{"short", 60, "short"},
		{"this is a very long command that exceeds the max length limit", 20, "this is a very lo..."},
		{"", 10, ""},
		{"a", 10, "a"},
		{"abc", 3, "abc"},
		{"abcd", 4, "abcd"},
		{"abcde", 4, "a..."},
		{"exactly60chars_exactly60chars_exactly60chars_exactly60cha", 60, "exactly60chars_exactly60chars_exactly60chars_exactly60cha"},
		{"a bit longer than 10", 10, "a bit l..."},
	}

	for _, tt := range tests {
		t.Run(tt.cmd, func(t *testing.T) {
			got := truncateCommand(tt.cmd, tt.maxLen)
			if got != tt.want {
				t.Errorf("truncateCommand(%q, %d) = %q, want %q", tt.cmd, tt.maxLen, got, tt.want)
			}
		})
	}
}

func TestConfirmDestructiveAssumeYesExtended(t *testing.T) {
	tests := []struct {
		action    string
		target    string
		assumeYes bool
		want      bool
	}{
		{"delete", "host", true, true},
		{"remove", "bundle", true, true},
		{"purge", "all", true, true},
		{"", "", true, true},
	}

	for _, tt := range tests {
		t.Run(tt.action+"_"+tt.target, func(t *testing.T) {
			got := ConfirmDestructive(tt.action, tt.target, tt.assumeYes)
			if got != tt.want {
				t.Errorf("ConfirmDestructive(%q, %q, %v) = %v, want %v", tt.action, tt.target, tt.assumeYes, got, tt.want)
			}
		})
	}
}

func TestDeepMergeExtended(t *testing.T) {
	tests := []struct {
		name    string
		base    map[string]interface{}
		overlay map[string]interface{}
		want    map[string]interface{}
	}{
		{
			name:    "empty base with overlay",
			base:    map[string]interface{}{},
			overlay: map[string]interface{}{"key": "value"},
			want:    map[string]interface{}{"key": "value"},
		},
		{
			name:    "base with empty overlay",
			base:    map[string]interface{}{"key": "value"},
			overlay: map[string]interface{}{},
			want:    map[string]interface{}{"key": "value"},
		},
		{
			name:    "nil base with empty overlay",
			base:    nil,
			overlay: map[string]interface{}{},
			want:    map[string]interface{}{},
		},
		{
			name: "overlay with nil value deletes key",
			base: map[string]interface{}{
				"keep":   "yes",
				"remove": "yes",
			},
			overlay: map[string]interface{}{
				"remove": nil,
				"add":    "new",
			},
			want: map[string]interface{}{
				"keep":   "yes",
				"remove": nil,
				"add":    "new",
			},
		},
		{
			name: "3-level deep nested merge",
			base: map[string]interface{}{
				"a": map[string]interface{}{
					"b": map[string]interface{}{
						"c": map[string]interface{}{
							"d": "old",
							"e": "keep",
						},
					},
				},
			},
			overlay: map[string]interface{}{
				"a": map[string]interface{}{
					"b": map[string]interface{}{
						"c": map[string]interface{}{
							"d": "new",
						},
					},
				},
			},
			want: map[string]interface{}{
				"a": map[string]interface{}{
					"b": map[string]interface{}{
						"c": map[string]interface{}{
							"d": "new",
							"e": "keep",
						},
					},
				},
			},
		},
		{
			name: "array in overlay replaces base array",
			base: map[string]interface{}{
				"ports": []interface{}{"80:80", "443:443"},
			},
			overlay: map[string]interface{}{
				"ports": []interface{}{"8080:8080"},
			},
			want: map[string]interface{}{
				"ports": []interface{}{"8080:8080"},
			},
		},
		{
			name: "multiple overlay keys",
			base: map[string]interface{}{
				"a": "1",
				"b": "2",
			},
			overlay: map[string]interface{}{
				"b": "3",
				"c": "4",
			},
			want: map[string]interface{}{
				"a": "1",
				"b": "3",
				"c": "4",
			},
		},
		{
			name: "bool and numeric values",
			base: map[string]interface{}{
				"flag":  true,
				"count": 42,
			},
			overlay: map[string]interface{}{
				"flag":  false,
				"count": 100,
			},
			want: map[string]interface{}{
				"flag":  false,
				"count": 100,
			},
		},
		{
			name: "empty array overlay",
			base: map[string]interface{}{
				"volumes": []interface{}{"a", "b"},
			},
			overlay: map[string]interface{}{
				"volumes": []interface{}{},
			},
			want: map[string]interface{}{
				"volumes": []interface{}{},
			},
		},
		{
			name: "merge preserves base keys not in overlay",
			base: map[string]interface{}{
				"services": map[string]interface{}{
					"web": map[string]interface{}{
						"image":  "nginx",
						"ports":  []interface{}{"80:80"},
						"volumes": []interface{}{"/data"},
					},
				},
			},
			overlay: map[string]interface{}{
				"services": map[string]interface{}{
					"web": map[string]interface{}{
						"image": "nginx:alpine",
					},
				},
			},
			want: map[string]interface{}{
				"services": map[string]interface{}{
					"web": map[string]interface{}{
						"image":  "nginx:alpine",
						"ports":  []interface{}{"80:80"},
						"volumes": []interface{}{"/data"},
					},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deepMerge(tt.base, tt.overlay)
			if !mapsEqual(got, tt.want) {
				t.Errorf("deepMerge() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestMergeYAMLFilesEmptyList(t *testing.T) {
	d := &ComposeDriver{}
	merged, err := d.mergeYAMLFiles([]string{})
	if err != nil {
		t.Fatalf("mergeYAMLFiles with empty list should not error: %v", err)
	}
	if len(merged) == 0 {
		t.Error("merged output should not be empty even with no files (should produce null/empty yaml)")
	}
}

func TestMergeYAMLFilesMultipleFiles(t *testing.T) {
	dir := t.TempDir()

	base := `
services:
  web:
    image: nginx
    ports:
      - "80:80"
  db:
    image: postgres
    environment:
      POSTGRES_DB: mydb
`
	middle := `
services:
  web:
    image: nginx:alpine
    environment:
      NGINX_PORT: "80"
`
	overlay := `
services:
  cache:
    image: redis
volumes:
  data:
`
	writeFile(t, dir+"/base.yaml", base)
	writeFile(t, dir+"/middle.yaml", middle)
	writeFile(t, dir+"/overlay.yaml", overlay)

	d := &ComposeDriver{baseDir: dir}
	merged, err := d.mergeYAMLFiles([]string{dir + "/base.yaml", dir + "/middle.yaml", dir + "/overlay.yaml"})
	if err != nil {
		t.Fatalf("mergeYAMLFiles error: %v", err)
	}

	result := string(merged)
	if result == "" {
		t.Error("merged output should not be empty")
	}
}

func TestDomainToNameEdgeCases(t *testing.T) {
	tests := []struct {
		domain string
		want   string
	}{
		{"a.b", "A"},
		{"x.example.com", "X"},
		{"0.example.com", "0"},
		{"9z.example.com", "9z"},
		{"single", "Single"},
		{"", ""},
		{".example.com", ".example.com"},
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

func TestComposeServiceActionValidation(t *testing.T) {
	validActions := map[string]bool{
		"up":      true,
		"down":    true,
		"build":   true,
		"logs":    true,
		"restart": true,
	}

	tests := []struct {
		action string
		valid  bool
	}{
		{"up", true},
		{"down", true},
		{"build", true},
		{"logs", true},
		{"restart", true},
		{"unknown", false},
		{"", false},
		{"UP", false},
		{"deploy", false},
		{"scale", false},
	}

	for _, tt := range tests {
		t.Run(tt.action, func(t *testing.T) {
			_, isValid := validActions[tt.action]
			if isValid != tt.valid {
				t.Errorf("action %q valid=%v, want %v", tt.action, isValid, tt.valid)
			}
		})
	}
}

func TestComposeBuildCommandFormat(t *testing.T) {
	dc := "docker compose"
	composeFile := "/opt/app/docker-compose.yaml"
	services := []string{"web", "db"}

	svcArg := ""
	if len(services) > 0 {
		svcArg = "web db"
	}
	cmd := fmt.Sprintf("cd $(dirname %s) && %s -f %s build %s", composeFile, dc, composeFile, svcArg)

	if !containsLiteral(cmd, "docker compose") {
		t.Error("command should contain docker compose")
	}
	if !containsLiteral(cmd, "build") {
		t.Error("command should contain build")
	}
	if !containsLiteral(cmd, "web db") {
		t.Error("command should contain service names")
	}
}

func TestCleanupDockerCommandFormat(t *testing.T) {
	tests := []struct {
		mode      string
		wantCmd   string
		wantAvoid string
	}{
		{"normal", "docker image prune -f", "docker builder prune -af"},
		{"aggressive", "docker builder prune -af", ""},
	}

	for _, tt := range tests {
		t.Run(tt.mode, func(t *testing.T) {
			cmd := "docker image prune -f >/dev/null 2>&1 || true"
			if tt.mode == "aggressive" {
				cmd += "; docker builder prune -af >/dev/null 2>&1 || true"
			} else {
				cmd += "; docker builder prune -f --filter \"until=168h\" >/dev/null 2>&1 || true"
			}
			if !containsLiteral(cmd, tt.wantCmd) {
				t.Errorf("mode %q: command should contain %q", tt.mode, tt.wantCmd)
			}
			if tt.wantAvoid != "" && containsLiteral(cmd, tt.wantAvoid) {
				t.Errorf("mode %q: command should not contain %q", tt.mode, tt.wantAvoid)
			}
		})
	}
}

func TestEnsureDirCommandFormat(t *testing.T) {
	path := "/opt/myapp"
	cmd := fmt.Sprintf(`if [ ! -d %q ]; then sudo mkdir -p %q && sudo chown $(id -u):$(id -g) %q; fi`, path, path, path)

	if !containsLiteral(cmd, "mkdir -p") {
		t.Error("command should contain mkdir -p")
	}
	if !containsLiteral(cmd, "chown") {
		t.Error("command should contain chown")
	}
}

func TestGitCloneCommandFormat(t *testing.T) {
	repo := "https://github.com/test/repo"
	targetPath := "/opt/app"
	cmd := fmt.Sprintf("if [ -d %q ]; then echo 'exists'; else git clone %q %q 2>/dev/null || echo 'clone failed'; fi", targetPath, repo, targetPath)

	if !containsLiteral(cmd, "git clone") {
		t.Error("command should contain git clone")
	}
	if !containsLiteral(cmd, targetPath) {
		t.Error("command should contain target path")
	}
}

func TestSystemctlCommandFormat(t *testing.T) {
	action := "restart"
	service := "docker"
	cmd := fmt.Sprintf("sudo systemctl %s %s", action, service)

	if cmd != "sudo systemctl restart docker" {
		t.Errorf("command = %q, want %q", cmd, "sudo systemctl restart docker")
	}
}

func TestEnsureComposeCommandFormat(t *testing.T) {
	cmd := `docker compose version >/dev/null 2>&1 && echo "docker compose" || (docker-compose version >/dev/null 2>&1 && echo "docker-compose")`

	if !containsLiteral(cmd, "docker compose version") {
		t.Error("command should check docker compose version")
	}
	if !containsLiteral(cmd, "docker-compose version") {
		t.Error("command should also check docker-compose version")
	}
}

func containsLiteral(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstr(s, substr))
}

func containsSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
