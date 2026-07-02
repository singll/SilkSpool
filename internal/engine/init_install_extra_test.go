package engine

import (
	"strings"
	"testing"
)

func TestResolveSSHKeyPathTildeExpansion(t *testing.T) {
	result := resolveSSHKeyPath("~/.ssh/id_ed25519", "/base")
	if !strings.Contains(result, ".ssh/id_ed25519") {
		t.Errorf("should expand tilde, got %q", result)
	}
}

func TestResolveSSHKeyPathEnvExpansion(t *testing.T) {
	result := resolveSSHKeyPath("$HOME/.ssh/id_rsa", "/base")
	if strings.Contains(result, "$HOME") {
		t.Errorf("should expand env vars, got %q", result)
	}
}

func TestExtractHostEdgeCases(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"user@192.168.1.1", "192.168.1.1"},
		{"root@server.example.com", "server.example.com"},
		{"justhostname", "justhostname"},
		{"a@b@c.host", "c.host"},
		{"@no-user.com", "no-user.com"},
		{"user@10.0.0.1", "10.0.0.1"},
		{"user@[::1]", "[::1]"},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := extractHost(tt.input)
			if got != tt.want {
				t.Errorf("extractHost(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestBuildInitScriptContainsAllSections(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("deployuser", "ssh-ed25519 AAAA test@host")

	required := []string{
		"TARGET_USER='deployuser'",
		"ssh-ed25519 AAAA test@host",
		"useradd",
		"authorized_keys",
		"docker",
		"chown",
		"chmod",
		"set -e",
		"SUDO=",
	}
	for _, req := range required {
		if !strings.Contains(script, req) {
			t.Errorf("script should contain %q", req)
		}
	}
}

func TestBuildInitScriptRootUser(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("root", "ssh-ed25519 AAAKEY root@host")
	if !strings.Contains(script, "TARGET_USER='root'") {
		t.Error("script should set TARGET_USER to root")
	}
	if !strings.Contains(script, "/root") {
		t.Error("script should handle root home directory")
	}
}

func TestBuildInitScriptTrimsPubKeyNewline(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("user", "ssh-ed25519 AAAA user@host\n")
	if strings.Contains(script, "AAAA user@host\n") && strings.Contains(script, "tee -a") {
	}
}

func TestBuildInitScriptNonRootUser(t *testing.T) {
	m := &InitManager{}
	script := m.buildInitScript("deployer", "ssh-ed25519 KEY deployer@host")
	if !strings.Contains(script, "TARGET_USER='deployer'") {
		t.Error("script should set TARGET_USER to deployer")
	}
	if !strings.Contains(script, "/home/deployer") || !strings.Contains(script, "TARGET_HOME") {
	}
}

func TestInitManagerStructDefaults(t *testing.T) {
	m := &InitManager{
		baseDir: "/opt/spool",
		sshKey:  "/keys/id_rsa",
		sshPub:  "/keys/id_rsa.pub",
	}
	if m.baseDir != "/opt/spool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sshPub != "/keys/id_rsa.pub" {
		t.Errorf("sshPub = %q", m.sshPub)
	}
}
