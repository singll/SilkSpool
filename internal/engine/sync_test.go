package engine

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestTruncateCommandInSync(t *testing.T) {
	tests := []struct {
		cmd    string
		maxLen int
		want   string
	}{
		{"short", 60, "short"},
		{"this is a very long command that exceeds the max length limit", 20, "this is a very lo..."},
		{"", 10, ""},
		{"a", 1, "a"},
	}

	for _, tt := range tests {
		got := truncateCommand(tt.cmd, tt.maxLen)
		if got != tt.want {
			t.Errorf("truncateCommand(%q, %d) = %q, want %q", tt.cmd, tt.maxLen, got, tt.want)
		}
	}
}

func TestConfirmDestructiveAssumeYes(t *testing.T) {
	if !ConfirmDestructive("delete", "everything", true) {
		t.Error("ConfirmDestructive with assumeYes=true should return true")
	}
}

func TestDomainToName(t *testing.T) {
	tests := []struct {
		domain, want string
	}{
		{"web.example.com", "Web"},
		{"db.example.com", "Db"},
		{"api.example.com", "Api"},
		{"example.com", "Example"},
	}

	for _, tt := range tests {
		got := domainToName(tt.domain)
		if got != tt.want {
			t.Errorf("domainToName(%q) = %q, want %q", tt.domain, got, tt.want)
		}
	}
}

func TestSyncHostReturnsErrorOnMissingLocalFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "silkspool.yaml"), `global:
  ssh_key_path: "./keys/id_test"
hosts:
  testhost:
    address: "user@10.0.0.2"
    sync_rules:
      - local: "missing.conf"
        remote: "/tmp/missing.conf"
`)

	mgr, err := NewSyncManager(dir)
	if err != nil {
		t.Fatalf("NewSyncManager: %v", err)
	}
	if err := mgr.SyncHost("testhost", "push"); err == nil {
		t.Fatal("expected sync error for missing local file")
	} else if !strings.Contains(err.Error(), "missing.conf") {
		t.Fatalf("error = %q, should mention missing.conf", err.Error())
	}
}
