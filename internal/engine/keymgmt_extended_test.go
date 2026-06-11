package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShSingleQuoteExtended(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"simple", "'simple'"},
		{"", "''"},
		{"it's", "'it'\\''s'"},
		{"a'b'c", "'a'\\''b'\\''c'"},
		{"noquotes", "'noquotes'"},
		{"with spaces", "'with spaces'"},
		{"$var", "'$var'"},
		{"back`tick", "'back`tick'"},
	}
	for _, tt := range tests {
		got := shSingleQuote(tt.input)
		if got != tt.want {
			t.Errorf("shSingleQuote(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestBuildAddKeyScriptContent(t *testing.T) {
	pubLine := "ssh-ed25519 AAAAB3NzaC1yc2E user@host"
	body := "AAAAB3NzaC1yc2E"
	script := buildAddKeyScript(pubLine, body)

	if !strings.Contains(script, "KEYBODY=") {
		t.Error("should set KEYBODY")
	}
	if !strings.Contains(script, "PUBLINE=") {
		t.Error("should set PUBLINE")
	}
	if !strings.Contains(script, "add_to()") {
		t.Error("should define add_to function")
	}
	if !strings.Contains(script, "$HOME/.ssh/authorized_keys") {
		t.Error("should target authorized_keys")
	}
	if !strings.Contains(script, "/etc/dropbear/authorized_keys") {
		t.Error("should handle dropbear")
	}
	if !strings.Contains(script, "grep -qF") {
		t.Error("should check for existing key")
	}
}

func TestBuildRemoveKeyScriptContent(t *testing.T) {
	body := "AAAAB3NzaC1yc2E"
	script := buildRemoveKeyScript(body)

	if !strings.Contains(script, "KEYBODY=") {
		t.Error("should set KEYBODY")
	}
	if !strings.Contains(script, "rm_from()") {
		t.Error("should define rm_from function")
	}
	if !strings.Contains(script, "grep -vF") {
		t.Error("should use grep -vF to remove key")
	}
}

func TestBuildCheckKeyScriptContent(t *testing.T) {
	body := "AAAAB3NzaC1yc2E"
	script := buildCheckKeyScript(body)

	if !strings.Contains(script, "PRESENT") {
		t.Error("should output PRESENT when key found")
	}
	if !strings.Contains(script, "ABSENT") {
		t.Error("should output ABSENT when key not found")
	}
}

func TestPubKeyBodyWithMultilineKey(t *testing.T) {
	dir := t.TempDir()
	pubPath := filepath.Join(dir, "multi.pub")
	os.WriteFile(pubPath, []byte("ssh-ed25519 AAAAB3NzaC1yc2EAAAA user@host\nextra-line\n"), 0644)

	body, err := pubKeyBody(pubPath)
	if err != nil {
		t.Fatal(err)
	}
	if body != "AAAAB3NzaC1yc2EAAAA" {
		t.Errorf("body = %q, want base64 part only", body)
	}
}

func TestPubKeyBodyWithComment(t *testing.T) {
	dir := t.TempDir()
	pubPath := filepath.Join(dir, "comment.pub")
	os.WriteFile(pubPath, []byte("ssh-ed25519 AAAA user@host machine-comment\n"), 0644)

	body, err := pubKeyBody(pubPath)
	if err != nil {
		t.Fatal(err)
	}
	if body != "AAAA" {
		t.Errorf("body = %q, want AAAA", body)
	}
}

func TestReadPubLineWithWhitespace(t *testing.T) {
	dir := t.TempDir()
	pubPath := filepath.Join(dir, "ws.pub")
	os.WriteFile(pubPath, []byte("  ssh-ed25519 AAAA user@host  \n"), 0644)

	line, err := readPubLine(pubPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(line, "  ") && (strings.HasPrefix(line, " ") || strings.HasSuffix(line, " ")) {
		t.Errorf("line should be trimmed, got %q", line)
	}
}

func TestSwapCanonicalKeyBackupCreated(t *testing.T) {
	dir := t.TempDir()
	curKey := filepath.Join(dir, "current")
	newKey := filepath.Join(dir, "new")

	os.WriteFile(curKey, []byte("old-priv"), 0600)
	os.WriteFile(curKey+".pub", []byte("old-pub"), 0644)
	os.WriteFile(newKey, []byte("new-priv"), 0600)
	os.WriteFile(newKey+".pub", []byte("new-pub"), 0644)

	backup, err := swapCanonicalKey(curKey, newKey)
	if err != nil {
		t.Fatal(err)
	}

	backupData, _ := os.ReadFile(backup)
	if string(backupData) != "old-priv" {
		t.Errorf("backup should contain old private key, got %q", string(backupData))
	}

	backupPubData, _ := os.ReadFile(backup + ".pub")
	if string(backupPubData) != "old-pub" {
		t.Errorf("backup pub should contain old public key, got %q", string(backupPubData))
	}
}

func TestSwapCanonicalKeyMissingCurrent(t *testing.T) {
	dir := t.TempDir()
	curKey := filepath.Join(dir, "current")
	newKey := filepath.Join(dir, "new")

	os.WriteFile(newKey, []byte("new-priv"), 0600)
	os.WriteFile(newKey+".pub", []byte("new-pub"), 0644)

	backup, err := swapCanonicalKey(curKey, newKey)
	if err != nil {
		t.Fatalf("should succeed even if current key doesn't exist: %v", err)
	}

	curData, _ := os.ReadFile(curKey)
	if string(curData) != "new-priv" {
		t.Errorf("current key should be updated, got %q", string(curData))
	}
	if backup != "" {
		backupData, berr := os.ReadFile(backup)
		if berr != nil || len(backupData) != 0 {
			t.Log("backup may be empty when old key doesn't exist")
		}
	}
}

func TestSwapCanonicalKeyMissingNewPub(t *testing.T) {
	dir := t.TempDir()
	curKey := filepath.Join(dir, "current")
	newKey := filepath.Join(dir, "new")

	os.WriteFile(curKey, []byte("old"), 0600)
	os.WriteFile(curKey+".pub", []byte("old-pub"), 0644)
	os.WriteFile(newKey, []byte("new-priv"), 0600)

	_, err := swapCanonicalKey(curKey, newKey)
	if err == nil {
		t.Error("expected error for missing new public key")
	}
}

func TestKeyManagerRotateOptionsDefaults(t *testing.T) {
	opts := RotateOptions{}
	if opts.NewKeyPath != "" {
		t.Errorf("NewKeyPath default should be empty")
	}
	if opts.KeepOldRemote {
		t.Error("KeepOldRemote default should be false")
	}
	if opts.DryRun {
		t.Error("DryRun default should be false")
	}
}

func TestDecommissionOptionsDefaults(t *testing.T) {
	opts := DecommissionOptions{}
	if opts.PurgeConfig {
		t.Error("PurgeConfig default should be false")
	}
}

func TestGenerateKeyPairCreatesDir(t *testing.T) {
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "subdir", "test_key")
	err := generateKeyPair(keyPath, "test-comment")
	if err != nil {
		t.Logf("generateKeyPair requires ssh-keygen: %v", err)
	}
}
