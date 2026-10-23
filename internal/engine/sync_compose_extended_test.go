package engine

import (
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestSyncManagerStructFields(t *testing.T) {
	m := &SyncManager{
		baseDir: "/opt/spool",
		sshKey:  "/keys/spool",
		sops:    nil,
	}
	if m.baseDir != "/opt/spool" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sshKey != "/keys/spool" {
		t.Errorf("sshKey = %q", m.sshKey)
	}
	if m.sops != nil {
		t.Error("sops should be nil when not configured")
	}
}

func TestSyncManagerWithSOPS(t *testing.T) {
	sopsMgr := &SOPSManager{}
	m := &SyncManager{
		baseDir: "/opt",
		sshKey:  "/key",
		sops:    sopsMgr,
	}
	if m.sops == nil {
		t.Error("sops should be set")
	}
}

func TestNewSyncManagerMissingConfig(t *testing.T) {
	_, err := NewSyncManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestTruncateCommandBoundary(t *testing.T) {
	tests := []struct {
		cmd    string
		maxLen int
		want   string
	}{
		{"exact10ch", 10, "exact10ch"},
		{"exact10char!", 10, "exact10..."},
		{"ab", 5, "ab"},
		{"abcde", 3, "..."},
		{"abcdef", 6, "abcdef"},
		{"abcdefg", 6, "abc..."},
		{"", 0, ""},
	}
	for _, tt := range tests {
		got := truncateCommand(tt.cmd, tt.maxLen)
		if got != tt.want {
			t.Errorf("truncateCommand(%q, %d) = %q, want %q", tt.cmd, tt.maxLen, got, tt.want)
		}
	}
}

func TestComposeDriverStructDefaults(t *testing.T) {
	d := NewComposeDriver("/base", "/key", "bundle")
	if d.defaults != (config.DefaultsConfig{}) {
		t.Error("defaults should be zero-value without WithDefaults")
	}
}

func TestComposeDriverWithDefaults(t *testing.T) {
	defaults := config.DefaultsConfig{
		LogLines:     200,
		ComposeVer:   "v2.30",
		DockerLogMax: "100m",
		DockerLogNum: 5,
		DeployPath:   "/opt/deploy",
	}
	d := NewComposeDriverWithDefaults("/base", "/key", "bundle", defaults)
	if d.defaults.LogLines != 200 {
		t.Errorf("LogLines = %d, want 200", d.defaults.LogLines)
	}
	if d.defaults.DeployPath != "/opt/deploy" {
		t.Errorf("DeployPath = %q", d.defaults.DeployPath)
	}
}

func TestStackDriverStructDefaults(t *testing.T) {
	d := NewStackDriver("/base", "/key", "bundle")
	if d.bundleName != "bundle" {
		t.Errorf("bundleName = %q", d.bundleName)
	}
}

func TestStackDriverWithDefaults(t *testing.T) {
	defaults := config.DefaultsConfig{DeployPath: "/custom"}
	d := NewStackDriverWithDefaults("/base", "/key", "bundle", defaults)
	if d.defaults.DeployPath != "/custom" {
		t.Errorf("DeployPath = %q", d.defaults.DeployPath)
	}
}

func TestStackDriverCleanupAlwaysNil(t *testing.T) {
	d := &StackDriver{}
	if err := d.Cleanup("host", nil, "/path", "normal"); err != nil {
		t.Errorf("Cleanup normal: %v", err)
	}
	if err := d.Cleanup("host", nil, "/path", "aggressive"); err != nil {
		t.Errorf("Cleanup aggressive: %v", err)
	}
}
