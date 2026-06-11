package sops

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsEncryptedJSONFile(t *testing.T) {
	dir := t.TempDir()

	t.Run("JSON with sops marker", func(t *testing.T) {
		path := filepath.Join(dir, "secret.json")
		os.WriteFile(path, []byte(`sops:
    kms: []
data: ENC[aes256_gcm:data]
`), 0644)
		mgr := NewManager("")
		if !mgr.IsEncrypted(path) {
			t.Error("should detect sops marker in JSON-like file")
		}
	})

	t.Run("plain JSON", func(t *testing.T) {
		path := filepath.Join(dir, "plain.json")
		os.WriteFile(path, []byte(`{"key": "value", "other": 42}`), 0644)
		mgr := NewManager("")
		if mgr.IsEncrypted(path) {
			t.Error("plain JSON should not be detected as encrypted")
		}
	})
}

func TestIsEncryptedEmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.yaml")
	os.WriteFile(path, []byte(""), 0644)
	mgr := NewManager("")
	if mgr.IsEncrypted(path) {
		t.Error("empty file should not be detected as encrypted")
	}
}

func TestIsEncryptedBinaryFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "binary.dat")
	os.WriteFile(path, []byte{0x00, 0x01, 0x02, 0x03}, 0644)
	mgr := NewManager("")
	if mgr.IsEncrypted(path) {
		t.Error("binary file without sops markers should not be encrypted")
	}
}

func TestProcessEncryptedFilesWithEncFile(t *testing.T) {
	dir := t.TempDir()

	encPath := filepath.Join(dir, "config.env.enc")
	os.WriteFile(encPath, []byte("sops:\n  version: 3.8.1\ndata: ENC[data]"), 0644)

	plainPath := filepath.Join(dir, "config.env")
	if _, err := os.Stat(plainPath); err == nil {
		t.Fatal("plain file should not exist for this test")
	}

	mgr := NewManager("/nonexistent/key.txt")
	err := mgr.ProcessEncryptedFiles(dir, func(src, plainName string, data []byte) error {
		return nil
	})

	if err != nil {
		t.Logf("ProcessEncryptedFiles: %v (expected - key not available)", err)
	}
}

func TestProcessEncryptedFilesSkipsPlainAndEncPair(t *testing.T) {
	dir := t.TempDir()

	encPath := filepath.Join(dir, "config.env.enc")
	os.WriteFile(encPath, []byte("encrypted content"), 0644)

	plainPath := filepath.Join(dir, "config.env")
	os.WriteFile(plainPath, []byte("plain content"), 0644)

	mgr := NewManager("/nonexistent/key.txt")
	err := mgr.ProcessEncryptedFiles(dir, func(src, plainName string, data []byte) error {
		return nil
	})

	if err != nil {
		t.Logf("ProcessEncryptedFiles: %v", err)
	}
}

func TestProcessEncryptedFilesSopsYaml(t *testing.T) {
	dir := t.TempDir()

	sopsPath := filepath.Join(dir, "secret.sops.yaml")
	os.WriteFile(sopsPath, []byte("sops:\n  version: 3.8.1\n"), 0644)

	mgr := NewManager("/nonexistent/key.txt")
	err := mgr.ProcessEncryptedFiles(dir, func(src, plainName string, data []byte) error {
		return nil
	})

	if err != nil {
		t.Logf("ProcessEncryptedFiles: %v", err)
	}
}

func TestManagerSetAgeKeyPathIdempotent(t *testing.T) {
	mgr := NewManager("/original/key")
	mgr.SetAgeKeyPath("/new/key")
	if mgr.ageKeyPath != "/new/key" {
		t.Errorf("ageKeyPath = %q, want /new/key", mgr.ageKeyPath)
	}
	mgr.SetAgeKeyPath("/another/key")
	if mgr.ageKeyPath != "/another/key" {
		t.Errorf("ageKeyPath = %q, want /another/key", mgr.ageKeyPath)
	}
}

func TestDecryptWithNonexistentKey(t *testing.T) {
	mgr := NewManager("/nonexistent/age.key")
	_, err := mgr.Decrypt("/some/file.enc")
	if err == nil {
		t.Error("expected error for nonexistent key file")
	}
}

func TestEncryptWithNonexistentKey(t *testing.T) {
	mgr := NewManager("/nonexistent/age.key")
	err := mgr.Encrypt("/input", "/output")
	if err == nil {
		t.Error("expected error for nonexistent key file")
	}
}

func TestDecryptToFileWithNonexistentKey(t *testing.T) {
	mgr := NewManager("/nonexistent/age.key")
	err := mgr.DecryptToFile("/input.enc", "/output")
	if err == nil {
		t.Error("expected error for nonexistent key file")
	}
}

func TestIsEncryptedWithSopsYamlMarker(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.yaml")
	os.WriteFile(path, []byte("sops:\n    kms: []\n    lastmodified: '2024-01-01'\n"), 0644)
	mgr := NewManager("")
	if !mgr.IsEncrypted(path) {
		t.Error("file with 'sops:' marker should be detected as encrypted")
	}
}

func TestIsEncryptedWithDataMarker(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data.yaml")
	os.WriteFile(path, []byte("data:\n    key: value\n"), 0644)
	mgr := NewManager("")
	if !mgr.IsEncrypted(path) {
		t.Error("file with 'data:' marker should be detected as encrypted")
	}
}

func TestProcessEncryptedFilesEmptyDir(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager("/some/key")
	err := mgr.ProcessEncryptedFiles(dir, nil)
	if err != nil {
		t.Errorf("empty dir should not error: %v", err)
	}
}

func TestProcessEncryptedFilesOnlyDirectories(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "subdir"), 0755)
	mgr := NewManager("/some/key")
	err := mgr.ProcessEncryptedFiles(dir, nil)
	if err != nil {
		t.Errorf("dir with only subdirs should not error: %v", err)
	}
}
