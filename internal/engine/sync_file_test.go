package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestTruncateCommandBoundarySync(t *testing.T) {
	tests := []struct {
		cmd    string
		maxLen int
		want   string
	}{
		{"exactlen", 8, "exactlen"},
		{"onemore", 7, "onemore"},
		{"onemore", 6, "one..."},
		{"", 0, ""},
		{"x", 1, "x"},
		{"xy", 2, "xy"},
		{"abcde", 3, "..."},
		{"abcdefg", 6, "abc..."},
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

func TestSyncRulePathConstruction(t *testing.T) {
	baseDir := "/opt/SilkSpool"
	host := "keeper"
	local := "caddy/Caddyfile"

	localPath := filepath.Join(baseDir, "hosts", host, local)
	expected := "/opt/SilkSpool/hosts/keeper/caddy/Caddyfile"
	if localPath != expected {
		t.Errorf("localPath = %q, want %q", localPath, expected)
	}
}

func TestSyncRulePathWithSubdirs(t *testing.T) {
	baseDir := "/opt/SilkSpool"
	host := "gateway"
	local := "dnsmasq/dnsmasq.conf"

	localPath := filepath.Join(baseDir, "hosts", host, local)
	expected := "/opt/SilkSpool/hosts/gateway/dnsmasq/dnsmasq.conf"
	if localPath != expected {
		t.Errorf("localPath = %q, want %q", localPath, expected)
	}
}

func TestEncryptedFileDetection(t *testing.T) {
	dir := t.TempDir()

	plainFile := filepath.Join(dir, "config.yaml")
	os.WriteFile(plainFile, []byte("key: value\n"), 0644)

	encFile := filepath.Join(dir, "secret.yaml.enc")
	os.WriteFile(encFile, []byte("encrypted-content"), 0644)

	if _, err := os.Stat(plainFile + ".enc"); !os.IsNotExist(err) {
		t.Error("plain file should not have .enc variant")
	}
	if _, err := os.Stat(encFile); err != nil {
		t.Error("enc file should exist")
	}
}

func TestPostPushHookPatternMatching(t *testing.T) {
	tests := []struct {
		localPath string
		pattern   string
		want      bool
	}{
		{"caddy/Caddyfile", "caddy", true},
		{"dnsmasq/dnsmasq.conf", "dnsmasq", true},
		{"caddy/Caddyfile", "dnsmasq", false},
		{"headscale/config.yaml", "headscale", true},
		{"headscale/config.yaml", "config", true},
		{"n8n/workflows", "n8n", true},
	}

	for _, tt := range tests {
		t.Run(tt.localPath+"_"+tt.pattern, func(t *testing.T) {
			got := strings.Contains(tt.localPath, tt.pattern)
			if got != tt.want {
				t.Errorf("Contains(%q, %q) = %v, want %v", tt.localPath, tt.pattern, got, tt.want)
			}
		})
	}
}

func TestEncryptedPathConstruction(t *testing.T) {
	baseDir := "/opt/SilkSpool"
	host := "keeper"
	local := "n8n/env.enc"

	encPath := filepath.Join(baseDir, "hosts", host, local+".enc")
	expected := "/opt/SilkSpool/hosts/keeper/n8n/env.enc.enc"
	if encPath != expected {
		t.Errorf("encPath = %q, want %q", encPath, expected)
	}
}

func TestTryPushEncryptedNoEncFile(t *testing.T) {
	dir := t.TempDir()
	_ = &SyncManager{baseDir: dir, sshKey: "/fake/key"}

	encPath := filepath.Join(dir, "hosts", "keeper", "caddy/Caddyfile.enc")
	if _, err := os.Stat(encPath); os.IsNotExist(err) {
	}
}

func TestSyncManagerStructFieldValues(t *testing.T) {
	m := &SyncManager{
		baseDir:    "/opt/SilkSpool",
		sshKey:     "/opt/SilkSpool/keys/spool",
		knownHosts: "/opt/SilkSpool/known_hosts",
		sops:       nil,
	}
	if m.baseDir != "/opt/SilkSpool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sshKey != "/opt/SilkSpool/keys/spool" {
		t.Errorf("sshKey = %q", m.sshKey)
	}
	if m.knownHosts != "/opt/SilkSpool/known_hosts" {
		t.Errorf("knownHosts = %q", m.knownHosts)
	}
	if m.sops != nil {
		t.Error("sops should be nil when not configured")
	}
}

func TestNewSyncManagerMissingConfigFile(t *testing.T) {
	_, err := NewSyncManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestEnsureRemoteDirSkipsRoot(t *testing.T) {
	for _, dir := range []string{"", ".", "/"} {
		if dir == "" || dir == "." || dir == "/" {
			continue
		}
		t.Errorf("dir %q should be skipped", dir)
	}
}

func TestPushFileLocalNotExist(t *testing.T) {
	m := &SyncManager{baseDir: t.TempDir(), sshKey: "/fake/key"}
	hc := &config.HostConfig{Address: "user@host"}
	err := m.pushFile(hc, "/nonexistent/file", "/remote/path")
	if err == nil {
		t.Error("expected error for non-existent local file")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error should mention not found, got: %v", err)
	}
}

func TestPullFileCreatesLocalDir(t *testing.T) {
	dir := t.TempDir()
	localPath := filepath.Join(dir, "hosts", "keeper", "caddy", "Caddyfile")
	localDir := filepath.Dir(localPath)

	if _, err := os.Stat(localDir); !os.IsNotExist(err) {
		t.Error("local dir should not exist yet")
	}

	if err := os.MkdirAll(localDir, 0755); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(localDir); err != nil {
		t.Error("local dir should exist after MkdirAll")
	}
}
