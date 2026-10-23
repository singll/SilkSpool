package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBundleConfigDir(t *testing.T) {
	dir := t.TempDir()

	hostScoped := &BundleManifest{}
	if got := BundleConfigDir(dir, "keeper", "demo", hostScoped); got != filepath.Join(dir, "hosts", "keeper") {
		t.Errorf("host scoped config dir = %q", got)
	}

	bundleScoped := &BundleManifest{ConfigRoot: "bundle"}
	if got := BundleConfigDir(dir, "keeper", "demo", bundleScoped); got != filepath.Join(dir, "hosts", "keeper", "demo") {
		t.Errorf("bundle scoped config dir = %q", got)
	}
}

func TestInitBundleDefaultsBundleScoped(t *testing.T) {
	dir := t.TempDir()
	writeBundleFixture(t, dir, "demo", `name: demo
type: compose
config_root: bundle
defaults:
  - path: .env
    content: |
      KEY=value
`)

	mgr, err := NewBundleManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := mgr.InitBundleDefaults("demo", "host1"); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "hosts", "host1", "demo", ".env")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("expected per-bundle .env: %v", err)
	}
	if string(data) != "KEY=value\n" {
		t.Errorf("unexpected content: %q", string(data))
	}
	if _, err := os.Stat(filepath.Join(dir, "hosts", "host1", ".env")); err == nil {
		t.Error("legacy .env should not be created for bundle-scoped config")
	}
}

func TestInitBundleDefaultsLegacyFallback(t *testing.T) {
	dir := t.TempDir()
	writeBundleFixture(t, dir, "demo", `name: demo
type: compose
config_root: bundle
defaults:
  - path: .env
    content: |
      KEY=default
`)
	legacy := filepath.Join(dir, "hosts", "host1", ".env")
	if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, []byte("KEY=legacy\n"), 0644); err != nil {
		t.Fatal(err)
	}

	mgr, err := NewBundleManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := mgr.InitBundleDefaults("demo", "host1"); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(dir, "hosts", "host1", "demo", ".env")); err == nil {
		t.Error("per-bundle .env should not shadow existing legacy config")
	}
	data, err := os.ReadFile(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "KEY=legacy\n" {
		t.Errorf("legacy config should be preserved, got %q", string(data))
	}
}

func TestInitBundleDefaultsHostScoped(t *testing.T) {
	dir := t.TempDir()
	writeBundleFixture(t, dir, "demo", `name: demo
type: compose
defaults:
  - path: .env
    content: |
      KEY=value
`)

	mgr, err := NewBundleManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := mgr.InitBundleDefaults("demo", "host1"); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(dir, "hosts", "host1", ".env")); err != nil {
		t.Errorf("expected legacy host-scoped .env: %v", err)
	}
}

func TestSyncBundleMissingConfigReturnsError(t *testing.T) {
	dir := t.TempDir()
	writeBundleFixture(t, dir, "demo", `name: demo
type: compose
config_root: bundle
defaults:
  - path: .env
    content: |
      KEY=value
`)
	cfgPath := filepath.Join(dir, "silkspool.yaml")
	if err := os.WriteFile(cfgPath, []byte(`global:
  ssh_key_path: ./keys/id_test
hosts:
  host1:
    address: "user@127.0.0.1"
`), 0644); err != nil {
		t.Fatal(err)
	}

	mgr, err := NewSyncManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	err = mgr.SyncBundle("host1", "demo", "/opt/demo")
	if err == nil {
		t.Fatal("expected missing config to return an error")
	}
	if !strings.Contains(err.Error(), "local file not found") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestJoinBundleRulePathPreservesDirectorySlash(t *testing.T) {
	if got := joinBundleRulePath("/tmp/config", "files/"); got != "/tmp/config/files/" {
		t.Errorf("joinBundleRulePath = %q, want trailing slash", got)
	}
	if got := joinBundleRulePath("/tmp/config", ".env"); got != "/tmp/config/.env" {
		t.Errorf("joinBundleRulePath = %q", got)
	}
}

func writeBundleFixture(t *testing.T, dir, name, manifest string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte("global:\n  ssh_key_path: ./keys/id_test\n"), 0644); err != nil {
		t.Fatal(err)
	}
	bundleDir := filepath.Join(dir, "bundles", name)
	if err := os.MkdirAll(bundleDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(manifest), 0644); err != nil {
		t.Fatal(err)
	}
}
