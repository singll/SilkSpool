package engine

import (
	"testing"
)

func TestResolveSSHKeyPathEmptyBaseDir(t *testing.T) {
	result := resolveSSHKeyPath("keys/id_rsa", "")
	if result == "" {
		t.Error("result should not be empty even with empty baseDir")
	}
}

func TestResolveSSHKeyPathAbsolutePath(t *testing.T) {
	result := resolveSSHKeyPath("/absolute/path/id_rsa", "/base")
	if result != "/absolute/path/id_rsa" {
		t.Errorf("absolute path should be preserved, got %q", result)
	}
}

func TestResolveSSHKeyPathRelativeWithBaseDir(t *testing.T) {
	result := resolveSSHKeyPath("keys/id_rsa", "/opt/spool")
	if result != "/opt/spool/keys/id_rsa" {
		t.Errorf("relative path with baseDir = %q, want /opt/spool/keys/id_rsa", result)
	}
}

func TestExtractHostVariousFormats(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"user@192.168.1.1", "192.168.1.1"},
		{"root@server.example.com", "server.example.com"},
		{"justhostname", "justhostname"},
		{"a@b@c.host", "c.host"},
		{"@no-user.com", "no-user.com"},
	}
	for _, tt := range tests {
		got := extractHost(tt.input)
		if got != tt.want {
			t.Errorf("extractHost(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestBuildInitScriptContent(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("deployuser", "ssh-ed25519 AAAA test@host")

	if !containsPattern(script, "deployuser") {
		t.Error("script should contain target user")
	}
	if !containsPattern(script, "ssh-ed25519") {
		t.Error("script should contain public key type")
	}
	if !containsPattern(script, "authorized_keys") {
		t.Error("script should configure authorized_keys")
	}
	if !containsPattern(script, "useradd") {
		t.Error("script should create user")
	}
	if !containsPattern(script, "docker") {
		t.Error("script should configure docker group")
	}
	if !containsPattern(script, "chown") {
		t.Error("script should set ownership")
	}
	if !containsPattern(script, "chmod") {
		t.Error("script should set permissions")
	}
}

func TestBuildInitScriptTrimsPubKey(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("user", "ssh-ed25519 AAAA user@host\n")
	if containsPattern(script, "\n") && containsPattern(script, "AAAA user@host\n") {
		t.Error("trailing newline in pub key should be trimmed")
	}
}

func TestNewInitManagerMissingConfig(t *testing.T) {
	_, err := NewInitManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestBuildInitScriptWithSpecialUser(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("root", "ssh-ed25519 AAAKEY root@host")
	if !containsPattern(script, "TARGET_USER='root'") {
		t.Error("script should set TARGET_USER to root")
	}
	if !containsPattern(script, "/root") {
		t.Error("script should handle root home directory")
	}
}

func TestInitManagerStructFields(t *testing.T) {
	m := &InitManager{
		baseDir: "/opt/spool",
		sshKey:  "/keys/id_rsa",
		sshPub:  "/keys/id_rsa.pub",
	}
	if m.baseDir != "/opt/spool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sshKey != "/keys/id_rsa" {
		t.Errorf("sshKey = %q", m.sshKey)
	}
	if m.sshPub != "/keys/id_rsa.pub" {
		t.Errorf("sshPub = %q", m.sshPub)
	}
}
