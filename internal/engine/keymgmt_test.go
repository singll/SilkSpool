package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShSingleQuote(t *testing.T) {
	tests := []struct {
		input, want string
	}{
		{"hello", "'hello'"},
		{"", "''"},
		{"it's", "'it'\\''s'"},
		{"a'b'c", "'a'\\''b'\\''c'"},
	}

	for _, tt := range tests {
		got := shSingleQuote(tt.input)
		if got != tt.want {
			t.Errorf("shSingleQuote(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestBuildAddKeyScript(t *testing.T) {
	script := buildAddKeyScript("ssh-ed25519 AAAA user@host", "AAAA")
	if !strings.Contains(script, "KEYBODY=") {
		t.Error("script should contain KEYBODY")
	}
	if !strings.Contains(script, "PUBLINE=") {
		t.Error("script should contain PUBLINE")
	}
	if !strings.Contains(script, "authorized_keys") {
		t.Error("script should reference authorized_keys")
	}
	if !strings.Contains(script, "dropbear") {
		t.Error("script should handle dropbear")
	}
}

func TestBuildRemoveKeyScript(t *testing.T) {
	script := buildRemoveKeyScript("AAAA")
	if !strings.Contains(script, "KEYBODY=") {
		t.Error("script should contain KEYBODY")
	}
	if !strings.Contains(script, "authorized_keys") {
		t.Error("script should reference authorized_keys")
	}
	if !strings.Contains(script, "dropbear") {
		t.Error("script should handle dropbear")
	}
}

func TestBuildCheckKeyScript(t *testing.T) {
	script := buildCheckKeyScript("AAAA")
	if !strings.Contains(script, "PRESENT") {
		t.Error("script should output PRESENT")
	}
	if !strings.Contains(script, "ABSENT") {
		t.Error("script should output ABSENT")
	}
	if !strings.Contains(script, "authorized_keys") {
		t.Error("script should reference authorized_keys")
	}
}

func TestPubKeyBody(t *testing.T) {
	dir := t.TempDir()

	t.Run("valid key", func(t *testing.T) {
		pubPath := filepath.Join(dir, "test.pub")
		os.WriteFile(pubPath, []byte("ssh-ed25519 AAAAB3NzaC1yc2EAAAA user@host\n"), 0644)
		body, err := pubKeyBody(pubPath)
		if err != nil {
			t.Fatalf("pubKeyBody error: %v", err)
		}
		if body != "AAAAB3NzaC1yc2EAAAA" {
			t.Errorf("body = %q, want %q", body, "AAAAB3NzaC1yc2EAAAA")
		}
	})

	t.Run("malformed key", func(t *testing.T) {
		pubPath := filepath.Join(dir, "bad.pub")
		os.WriteFile(pubPath, []byte("onlyonefield\n"), 0644)
		_, err := pubKeyBody(pubPath)
		if err == nil {
			t.Error("expected error for malformed key")
		}
	})

	t.Run("missing file", func(t *testing.T) {
		_, err := pubKeyBody("/nonexistent/key.pub")
		if err == nil {
			t.Error("expected error for missing file")
		}
	})
}

func TestReadPubLine(t *testing.T) {
	dir := t.TempDir()

	t.Run("valid key", func(t *testing.T) {
		pubPath := filepath.Join(dir, "test.pub")
		os.WriteFile(pubPath, []byte("ssh-ed25519 AAAAB3NzaC1yc2EAAAA user@host\n"), 0644)
		line, err := readPubLine(pubPath)
		if err != nil {
			t.Fatalf("readPubLine error: %v", err)
		}
		if line != "ssh-ed25519 AAAAB3NzaC1yc2EAAAA user@host" {
			t.Errorf("line = %q, unexpected", line)
		}
	})

	t.Run("empty file", func(t *testing.T) {
		pubPath := filepath.Join(dir, "empty.pub")
		os.WriteFile(pubPath, []byte(""), 0644)
		_, err := readPubLine(pubPath)
		if err == nil {
			t.Error("expected error for empty key file")
		}
	})

	t.Run("missing file", func(t *testing.T) {
		_, err := readPubLine("/nonexistent/key.pub")
		if err == nil {
			t.Error("expected error for missing file")
		}
	})
}

func TestSwapCanonicalKey(t *testing.T) {
	dir := t.TempDir()

	curKey := filepath.Join(dir, "current")
	curPub := curKey + ".pub"
	newKey := filepath.Join(dir, "new")
	newPub := newKey + ".pub"

	os.WriteFile(curKey, []byte("old-private"), 0600)
	os.WriteFile(curPub, []byte("old-public"), 0644)
	os.WriteFile(newKey, []byte("new-private"), 0600)
	os.WriteFile(newPub, []byte("new-public"), 0644)

	backup, err := swapCanonicalKey(curKey, newKey)
	if err != nil {
		t.Fatalf("swapCanonicalKey error: %v", err)
	}

	if backup == "" {
		t.Error("backup path should not be empty")
	}

	curData, _ := os.ReadFile(curKey)
	if string(curData) != "new-private" {
		t.Errorf("current key = %q, want %q", string(curData), "new-private")
	}

	curPubData, _ := os.ReadFile(curPub)
	if string(curPubData) != "new-public" {
		t.Errorf("current pub = %q, want %q", string(curPubData), "new-public")
	}

	backupData, _ := os.ReadFile(backup)
	if string(backupData) != "old-private" {
		t.Errorf("backup = %q, want %q", string(backupData), "old-private")
	}
}

func TestSwapCanonicalKeyMissingNew(t *testing.T) {
	dir := t.TempDir()
	_, err := swapCanonicalKey(filepath.Join(dir, "cur"), filepath.Join(dir, "missing"))
	if err == nil {
		t.Error("expected error for missing new key")
	}
}
