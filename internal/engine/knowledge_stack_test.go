package engine

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode())
	})
	if err != nil {
		t.Fatal(err)
	}
}

func knowledgeStackFixture(t *testing.T) (string, *config.Config) {
	t.Helper()
	dir := t.TempDir()
	copyTree(t, filepath.Join("..", "..", "bundles", "knowledge-stack"), filepath.Join(dir, "bundles", "knowledge-stack"))
	copyTree(t, filepath.Join("..", "..", "bundles", "silkdata"), filepath.Join(dir, "bundles", "silkdata"))

	productRoot := filepath.Join(dir, "external", "bellkeeper")
	writeTestFile(t, filepath.Join(productRoot, "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: bellkeeper
  class: product
  version: 2.4.0
spec:
  delivery:
    driver: compose
    templates: [compose.yaml]
    artifact:
      type: image
      image: ghcr.io/singll/bellkeeper:2.4.0
      digest: sha256:aaa111
  outputs:
    url: "${input.public_url}"
    health: "${input.public_url}/api/health"
    internal:
      kind: endpoint
      service: bellkeeper
      port: 8080
      remote: "${host.magicdns}"
  lifecycle:
    upgrade:
      strategy: backup-then-recreate
    restore:
      hook: scripts/restore.sh
  backup:
    hook: scripts/backup.sh
`)
	writeTestFile(t, filepath.Join(productRoot, "compose.yaml"), `services:
  bellkeeper:
    image: ghcr.io/singll/bellkeeper:2.4.0
`)
	writeTestFile(t, filepath.Join(productRoot, "scripts", "backup.sh"), "#!/bin/sh\ntrue\n")
	writeTestFile(t, filepath.Join(productRoot, "scripts", "restore.sh"), "#!/bin/sh\ntrue\n")

	writeTestFile(t, filepath.Join(dir, "hosts", "keeper", ".env"), `N8N_ENCRYPTION_KEY=super-secret
N8N_OWNER_EMAIL=owner@example.com
N8N_OWNER_FIRSTNAME=Owner
N8N_PASSWORD=password
N8N_API_KEY=n8n-key
BELLKEEPER_DB_PASSWORD=db-password
BELLKEEPER_API_KEY=bk-key
BELLKEEPER_CREDENTIAL_KEY=credential-key
REDIS_PASSWORD=redis-password
MEILI_MASTER_KEY=meili-key
MEMOS_API_TOKEN=memos-token
COUCHDB_USER=admin
COUCHDB_PASSWORD=couch-password
COUCHDB_SECRET=couch-secret
`)
	writeTestFile(t, filepath.Join(dir, "silkspool.yaml"), `global:
  ssh_key_path: ./keys/id_test
hosts:
  keeper:
    address: "silkspool@192.168.7.230"
    magicdns: keeper-magic
    inputs:
      public_url: https://keeper.example.com
    bundles: [knowledge-stack]
  silkdata:
    address: "silkspool@192.168.7.231"
    magicdns: silkdata-magic
    bundles: [silkdata]
bundle_sources:
  - name: bellkeeper
    type: dir
    path: ./external/bellkeeper
`)
	cfg, err := config.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	return dir, cfg
}

func TestKnowledgeStackResolvesComponentsAndMagicDNS(t *testing.T) {
	dir, cfg := knowledgeStackFixture(t)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{WriteLock: true})
	if err != nil {
		t.Fatalf("ResolveBundle: %v", err)
	}
	if len(plan.Components) != 4 {
		t.Fatalf("components = %v, want bellkeeper/n8n/memos/rsshub", plan.Components)
	}
	for _, key := range []string{"bellkeeper", "n8n", "memos", "rsshub"} {
		if _, ok := plan.Lock.Resolved.Components[key]; !ok {
			t.Errorf("missing component %s", key)
		}
	}
	if _, ok := plan.Lock.Resolved.Dependencies["data"]; !ok {
		t.Fatal("missing dependency data")
	}
	if got := plan.Lock.Resolved.Components["n8n"].Env["BELLKEEPER_URL"]; got != "http://bellkeeper:8080" {
		t.Errorf("same-host n8n BELLKEEPER_URL = %q", got)
	}
	bellkeeperEnv := plan.Lock.Resolved.Components["bellkeeper"].Env
	if got := bellkeeperEnv["BELLKEEPER_DATABASE_HOST"]; got != "silkdata-magic" {
		t.Errorf("cross-host DB host = %q, want silkdata-magic", got)
	}
	if got := bellkeeperEnv["REDIS_HOST"]; got != "silkdata-magic" {
		t.Errorf("cross-host Redis host = %q, want silkdata-magic", got)
	}
	lifecycle, ok := plan.Lifecycles["bellkeeper"]
	if !ok || lifecycle.Backup.Hook != "scripts/backup.sh" {
		t.Errorf("component backup hook not inherited: %+v", lifecycle)
	}
	if !strings.Contains(string(plan.Compose), ".spool/components/n8n/compose.yaml") {
		t.Errorf("composition base missing n8n include:\n%s", plan.Compose)
	}
	for path := range plan.Uploads {
		if strings.Contains(path, "postgres") {
			t.Errorf("dependency template must not be uploaded: %s", path)
		}
	}
}

func TestKnowledgeStackTemplatesHaveNoHardcodedIPsOrContainerNames(t *testing.T) {
	root := filepath.Join("..", "..", "bundles", "knowledge-stack")
	ipPattern := regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}\b`)
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(data)
		if ipPattern.MatchString(text) {
			t.Errorf("%s contains a hardcoded IP", path)
		}
		if strings.Contains(text, "container_name:") {
			t.Errorf("%s contains container_name", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestKeeperAliasDeprecationWarningAndComponentsOnly(t *testing.T) {
	dir, cfg := knowledgeStackFixture(t)
	writeTestFile(t, filepath.Join(dir, "bundles", "keeper", "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: keeper
  class: composition
alias_of: knowledge-stack
`)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "keeper", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatalf("ResolveBundle alias: %v", err)
	}
	found := false
	for _, warning := range plan.Warnings {
		if strings.Contains(warning, "deprecated alias") && strings.Contains(warning, "knowledge-stack") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected deprecation warning, got %v", plan.Warnings)
	}
	if _, ok := plan.Lock.Resolved.Dependencies["data"]; !ok {
		t.Fatal("alias should keep dependency outputs")
	}

	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "keeper", "keeper", ApplyOptions{Yes: true}); err != nil {
		t.Fatalf("Apply alias: %v", err)
	}
	for _, path := range runner.uploads {
		if strings.Contains(path, "silkdata") || strings.Contains(path, "postgres") {
			t.Errorf("dependency must not be applied through alias: %s", path)
		}
	}
}

func TestKnowledgeStackApplyRunsComponentBackupHook(t *testing.T) {
	dir, cfg := knowledgeStackFixture(t)
	runner := newFakeRunner()
	resolved, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	seedDeployed(t, runner, resolved, 1)
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.BackupDir == "" {
		t.Fatal("expected backup dir from product backup hook")
	}
	if !runner.commandContains("component-bellkeeper-backup.sh") {
		t.Errorf("backup hook not executed; commands=%v", runner.commands)
	}
	if !runner.commandContains("SPOOL_BACKUP_DIR=") || !runner.commandContains("SPOOL_GENERATION=") {
		t.Errorf("backup hook missing env; commands=%v", runner.commands)
	}
	if result.Status != "healthy" {
		t.Errorf("status = %q", result.Status)
	}
	for _, path := range runner.uploads {
		if strings.Contains(path, "silkdata") || strings.Contains(path, "/postgres/") {
			t.Errorf("dependency must not be applied: %s", path)
		}
	}
}

func TestMagicDNSWiringAvoidsExtraHosts(t *testing.T) {
	dir, cfg := knowledgeStackFixture(t)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(plan.Override), "extra_hosts") {
		t.Errorf("MagicDNS wiring should not generate extra_hosts:\n%s", plan.Override)
	}
}

func TestAddressFallbackGeneratesExtraHosts(t *testing.T) {
	dir, cfg := knowledgeStackFixture(t)
	cfg.Hosts["silkdata"] = config.HostConfig{Address: "silkspool@192.168.7.231"}
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	override := string(plan.Override)
	if !strings.Contains(override, "extra_hosts") || !strings.Contains(override, "postgres:192.168.7.231") {
		t.Errorf("address fallback should generate extra_hosts:\n%s", override)
	}
	if strings.Contains(override, "silkdata-magic") {
		t.Errorf("address fallback should not use MagicDNS:\n%s", override)
	}
}

func TestKnowledgeStackRestoreUsesComponentHook(t *testing.T) {
	dir, cfg := knowledgeStackFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	result, err := manager.Restore(context.Background(), "knowledge-stack", "keeper", "/opt/silkspool/keeper/backups/gen-1")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if result.Status != "restored" {
		t.Errorf("status = %q", result.Status)
	}
	if !runner.commandContains("component-bellkeeper-restore.sh") {
		t.Errorf("restore hook not executed: %v", runner.commands)
	}
	if !runner.commandContains("SPOOL_RESTORE_REF=") {
		t.Errorf("restore hook missing SPOOL_RESTORE_REF: %v", runner.commands)
	}
}

func TestPlanOnlineShowsMagicDNSTopologyChange(t *testing.T) {
	dir, cfg := knowledgeStackFixture(t)
	resolved, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	runner := newFakeRunner()
	seedDeployed(t, runner, resolved, 1)
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "bellkeeper\nmemos\nn8n\nrsshub\n", nil
		}
		return "", nil
	}

	updated := cfg.Hosts["silkdata"]
	updated.MagicDNS = "silkdata-new"
	cfg.Hosts["silkdata"] = updated
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Plan(context.Background(), "knowledge-stack", "keeper", PlanOptions{})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(result.Diff) == 0 {
		t.Fatal("expected diff after MagicDNS topology change")
	}
	found := false
	for _, entry := range result.Diff {
		if entry.Field == "lock_hash" || entry.Field == "compose_sha256" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected lock/compose hash diff, got %+v", result.Diff)
	}
}
