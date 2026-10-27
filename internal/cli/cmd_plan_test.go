package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/singll/silkspool/internal/engine"
)

func writePlanFixture(t *testing.T, valid bool) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(`global:
  ssh_key_path: ./keys/id_test
hosts:
  keeper:
    address: "silkspool@192.168.7.231"
    magicdns: keeper-magic
    bundles: [demo]
`), 0644); err != nil {
		t.Fatal(err)
	}
	component := `    app:
      image: alpine:3.20@sha256:aaa111
`
	if !valid {
		component = `    app:
      bundle: missing-bundle
`
	}
	manifest := `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: demo
  class: composition
  version: 1.0.0
spec:
  components:
` + component
	path := filepath.Join(dir, "bundles", "demo")
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "manifest.yaml"), []byte(manifest), 0644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPlanOfflineValidExitZeroAndNoDiff(t *testing.T) {
	dir := writePlanFixture(t, true)
	cmd := NewRootCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--config", filepath.Join(dir, "silkspool.yaml"), "plan", "demo", "keeper", "--offline", "--json"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("plan offline: %v\n%s", err, buf.String())
	}
	var env JSONEnvelope
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, buf.String())
	}
	if !env.OK {
		t.Fatalf("expected ok, got %+v", env)
	}
	raw, _ := json.Marshal(env.Data)
	var result struct {
		Mode string                   `json:"mode"`
		Diff []map[string]interface{} `json:"diff"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Mode != "offline" {
		t.Errorf("mode = %q", result.Mode)
	}
	if len(result.Diff) != 0 {
		t.Errorf("offline diff = %+v, want empty", result.Diff)
	}
	if got := ExitCode(nil); got == ExitDiff {
		t.Fatal("offline must never return 3")
	}
}

func TestPlanOfflineInvalidExitTwo(t *testing.T) {
	dir := writePlanFixture(t, false)
	cmd := NewRootCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--config", filepath.Join(dir, "silkspool.yaml"), "plan", "demo", "keeper", "--offline", "--json"})
	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected invalid offline plan error")
	}
	if code := ExitCode(err); code != ExitUsage {
		t.Fatalf("exit code = %d, want %d (err=%v)", code, ExitUsage, err)
	}
}

type offlineActualRunner struct{}

func (offlineActualRunner) Exec(cmd string) (string, error)         { return "", nil }
func (offlineActualRunner) Upload(content, remotePath string) error { return nil }
func (offlineActualRunner) ReadFile(remotePath string) (string, error) {
	return "", os.ErrNotExist
}

func TestPlanOnlineDiffExitThree(t *testing.T) {
	dir := writePlanFixture(t, true)
	old := runnerFactory
	runnerFactory = func(address, sshKey, sshPort, knownHosts string) (engine.RemoteRunner, error) {
		return offlineActualRunner{}, nil
	}
	defer func() { runnerFactory = old }()

	cmd := NewRootCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--config", filepath.Join(dir, "silkspool.yaml"), "plan", "demo", "keeper", "--json"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected diff error\n%s", buf.String())
	}
	if code := ExitCode(err); code != ExitDiff {
		t.Fatalf("exit code = %d, want %d (err=%v)", code, ExitDiff, err)
	}
	var env JSONEnvelope
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, buf.String())
	}
	raw, _ := json.Marshal(env.Data)
	var result struct {
		Diff []map[string]interface{} `json:"diff"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Diff) == 0 {
		t.Error("expected non-empty diff")
	}
}
