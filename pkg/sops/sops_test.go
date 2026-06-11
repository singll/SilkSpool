package sops

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewManager(t *testing.T) {
	mgr := NewManager("/path/to/age.key")
	if mgr == nil {
		t.Fatal("NewManager returned nil")
	}
	if mgr.ageKeyPath != "/path/to/age.key" {
		t.Errorf("ageKeyPath = %q, want %q", mgr.ageKeyPath, "/path/to/age.key")
	}
}

func TestNewManagerEmptyPath(t *testing.T) {
	mgr := NewManager("")
	if mgr == nil {
		t.Fatal("NewManager returned nil")
	}
	if mgr.ageKeyPath != "" {
		t.Errorf("ageKeyPath = %q, want empty", mgr.ageKeyPath)
	}
}

func TestSetAgeKeyPath(t *testing.T) {
	mgr := NewManager("")
	mgr.SetAgeKeyPath("/new/path/key.txt")

	if mgr.ageKeyPath != "/new/path/key.txt" {
		t.Errorf("ageKeyPath = %q, want %q", mgr.ageKeyPath, "/new/path/key.txt")
	}
}

func TestIsEncrypted(t *testing.T) {
	dir := t.TempDir()

	t.Run("encrypted file with sops marker", func(t *testing.T) {
		path := filepath.Join(dir, "encrypted.yaml")
		content := `sops:
    kms: []
    gcp_kms: []
    lastmodified: '2024-01-01T00:00:00Z'
data: ENC[aes256_gcm:data]
`
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}

		mgr := NewManager("")
		if !mgr.IsEncrypted(path) {
			t.Error("IsEncrypted should return true for sops file")
		}
	})

	t.Run("encrypted file with data marker", func(t *testing.T) {
		path := filepath.Join(dir, "encrypted2.yaml")
		content := `data:
    secret: value
`
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}

		mgr := NewManager("")
		if !mgr.IsEncrypted(path) {
			t.Error("IsEncrypted should return true for data file")
		}
	})

	t.Run("plain file", func(t *testing.T) {
		path := filepath.Join(dir, "plain.yaml")
		content := `key: value
other: data
`
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}

		mgr := NewManager("")
		if mgr.IsEncrypted(path) {
			t.Error("IsEncrypted should return false for plain file")
		}
	})

	t.Run("nonexistent file", func(t *testing.T) {
		mgr := NewManager("")
		if mgr.IsEncrypted(filepath.Join(dir, "nonexistent.yaml")) {
			t.Error("IsEncrypted should return false for nonexistent file")
		}
	})
}

func TestDecryptNoKeyPath(t *testing.T) {
	mgr := NewManager("")
	_, err := mgr.Decrypt("/some/file.enc")
	if err == nil {
		t.Error("expected error for empty ageKeyPath, got nil")
	}
}

func TestDecryptKeyFileNotFound(t *testing.T) {
	mgr := NewManager("/nonexistent/key.txt")
	_, err := mgr.Decrypt("/some/file.enc")
	if err == nil {
		t.Error("expected error for missing key file, got nil")
	}
}

func TestEncryptNoKeyPath(t *testing.T) {
	mgr := NewManager("")
	err := mgr.Encrypt("/input.txt", "/output.enc")
	if err == nil {
		t.Error("expected error for empty ageKeyPath, got nil")
	}
}

func TestDecryptToFileNoKeyPath(t *testing.T) {
	mgr := NewManager("")
	err := mgr.DecryptToFile("/input.enc", "/output.txt")
	if err == nil {
		t.Error("expected error for empty ageKeyPath, got nil")
	}
}

func TestProcessEncryptedFilesNoKey(t *testing.T) {
	dir := t.TempDir()
	mgr := NewManager("")

	called := false
	err := mgr.ProcessEncryptedFiles(dir, func(src, plainName string, data []byte) error {
		called = true
		return nil
	})

	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if called {
		t.Error("processFn should not be called when ageKeyPath is empty")
	}
}

func TestProcessEncryptedFilesDirNotFound(t *testing.T) {
	mgr := NewManager("/some/key.txt")
	err := mgr.ProcessEncryptedFiles("/nonexistent/dir", nil)
	if err == nil {
		t.Error("expected error for nonexistent dir, got nil")
	}
}

func TestProcessEncryptedFilesNoEncryptedFiles(t *testing.T) {
	dir := t.TempDir()

	plainPath := filepath.Join(dir, "plain.txt")
	if err := os.WriteFile(plainPath, []byte("plain content"), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager("/some/key.txt")
	called := false
	err := mgr.ProcessEncryptedFiles(dir, func(src, plainName string, data []byte) error {
		called = true
		return nil
	})

	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if called {
		t.Error("processFn should not be called for plain files")
	}
}

func TestEnsureSOPSInstalled(t *testing.T) {
	err := EnsureSOPSInstalled()
	if err != nil {
		t.Logf("sops not installed (expected in test env): %v", err)
	}
}

func TestGenAgeKey(t *testing.T) {
	t.Skip("requires age-keygen binary")
}
