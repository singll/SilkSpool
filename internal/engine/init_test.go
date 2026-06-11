package engine

import (
	"strings"
	"testing"
)

func TestResolveSSHKeyPath(t *testing.T) {
	dir := t.TempDir()

	tests := []struct {
		name, keyPath, baseDir, wantContains string
	}{
		{"absolute path", "/absolute/key", dir, "/absolute/key"},
		{"relative path with baseDir", "keys/id_rsa", dir, dir + "/keys/id_rsa"},
		{"empty defaults to home", "", dir, ".ssh/id_rsa"},
		{"tilde expansion", "~/.ssh/id_ed25519", dir, ".ssh/id_ed25519"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := resolveSSHKeyPath(tt.keyPath, tt.baseDir)
			if !strings.Contains(result, tt.wantContains) {
				t.Errorf("resolveSSHKeyPath(%q, %q) = %q, should contain %q", tt.keyPath, tt.baseDir, result, tt.wantContains)
			}
		})
	}
}

func TestExtractHost(t *testing.T) {
	tests := []struct {
		address, want string
	}{
		{"user@192.168.1.1", "192.168.1.1"},
		{"admin@myserver.com", "myserver.com"},
		{"hostonly", "hostonly"},
		{"a@b@c", "c"},
	}

	for _, tt := range tests {
		got := extractHost(tt.address)
		if got != tt.want {
			t.Errorf("extractHost(%q) = %q, want %q", tt.address, got, tt.want)
		}
	}
}

func TestBuildInitScript(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("deployuser", "ssh-ed25519 AAAA test@host")

	if !strings.Contains(script, "TARGET_USER='deployuser'") {
		t.Error("script should contain TARGET_USER")
	}
	if !strings.Contains(script, "ssh-ed25519 AAAA test@host") {
		t.Error("script should contain the public key")
	}
	if !strings.Contains(script, "useradd") {
		t.Error("script should reference useradd")
	}
	if !strings.Contains(script, "authorized_keys") {
		t.Error("script should reference authorized_keys")
	}
	if !strings.Contains(script, "docker") {
		t.Error("script should reference docker")
	}
}

func TestTruncateCommand(t *testing.T) {
	tests := []struct {
		cmd    string
		maxLen int
		want   string
	}{
		{"short", 60, "short"},
		{"this is a very long command that exceeds the max length limit", 20, "this is a very lo..."},
		{"exact", 5, "exact"},
	}

	for _, tt := range tests {
		got := truncateCommand(tt.cmd, tt.maxLen)
		if got != tt.want {
			t.Errorf("truncateCommand(%q, %d) = %q, want %q", tt.cmd, tt.maxLen, got, tt.want)
		}
	}
}