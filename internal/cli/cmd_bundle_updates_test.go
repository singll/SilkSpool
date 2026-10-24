package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/singll/silkspool/internal/engine"
)

type cliFakeRegistry struct{}

func (cliFakeRegistry) ListTags(ctx context.Context, repository string) ([]string, error) {
	return []string{"1.0.0", "1.1.0"}, nil
}

func TestBundleCheckUpdatesJSON(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(`global:
  ssh_key_path: ./keys/id_test
hosts:
  h1:
    address: "user@127.0.0.1"
`), 0644); err != nil {
		t.Fatal(err)
	}
	bundleDir := filepath.Join(dir, "bundles", "demo")
	if err := os.MkdirAll(bundleDir, 0755); err != nil {
		t.Fatal(err)
	}
	manifest := `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: demo
  class: product
  version: 1.0.0
spec:
  components:
    web:
      image: ghcr.io/example/web:1.0.0@sha256:abc
`
	if err := os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(manifest), 0644); err != nil {
		t.Fatal(err)
	}

	previousFactory := engine.RegistryClientFactory
	engine.RegistryClientFactory = func() engine.RegistryClient { return cliFakeRegistry{} }
	defer func() { engine.RegistryClientFactory = previousFactory }()
	defer func() { jsonFlag = false }()

	cmd := NewRootCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--config", filepath.Join(dir, "silkspool.yaml"), "bundle", "check-updates", "demo", "--json"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("check-updates: %v\n%s", err, buf.String())
	}
	var env JSONEnvelope
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env.Data)
	var report engine.UpdateReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatal(err)
	}
	if report.Bundle != "demo" || len(report.Images) != 1 {
		t.Fatalf("report = %+v", report)
	}
	if !report.Images[0].UpdateAvailable || report.Images[0].LatestTag != "1.1.0" {
		t.Errorf("image = %+v", report.Images[0])
	}
}
