package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestBundleManagerResolveDeployPathWithSyncRule(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts:
  testhost:
    address: "user@10.0.0.2"
    sync_rules:
      - local: "keeper/"
        remote: "/opt/silkspool/keeper"
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	m := &BundleManager{baseDir: dir}
	hostCfg := &config.HostConfig{
		SyncRules: []config.SyncRule{
			{Local: "keeper/", Remote: "/opt/silkspool/keeper"},
		},
	}

	path := m.resolveDeployPath("keeper", "testhost", hostCfg)
	if path != "/opt/silkspool" {
		t.Errorf("resolveDeployPath = %q, want /opt/silkspool", path)
	}
}

func TestBundleManagerResolveDeployPathDefault(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
  defaults:
    deploy_path: "/opt/custom"
hosts:
  testhost:
    address: "user@10.0.0.2"
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	m := &BundleManager{baseDir: dir}
	hostCfg := &config.HostConfig{}

	path := m.resolveDeployPath("myapp", "testhost", hostCfg)
	if !strings.Contains(path, "myapp") {
		t.Errorf("resolveDeployPath = %q, should contain myapp", path)
	}
}

func TestBundleManagerInitDefaultsNoManifest(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts: {}
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	m := &BundleManager{baseDir: dir}
	err := m.InitBundleDefaults("nonexistent", "testhost")
	if err != nil {
		t.Errorf("InitBundleDefaults with no manifest should return nil, got %v", err)
	}
}

func TestBundleManagerInitDefaultsEmptyDefaults(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts: {}
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	bundleDir := filepath.Join(dir, "bundles", "test-bundle")
	os.MkdirAll(bundleDir, 0755)
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte("name: test-bundle\ntype: compose\n"), 0644)

	m := &BundleManager{baseDir: dir}
	err := m.InitBundleDefaults("test-bundle", "testhost")
	if err != nil {
		t.Errorf("InitBundleDefaults with empty defaults should return nil, got %v", err)
	}
}

func TestBundleManagerInitDefaultsCreatesFiles(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts: {}
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	bundleDir := filepath.Join(dir, "bundles", "mybundle")
	os.MkdirAll(bundleDir, 0755)
	manifestYAML := `name: mybundle
type: compose
defaults:
  - path: "config/app.env"
    content: "APP_ENV=production"
  - path: "config/db.env"
    content: "DB_HOST=localhost"
`
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(manifestYAML), 0644)

	m := &BundleManager{baseDir: dir}
	if err := m.InitBundleDefaults("mybundle", "testhost"); err != nil {
		t.Fatalf("InitBundleDefaults: %v", err)
	}

	appEnvPath := filepath.Join(dir, "hosts", "testhost", "config", "app.env")
	data, err := os.ReadFile(appEnvPath)
	if err != nil {
		t.Fatalf("expected file at %s: %v", appEnvPath, err)
	}
	if string(data) != "APP_ENV=production" {
		t.Errorf("content = %q, want %q", string(data), "APP_ENV=production")
	}

	dbEnvPath := filepath.Join(dir, "hosts", "testhost", "config", "db.env")
	data2, _ := os.ReadFile(dbEnvPath)
	if string(data2) != "DB_HOST=localhost" {
		t.Errorf("content = %q, want %q", string(data2), "DB_HOST=localhost")
	}
}

func TestBundleManagerInitDefaultsSkipsExisting(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts: {}
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	bundleDir := filepath.Join(dir, "bundles", "mybundle")
	os.MkdirAll(bundleDir, 0755)
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(`name: mybundle
defaults:
  - path: "config/app.env"
    content: "SHOULD_NOT_OVERWRITE"
`), 0644)

	hostConfigDir := filepath.Join(dir, "hosts", "testhost", "config")
	os.MkdirAll(hostConfigDir, 0755)
	os.WriteFile(filepath.Join(hostConfigDir, "app.env"), []byte("EXISTING_CONTENT"), 0644)

	m := &BundleManager{baseDir: dir}
	if err := m.InitBundleDefaults("mybundle", "testhost"); err != nil {
		t.Fatalf("InitBundleDefaults: %v", err)
	}

	data, _ := os.ReadFile(filepath.Join(hostConfigDir, "app.env"))
	if string(data) != "EXISTING_CONTENT" {
		t.Errorf("existing file should not be overwritten, got %q", string(data))
	}
}

func TestNewBundleManagerMissingConfig(t *testing.T) {
	_, err := NewBundleManager(t.TempDir())
	if err == nil {
		t.Error("expected error for missing config")
	}
}

func TestBundleManagerSetupBundleUnknownAction(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts:
  testhost:
    address: "user@10.0.0.2"
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	bundleDir := filepath.Join(dir, "bundles", "mybundle")
	os.MkdirAll(bundleDir, 0755)
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte("name: mybundle\ntype: compose\n"), 0644)

	m := &BundleManager{baseDir: dir}
	err := m.SetupBundle("mybundle", "testhost", "unknown-action")
	if err == nil {
		t.Error("expected error for unknown action")
	}
	if !strings.Contains(err.Error(), "unknown action") {
		t.Errorf("error = %q, should contain 'unknown action'", err.Error())
	}
}

func TestBundleManagerSetupBundleServiceAction(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts:
  testhost:
    address: "user@10.0.0.2"
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	bundleDir := filepath.Join(dir, "bundles", "mybundle")
	os.MkdirAll(bundleDir, 0755)
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte("name: mybundle\ntype: compose\n"), 0644)

	m := &BundleManager{baseDir: dir}
	err := m.SetupBundle("mybundle", "testhost", "service")
	if err == nil {
		t.Error("expected error for service action without svc name")
	}
}

func TestBundleManagerSetupBundleHostNotFound(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `global:
  ssh_key_path: "./keys/id_rsa"
hosts: {}
`
	os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(yamlContent), 0644)

	m := &BundleManager{baseDir: dir}
	err := m.SetupBundle("mybundle", "nohost", "up")
	if err == nil {
		t.Error("expected error for unknown host")
	}
}

func TestManifestLoaderLoadEmptyManifest(t *testing.T) {
	dir := t.TempDir()
	bundleDir := filepath.Join(dir, "bundles", "empty")
	os.MkdirAll(bundleDir, 0755)
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(""), 0644)

	loader := NewManifestLoader(dir)
	manifest, err := loader.Load("empty")
	if err != nil {
		t.Fatalf("Load empty manifest: %v", err)
	}
	if manifest.Name != "empty" {
		t.Errorf("Name = %q, want %q", manifest.Name, "empty")
	}
	if manifest.Type != "compose" {
		t.Errorf("Type = %q, want %q", manifest.Type, "compose")
	}
}

func TestManifestLoaderLoadWithFeatures(t *testing.T) {
	dir := t.TempDir()
	bundleDir := filepath.Join(dir, "bundles", "feat")
	os.MkdirAll(bundleDir, 0755)
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(`name: feat
type: stack
features:
  docker_log_rotation: true
  docker_prune: true
  create_network: appnet
`), 0644)

	loader := NewManifestLoader(dir)
	manifest, err := loader.Load("feat")
	if err != nil {
		t.Fatal(err)
	}
	if !manifest.Features.DockerLogRotation {
		t.Error("DockerLogRotation should be true")
	}
	if !manifest.Features.DockerPrune {
		t.Error("DockerPrune should be true")
	}
	if manifest.Features.CreateNetwork != "appnet" {
		t.Errorf("CreateNetwork = %q, want %q", manifest.Features.CreateNetwork, "appnet")
	}
	if manifest.Features.GitClone != nil {
		t.Error("GitClone should be nil when not specified")
	}
}

func TestBundleManifestWithServices(t *testing.T) {
	dir := t.TempDir()
	bundleDir := filepath.Join(dir, "bundles", "svc")
	os.MkdirAll(bundleDir, 0755)
	os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(`name: svc
services:
  - web
  - db
  - cache
templates:
  - base.yaml
  - override.yaml
`), 0644)

	loader := NewManifestLoader(dir)
	manifest, err := loader.Load("svc")
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Services) != 3 {
		t.Errorf("Services count = %d, want 3", len(manifest.Services))
	}
	if len(manifest.Templates) != 2 {
		t.Errorf("Templates count = %d, want 2", len(manifest.Templates))
	}
}

func TestBundleManagerStruct(t *testing.T) {
	m := &BundleManager{baseDir: "/opt", sshKey: "/key"}
	if m.baseDir != "/opt" {
		t.Errorf("baseDir = %q", m.baseDir)
	}
	if m.sshKey != "/key" {
		t.Errorf("sshKey = %q", m.sshKey)
	}
}
