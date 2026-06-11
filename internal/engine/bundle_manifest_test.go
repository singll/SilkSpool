package engine

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestManifestLoaderLoad(t *testing.T) {
	dir := t.TempDir()

	manifestYAML := `name: test-bundle
type: compose
features:
  docker_log_rotation: true
  docker_prune: false
  create_network: mynet
  git_clone:
    repo: https://github.com/example/repo.git
    path: src
defaults:
  - path: config/app.env
    content: "APP_ENV=production"
  - path: config/db.env
    content: "DB_HOST=localhost"
templates:
  - docker-compose.yaml
  - docker-compose.override.yaml
services:
  - web
  - db
`
	bundleDir := filepath.Join(dir, "bundles", "test-bundle")
	if err := os.MkdirAll(bundleDir, 0755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(bundleDir, "manifest.yaml"), manifestYAML)

	loader := NewManifestLoader(dir)
	manifest, err := loader.Load("test-bundle")
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}

	if manifest.Name != "test-bundle" {
		t.Errorf("Name = %q, want %q", manifest.Name, "test-bundle")
	}
	if manifest.Type != "compose" {
		t.Errorf("Type = %q, want %q", manifest.Type, "compose")
	}
	if !manifest.Features.DockerLogRotation {
		t.Error("DockerLogRotation should be true")
	}
	if manifest.Features.DockerPrune {
		t.Error("DockerPrune should be false")
	}
	if manifest.Features.CreateNetwork != "mynet" {
		t.Errorf("CreateNetwork = %q, want %q", manifest.Features.CreateNetwork, "mynet")
	}
	if manifest.Features.GitClone == nil {
		t.Fatal("GitClone should not be nil")
	}
	if manifest.Features.GitClone.Repo != "https://github.com/example/repo.git" {
		t.Errorf("GitClone.Repo = %q, unexpected", manifest.Features.GitClone.Repo)
	}
	if len(manifest.Defaults) != 2 {
		t.Errorf("Defaults count = %d, want 2", len(manifest.Defaults))
	}
	if manifest.Defaults[0].Path != "config/app.env" {
		t.Errorf("Defaults[0].Path = %q, want %q", manifest.Defaults[0].Path, "config/app.env")
	}
	if len(manifest.Templates) != 2 {
		t.Errorf("Templates count = %d, want 2", len(manifest.Templates))
	}
	if len(manifest.Services) != 2 {
		t.Errorf("Services count = %d, want 2", len(manifest.Services))
	}
}

func TestManifestLoaderLoadMissing(t *testing.T) {
	dir := t.TempDir()
	loader := NewManifestLoader(dir)
	_, err := loader.Load("nonexistent")
	if err == nil {
		t.Error("expected error for missing manifest")
	}
}

func TestManifestLoaderDefaultType(t *testing.T) {
	dir := t.TempDir()
	bundleDir := filepath.Join(dir, "bundles", "minimal")
	if err := os.MkdirAll(bundleDir, 0755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(bundleDir, "manifest.yaml"), `name: minimal
`)

	loader := NewManifestLoader(dir)
	manifest, err := loader.Load("minimal")
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if manifest.Type != "compose" {
		t.Errorf("default Type = %q, want %q", manifest.Type, "compose")
	}
}

func TestManifestLoaderDefaultName(t *testing.T) {
	dir := t.TempDir()
	bundleDir := filepath.Join(dir, "bundles", "auto-name")
	if err := os.MkdirAll(bundleDir, 0755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(bundleDir, "manifest.yaml"), `type: stack
`)

	loader := NewManifestLoader(dir)
	manifest, err := loader.Load("auto-name")
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if manifest.Name != "auto-name" {
		t.Errorf("Name = %q, want %q (should default to bundle dir name)", manifest.Name, "auto-name")
	}
}

func TestManifestLoaderInvalidYAML(t *testing.T) {
	dir := t.TempDir()
	bundleDir := filepath.Join(dir, "bundles", "bad")
	if err := os.MkdirAll(bundleDir, 0755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(bundleDir, "manifest.yaml"), `{{invalid yaml`)

	loader := NewManifestLoader(dir)
	_, err := loader.Load("bad")
	if err == nil {
		t.Error("expected error for invalid YAML")
	}
}

func TestBundleManifestYAMLRoundTrip(t *testing.T) {
	original := BundleManifest{
		Name: "test",
		Type: "stack",
		Features: BundleFeatures{
			DockerLogRotation: true,
			GitClone:          &GitClone{Repo: "https://example.com/repo.git", Path: "src"},
		},
		Defaults: []BundleDefault{
			{Path: "config.env", Content: "KEY=VAL"},
		},
		Templates: []string{"docker-compose.yaml"},
		Services:  []string{"app"},
	}

	data, err := yaml.Marshal(&original)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}

	var parsed BundleManifest
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}

	if parsed.Name != original.Name {
		t.Errorf("Name = %q, want %q", parsed.Name, original.Name)
	}
	if parsed.Type != original.Type {
		t.Errorf("Type = %q, want %q", parsed.Type, original.Type)
	}
}
