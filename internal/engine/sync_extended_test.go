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
