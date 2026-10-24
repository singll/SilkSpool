package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func resolverFixture(t *testing.T) (string, *config.Config) {
	t.Helper()
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "silkspool.yaml"), `global:
  ssh_key_path: ./keys/id_test
hosts:
  keeper:
    address: "silkspool@192.168.7.231"
    magicdns: keeper-magic
    bundles: [knowledge-stack]
  silkdata:
    address: "silkspool@192.168.7.220"
    magicdns: silkdata-magic
    bundles: [silkdata]
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "bellkeeper", "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: bellkeeper
  class: product
  version: 2.4.0
spec:
  delivery:
    driver: compose
    templates: [compose.yaml]
  outputs:
    url: "${input.public_url}"
    health: "${input.public_url}/api/health"
    internal:
      kind: endpoint
      service: bellkeeper
      port: 8080
      remote: "${host.magicdns}"
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "bellkeeper", "templates", "compose.yaml"), `services:
  bellkeeper:
    image: ghcr.io/singll/bellkeeper:2.4.0@sha256:aaa111
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "silkdata", "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: silkdata
  class: capability
  version: 1.2.0
spec:
  delivery:
    driver: compose
    templates: [compose.yaml]
  outputs:
    postgres:
      kind: endpoint
      service: postgres
      port: 5432
      published_port: 5432
      remote: "${host.magicdns}"
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "silkdata", "templates", "compose.yaml"), `services:
  postgres:
    image: postgres:16-alpine@sha256:bbb222
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: knowledge-stack
  class: composition
  version: 1.0.0
spec:
  inputs:
    public_url: https://keeper.example.com
  components:
    bellkeeper:
      bundle: bellkeeper
      version: 2.4.0
      health:
        http: "${outputs.health}"
        from: container
        timeout: 0s
    n8n:
      image: docker.n8n.io/n8nio/n8n:1.62.1@sha256:ccc333
      after: [bellkeeper]
      health:
        http: http://127.0.0.1:5678/healthz
        from: container
        timeout: 0s
  dependencies:
    data:
      bundle: silkdata
      version: 1.2.0
      host: silkdata
      outputs: [postgres]
  wiring:
    n8n:
      BELLKEEPER_URL: "http://${components.bellkeeper.outputs.internal.host}:${components.bellkeeper.outputs.internal.port}"
      DB_HOST: "${dependencies.data.outputs.postgres.host}"
      DB_PORT: "${dependencies.data.outputs.postgres.port}"
      N8N_ENCRYPTION_KEY: "${secrets.n8n_encryption_key}"
`)
	writeTestFile(t, filepath.Join(dir, "hosts", "keeper", "knowledge-stack", ".env"), "N8N_ENCRYPTION_KEY=super-secret\n")
	cfg, err := config.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	return dir, cfg
}

func TestResolverSameHostUsesServiceName(t *testing.T) {
	dir, cfg := resolverFixture(t)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{WriteLock: true})
	if err != nil {
		t.Fatalf("ResolveBundle: %v", err)
	}
	env := plan.Lock.Resolved.Components["n8n"].Env
	if env["BELLKEEPER_URL"] != "http://bellkeeper:8080" {
		t.Errorf("BELLKEEPER_URL = %q, want http://bellkeeper:8080", env["BELLKEEPER_URL"])
	}
	if !strings.Contains(string(plan.Compose), ".spool/components/bellkeeper/compose.yaml") {
		t.Errorf("composition base should include component templates:\n%s", plan.Compose)
	}
	if !strings.Contains(string(plan.Compose), ".spool/components/n8n/compose.yaml") {
		t.Errorf("generated image component should be included:\n%s", plan.Compose)
	}
	if len(plan.Components) != 2 || plan.Components[0] != "bellkeeper" {
		t.Errorf("component order = %v, want bellkeeper before n8n", plan.Components)
	}
}

func TestResolverCrossHostUsesMagicDNS(t *testing.T) {
	dir, cfg := resolverFixture(t)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatalf("ResolveBundle: %v", err)
	}
	env := plan.Lock.Resolved.Components["n8n"].Env
	if env["DB_HOST"] != "silkdata-magic" || env["DB_PORT"] != "5432" {
		t.Errorf("DB = %s:%s, want silkdata-magic:5432", env["DB_HOST"], env["DB_PORT"])
	}
	dep := plan.Lock.Resolved.Dependencies["data"]
	if dep.Outputs["postgres"].Host != "silkdata-magic" {
		t.Errorf("dependency host = %q, want silkdata-magic", dep.Outputs["postgres"].Host)
	}
}

func TestResolverCrossHostFallsBackToAddress(t *testing.T) {
	dir, cfg := resolverFixture(t)
	cfg.Hosts["silkdata"] = config.HostConfig{Address: "silkspool@192.168.7.220"}
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatalf("ResolveBundle: %v", err)
	}
	env := plan.Lock.Resolved.Components["n8n"].Env
	if env["DB_HOST"] != "192.168.7.220" {
		t.Errorf("DB_HOST = %q, want 192.168.7.220", env["DB_HOST"])
	}
}

func TestResolverCrossHostMissingMagicDNSAndAddressFails(t *testing.T) {
	dir, cfg := resolverFixture(t)
	cfg.Hosts["silkdata"] = config.HostConfig{}
	_, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "needs MagicDNS or address") {
		t.Fatalf("expected topology error, got %v", err)
	}
}

func TestResolverAfterUnknownComponentFails(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manifest := strings.Replace(readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml"), "after: [bellkeeper]", "after: [missing]", 1)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), manifest)
	_, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "unknown component") {
		t.Fatalf("expected unknown component error, got %v", err)
	}
}

func TestResolverMissingReferenceFails(t *testing.T) {
	dir, cfg := resolverFixture(t)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"),
		strings.ReplaceAll(readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml"),
			"${dependencies.data.outputs.postgres.host}", "${dependencies.missing.outputs.postgres.host}"))
	_, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "unknown dependency reference") {
		t.Fatalf("expected unknown dependency error, got %v", err)
	}
}

func TestResolverAfterCycleFails(t *testing.T) {
	dir, cfg := resolverFixture(t)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: knowledge-stack
  class: composition
spec:
  components:
    a:
      image: alpine:3.20@sha256:aaa
      after: [b]
    b:
      image: alpine:3.20@sha256:bbb
      after: [a]
`)
	_, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("expected cycle error, got %v", err)
	}
}

func readResolverFile(t *testing.T, dir, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestResolverSensitiveUsesPlaceholderInLock(t *testing.T) {
	dir, cfg := resolverFixture(t)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{WriteLock: true})
	if err != nil {
		t.Fatalf("ResolveBundle: %v", err)
	}
	if !strings.Contains(plan.Lock.Rendered.Override, "secret://n8n_encryption_key") {
		t.Fatalf("lock override should contain secret placeholder:\n%s", plan.Lock.Rendered.Override)
	}
	if strings.Contains(plan.Lock.Rendered.Override, "super-secret") {
		t.Fatal("lock must not contain plaintext secret")
	}
	if !strings.Contains(plan.Lock.Rendered.Override, "io.silkspool.generation") {
		// generation label is added at apply time; lock should still be deterministic.
		t.Log("lock override does not include generation label (expected for plan)")
	}
}

func TestResolverWritesLockSnapshot(t *testing.T) {
	dir, cfg := resolverFixture(t)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{WriteLock: true})
	if err != nil {
		t.Fatalf("ResolveBundle: %v", err)
	}
	path := filepath.Join(dir, ".spool", "lock", "keeper", "knowledge-stack.yaml")
	if plan.LockPath != path {
		t.Errorf("LockPath = %q, want %q", plan.LockPath, path)
	}
	lock, err := LoadLock(dir, "keeper", "knowledge-stack")
	if err != nil {
		t.Fatalf("LoadLock: %v", err)
	}
	if lock.LockHash == "" || lock.LockHash != plan.Lock.LockHash {
		t.Errorf("lock hash mismatch: %q vs %q", lock.LockHash, plan.Lock.LockHash)
	}
	if len(lock.Resolved.Components) != 2 {
		t.Errorf("components = %d, want 2", len(lock.Resolved.Components))
	}
}

func TestResolverInputsHashChanges(t *testing.T) {
	dir, cfg := resolverFixture(t)
	a, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{Inputs: map[string]string{"public_url": "https://other"}})
	if err != nil {
		t.Fatal(err)
	}
	if a.Lock.InputsHash == b.Lock.InputsHash {
		t.Error("inputs hash should change when inputs change")
	}
}

func TestResolverRejectsVersionRange(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manifest := strings.Replace(readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml"), "version: 2.4.0", "version: ^2.4", 1)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), manifest)
	_, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "ranges are not supported") {
		t.Fatalf("expected version range error, got %v", err)
	}
}

func TestResolverIrreversibleWithoutBackupHookFails(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manifest := readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml")
	manifest += `  lifecycle:
    upgrade:
      irreversible: true
`
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), manifest)
	_, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "requires spec.backup.hook") {
		t.Fatalf("expected backup hook validation, got %v", err)
	}
}

func TestResolverBundleSourceDir(t *testing.T) {
	dir, _ := resolverFixture(t)
	if err := os.MkdirAll(filepath.Join(dir, "external", "registry"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "bundles", "bellkeeper"), filepath.Join(dir, "external", "registry", "bellkeeper")); err != nil {
		t.Fatal(err)
	}
	configData := readResolverFile(t, dir, "silkspool.yaml") + `bundle_sources:
  - name: bellkeeper
    type: dir
    path: ./external/registry
`
	writeTestFile(t, filepath.Join(dir, "silkspool.yaml"), configData)
	cfg, err := config.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatalf("ResolveBundle with dir source: %v", err)
	}
	if plan.Lock.Resolved.Components["bellkeeper"].Source == nil || plan.Lock.Resolved.Components["bellkeeper"].Source.Type != "dir" {
		t.Errorf("unexpected source: %+v", plan.Lock.Resolved.Components["bellkeeper"].Source)
	}
}

func TestResolverGitSourceRequiresPinnedCommit(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manifest := strings.Replace(readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml"),
		"    bellkeeper:\n      bundle: bellkeeper",
		"    bellkeeper:\n      bundle: bellkeeper\n      source:\n        type: git\n        repo: https://example.com/repo.git\n        commit: main", 1)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), manifest)
	_, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err == nil || !strings.Contains(err.Error(), "pinned") {
		t.Fatalf("expected pinned commit error, got %v", err)
	}
}

func TestResolverComponentsOnlyAreApplied(t *testing.T) {
	dir, cfg := resolverFixture(t)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range plan.Components {
		if key == "data" {
			t.Fatal("dependency must not appear in applied components")
		}
	}
	if len(plan.Lock.Resolved.Dependencies) != 1 {
		t.Fatalf("dependencies = %d, want 1", len(plan.Lock.Resolved.Dependencies))
	}
}
