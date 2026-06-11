package engine

import (
	"fmt"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestParseBackupRulesVariousTypes(t *testing.T) {
	tests := []struct {
		input  string
		count  int
		types  []string
	}{
		{
			input: "volume:myvol:backup1 dir:/etc:backup2 db-mysql:mysql:backup3 db-pg:postgres:backup4",
			count: 4,
			types: []string{"volume", "dir", "db-mysql", "db-pg"},
		},
		{
			input: "volume:only:one",
			count: 1,
			types: []string{"volume"},
		},
		{
			input: "invalid",
			count: 0,
		},
		{
			input: "a:b",
			count: 0,
		},
		{
			input: "",
			count: 0,
		},
	}

	for _, tt := range tests {
		rules := ParseBackupRules(tt.input)
		if len(rules) != tt.count {
			t.Errorf("ParseBackupRules(%q) count = %d, want %d", tt.input, len(rules), tt.count)
		}
		for i, typ := range tt.types {
			if i < len(rules) && rules[i].Type != typ {
				t.Errorf("rule[%d].Type = %q, want %q", i, rules[i].Type, typ)
			}
		}
	}
}

func TestParseBackupRulesSourceExtraction(t *testing.T) {
	rules := ParseBackupRules("dir:/etc/nginx:nginx-config volume:pgdata:pg-backup")
	if len(rules) != 2 {
		t.Fatalf("expected 2 rules, got %d", len(rules))
	}
	if rules[0].Source != "/etc/nginx" {
		t.Errorf("rule[0].Source = %q, want /etc/nginx", rules[0].Source)
	}
	if rules[1].Source != "pgdata" {
		t.Errorf("rule[1].Source = %q, want pgdata", rules[1].Source)
	}
}

func TestBackupManagerLocalDirFormat(t *testing.T) {
	hc := &config.HostConfig{Address: "user@host"}
	bm := NewBackupManagerFromConfig("testhost", hc)
	if !strings.Contains(bm.LocalDir(), "testhost") {
		t.Errorf("LocalDir() = %q, should contain host name", bm.LocalDir())
	}
	if !strings.Contains(bm.LocalDir(), "silkspool_backups") {
		t.Errorf("LocalDir() = %q, should contain silkspool_backups", bm.LocalDir())
	}
}

func TestBackupManagerHostAccessor(t *testing.T) {
	hc := &config.HostConfig{Address: "user@host"}
	bm := NewBackupManagerFromConfig("myhost", hc)
	if bm.Host() != "myhost" {
		t.Errorf("Host() = %q, want %q", bm.Host(), "myhost")
	}
}

func TestBackupResultStruct(t *testing.T) {
	r := BackupResult{Name: "test", Path: "/path/to/file", Status: "success"}
	if r.Name != "test" {
		t.Errorf("Name = %q", r.Name)
	}
	if r.Status != "success" {
		t.Errorf("Status = %q", r.Status)
	}
}

func TestBackupResultWithError(t *testing.T) {
	r := BackupResult{Name: "test", Error: fmt.Errorf("fail")}
	if r.Error == nil {
		t.Error("Error should not be nil")
	}
	if r.Status != "" {
		t.Errorf("Status should be empty for failed backup, got %q", r.Status)
	}
}

func TestNewBackupManagerFromConfigLocalDir(t *testing.T) {
	bm := NewBackupManagerFromConfig("host1", &config.HostConfig{})
	if bm.LocalDir() == "" {
		t.Error("LocalDir should not be empty")
	}
}

func TestBackupRuleUnknownType(t *testing.T) {
	rule := config.BackupRule{Type: "unknown-type", Source: "src", Name: "name"}
	if rule.Type != "unknown-type" {
		t.Errorf("Type = %q, want unknown-type", rule.Type)
	}
}
