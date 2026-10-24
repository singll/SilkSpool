package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestInventoryCommandJSON(t *testing.T) {
	dir := t.TempDir()
	writeInventoryFixture(t, dir)

	cmd := NewRootCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--config", filepath.Join(dir, "silkspool.yaml"), "inventory", "--json"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("inventory failed: %v", err)
	}

	var env JSONEnvelope
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v\n%s", err, buf.String())
	}
	if !env.OK {
		t.Fatalf("expected ok envelope, got %+v", env)
	}
	if len(env.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", env.Warnings)
	}

	raw, err := json.Marshal(env.Data)
	if err != nil {
		t.Fatal(err)
	}
	var inv inventory
	if err := json.Unmarshal(raw, &inv); err != nil {
		t.Fatal(err)
	}
	if len(inv.Hosts) != 1 {
		t.Fatalf("hosts = %d, want 1", len(inv.Hosts))
	}
	host := inv.Hosts[0]
	if host.Name != "testhost" || host.Address != "user@10.0.0.2" {
		t.Errorf("unexpected host: %+v", host)
	}
	if len(host.Bundles) != 1 {
		t.Fatalf("bundles = %d, want 1", len(host.Bundles))
	}
	bundle := host.Bundles[0]
	if bundle.Name != "demo" || bundle.Class != "product" || bundle.Version != "1.2.3" {
		t.Errorf("unexpected bundle: %+v", bundle)
	}
	if bundle.Driver != "compose" {
		t.Errorf("driver = %q, want compose", bundle.Driver)
	}
	if bundle.DeployPath != "/opt/demo" {
		t.Errorf("deploy_path = %q, want /opt/demo", bundle.DeployPath)
	}
	if bundle.Kind != "Bundle" || bundle.Host != "testhost" {
		t.Errorf("kind/host = %q/%q", bundle.Kind, bundle.Host)
	}
	if bundle.Status != "declared" {
		t.Errorf("status = %q, want declared", bundle.Status)
	}
	if len(host.Services) != 1 || host.Services[0].Alias != "demo" {
		t.Errorf("unexpected services: %+v", host.Services)
	}
	if host.Services[0].Kind != "Service" || host.Services[0].Host != "testhost" {
		t.Errorf("service kind/host = %q/%q", host.Services[0].Kind, host.Services[0].Host)
	}
	if len(inv.Resources) == 0 {
		t.Error("resources should include bundle/service adapters")
	}
}

func TestInventoryCommandMissingBundleWarns(t *testing.T) {
	dir := t.TempDir()
	writeInventoryFixture(t, dir)
	if err := os.Remove(filepath.Join(dir, "bundles", "demo", "manifest.yaml")); err != nil {
		t.Fatal(err)
	}

	cmd := NewRootCmd()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"--config", filepath.Join(dir, "silkspool.yaml"), "inventory", "--json"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("inventory failed: %v", err)
	}

	var env JSONEnvelope
	if err := json.Unmarshal(buf.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v\n%s", err, buf.String())
	}
	if !env.OK {
		t.Fatalf("expected ok envelope, got %+v", env)
	}
	if len(env.Warnings) != 1 {
		t.Fatalf("warnings = %v, want 1", env.Warnings)
	}
}

func writeInventoryFixture(t *testing.T, dir string) {
	t.Helper()

	configYAML := `global:
  ssh_key_path: "./keys/id_test"
  defaults:
    deploy_path: "/opt/custom"
hosts:
  testhost:
    address: "user@10.0.0.2"
    app_prefix: "sp-"
    bundles: ["demo"]
    services:
      - alias: "demo"
        type: "docker"
        name: "sp-demo"
`
	if err := os.WriteFile(filepath.Join(dir, "silkspool.yaml"), []byte(configYAML), 0644); err != nil {
		t.Fatal(err)
	}

	bundleDir := filepath.Join(dir, "bundles", "demo")
	if err := os.MkdirAll(bundleDir, 0755); err != nil {
		t.Fatal(err)
	}
	manifestYAML := `apiVersion: spool/v1alpha1
kind: Bundle
name: demo
type: compose
class: product
version: 1.2.3
deploy_path: /opt/demo
services:
  - demo
labels:
  io.silkspool.product: demo
`
	if err := os.WriteFile(filepath.Join(bundleDir, "manifest.yaml"), []byte(manifestYAML), 0644); err != nil {
		t.Fatal(err)
	}
}
