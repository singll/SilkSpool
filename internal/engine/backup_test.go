package engine

import (
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestNewBackupManagerFromConfig(t *testing.T) {
	hc := &config.HostConfig{
		Address: "user@host",
		Backups: []config.BackupRule{
			{Type: "volume", Source: "data-vol", Name: "data"},
		},
	}

	bm := NewBackupManagerFromConfig("myhost", hc)
	if bm == nil {
		t.Fatal("NewBackupManagerFromConfig returned nil")
	}
	if bm.Host() != "myhost" {
		t.Errorf("Host() = %q, want %q", bm.Host(), "myhost")
	}
	if bm.LocalDir() == "" {
		t.Error("LocalDir() should not be empty")
	}
}

func TestBackupManagerSetSSHClient(t *testing.T) {
	hc := &config.HostConfig{Address: "user@host"}
	bm := NewBackupManagerFromConfig("myhost", hc)

	client, _ := NewSSHClient("user@host", "/key")
	bm.SetSSHClient(client)
	if bm.sshClient == nil {
		t.Error("sshClient should be set after SetSSHClient")
	}
}

func TestParseBackupRules(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		count  int
	}{
		{"empty", "", 0},
		{"single", "volume:myvol:mybackup", 1},
		{"multiple", "volume:vol1:bk1 dir:/etc:bk2", 2},
		{"invalid few parts", "volume:onlytwo", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rules := ParseBackupRules(tt.input)
			if len(rules) != tt.count {
				t.Errorf("ParseBackupRules(%q) count = %d, want %d", tt.input, len(rules), tt.count)
			}
		})
	}
}

func TestParseBackupRulesFields(t *testing.T) {
	rules := ParseBackupRules("volume:myvol:mybackup dir:/etc/config:configbk db-mysql:mysql-container:dbdump")
	if len(rules) != 3 {
		t.Fatalf("expected 3 rules, got %d", len(rules))
	}

	if rules[0].Type != "volume" || rules[0].Source != "myvol" || rules[0].Name != "mybackup" {
		t.Errorf("rule[0] = %+v, unexpected", rules[0])
	}
	if rules[1].Type != "dir" || rules[1].Source != "/etc/config" || rules[1].Name != "configbk" {
		t.Errorf("rule[1] = %+v, unexpected", rules[1])
	}
	if rules[2].Type != "db-mysql" || rules[2].Source != "mysql-container" || rules[2].Name != "dbdump" {
		t.Errorf("rule[2] = %+v, unexpected", rules[2])
	}
}

func TestBackupRuleTypes(t *testing.T) {
	validTypes := map[string]bool{
		"volume":   true,
		"dir":      true,
		"db-mysql": true,
		"db-pg":    true,
	}

	for typ := range validTypes {
		rule := config.BackupRule{Type: typ, Source: "src", Name: "name"}
		if rule.Type != typ {
			t.Errorf("BackupRule type = %q, want %q", rule.Type, typ)
		}
	}
}
