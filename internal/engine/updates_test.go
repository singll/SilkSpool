package engine

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

type fakeRegistry struct {
	tags map[string][]string
	err  error
}

func (f *fakeRegistry) ListTags(ctx context.Context, repository string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.tags[repository], nil
}

func updatesFixture(t *testing.T) (string, *config.Config) {
	t.Helper()
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "silkspool.yaml"), `global:
  ssh_key_path: ./keys/id_test
hosts:
  h1:
    address: "user@127.0.0.1"
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "demo", "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: demo
  class: composition
  version: 1.0.0
spec:
  components:
    web:
      image: ghcr.io/example/web:1.2.3@sha256:aaa
    worker:
      image: ghcr.io/example/worker:2.0.0@sha256:bbb
    floating:
      image: ghcr.io/example/floating:latest
`)
	cfg, err := config.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	return dir, cfg
}

func TestCheckUpdatesReportsNewerTagsAndWarnsUnpinned(t *testing.T) {
	dir, cfg := updatesFixture(t)
	registry := &fakeRegistry{tags: map[string][]string{
		"ghcr.io/example/web":    {"1.2.3", "1.3.0", "1.10.0", "2.0.0-rc1"},
		"ghcr.io/example/worker": {"2.0.0", "1.9.9"},
	}}
	report, err := CheckUpdates(context.Background(), dir, cfg, "demo", registry)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Images) != 2 {
		t.Fatalf("images = %+v, want only digest-pinned", report.Images)
	}
	byImage := map[string]ImageUpdate{}
	for _, image := range report.Images {
		byImage[image.Image] = image
	}
	web := byImage["ghcr.io/example/web:1.2.3@sha256:aaa"]
	if web.Repository != "ghcr.io/example/web" || !web.UpdateAvailable || web.LatestTag != "2.0.0-rc1" {
		t.Errorf("web update = %+v", web)
	}
	worker := byImage["ghcr.io/example/worker:2.0.0@sha256:bbb"]
	if worker.UpdateAvailable || worker.LatestTag != "2.0.0" {
		t.Errorf("worker update = %+v", worker)
	}
	foundWarning := false
	for _, warning := range report.Warnings {
		if warning == "ghcr.io/example/floating:latest is not pinned to a digest" {
			foundWarning = true
		}
	}
	if !foundWarning {
		t.Errorf("expected unpinned warning, got %v", report.Warnings)
	}
}

func TestCheckUpdatesRegistryFailureIsWarning(t *testing.T) {
	dir, cfg := updatesFixture(t)
	report, err := CheckUpdates(context.Background(), dir, cfg, "demo", &fakeRegistry{err: context.DeadlineExceeded})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Warnings) == 0 {
		t.Fatal("expected registry warning")
	}
}

func TestCompareVersionTags(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.10.0", "1.9.9", 1},
		{"v2.0.0", "1.99.99", 1},
		{"2025-01-01", "2024-12-31", 1},
		{"1.2.3", "1.2.3", 0},
	}
	for _, tc := range cases {
		if got := compareVersionTags(tc.a, tc.b); got != tc.want {
			t.Errorf("compareVersionTags(%q,%q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestParseImageRef(t *testing.T) {
	ref, ok := ParseImageRef("docker.n8n.io/n8nio/n8n:1.62.1@sha256:abc")
	if !ok {
		t.Fatal("parse failed")
	}
	if ref.Registry != "docker.n8n.io" || ref.Repository != "n8nio/n8n" || ref.Tag != "1.62.1" || ref.Digest != "sha256:abc" {
		t.Errorf("ref = %+v", ref)
	}
	ref, ok = ParseImageRef("alpine:3.20")
	if !ok || ref.Registry != "docker.io" || ref.Repository != "library/alpine" {
		t.Errorf("ref = %+v", ref)
	}
}
