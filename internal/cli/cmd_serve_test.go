package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestServeRequiresSocket(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte("global:\n  ssh_key_path: ./keys/id_test\n"), 0644); err != nil {
		t.Fatal(err)
	}
	cmd := NewRootCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--config", filepath.Join(dir, "silkspool.yaml"), "serve"})
	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected --socket validation error")
	}
	if ExitCode(err) != ExitUsage {
		t.Errorf("exit code = %d, want %d (err=%v)", ExitCode(err), ExitUsage, err)
	}
}
