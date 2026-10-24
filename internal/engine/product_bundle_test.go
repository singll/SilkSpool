package engine

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestProductBundleContractOutputsHealthBackup(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "silkspool.yaml"), `global:
  ssh_key_path: ./keys/id_test
hosts:
  keeper:
    address: "silkspool@192.168.7.230"
    magicdns: keeper-magic
    bundles: [product]
`)
	root := filepath.Join(dir, "bundles", "product")
	writeTestFile(t, filepath.Join(root, "bundle.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: product
  class: product
  version: 1.0.0
name: product
type: compose
templates: [compose.yaml]
services: [app]
spec:
  delivery:
    driver: compose
    templates: [compose.yaml]
    artifact:
      type: image
      image: ghcr.io/example/app:1.0.0
      digest: sha256:abc
  outputs:
    internal:
      kind: endpoint
      service: app
      port: 8080
      remote: "${host.magicdns}"
  lifecycle:
    health:
      http: http://localhost:8080/api/health
      from: container
      timeout: 0s
    upgrade:
      strategy: backup-then-recreate
  backup:
    hook: scripts/backup.sh
`)
	writeTestFile(t, filepath.Join(root, "compose.yaml"), `services:
  app:
    image: ghcr.io/example/app:1.0.0
`)
	writeTestFile(t, filepath.Join(root, "scripts", "backup.sh"), "#!/bin/sh\ntrue\n")
	cfg, err := config.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := ResolveBundle(context.Background(), dir, cfg, "product", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatalf("ResolveBundle: %v", err)
	}
	if plan.Lock.Resolved.Components["product"].Outputs["internal"].Host != "app" {
		t.Errorf("same-host output = %+v", plan.Lock.Resolved.Components["product"].Outputs)
	}
	runner := newFakeRunner()
	seedDeployed(t, runner, plan, 1)
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Apply(context.Background(), "product", "keeper", ApplyOptions{Yes: true})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.BackupDir == "" || !runner.commandContains("bundle-backup.sh") {
		t.Errorf("backup hook not executed: result=%+v commands=%v", result, runner.commands)
	}
	override := runner.file("/opt/silkspool/product/docker-compose.spool.yaml")
	if !strings.Contains(override, "ghcr.io/example/app:1.0.0@sha256:abc") {
		t.Errorf("artifact digest not applied:\n%s", override)
	}
	if !runner.commandContains("http://localhost:8080/api/health") {
		t.Errorf("health check not executed: %v", runner.commands)
	}
}

func TestBundleSourceGitPinnedCommit(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	writeTestFile(t, filepath.Join(repo, "deploy", "bundle.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: external
  class: product
  version: 1.0.0
name: external
type: compose
templates: [compose.yaml]
services: [app]
`)
	writeTestFile(t, filepath.Join(repo, "deploy", "compose.yaml"), `services:
  app:
    image: alpine:3.20@sha256:abc
`)
	runGit(t, repo, "init", "-q")
	runGit(t, repo, "config", "user.email", "test@example.com")
	runGit(t, repo, "config", "user.name", "Test")
	runGit(t, repo, "add", ".")
	runGit(t, repo, "commit", "-q", "-m", "init")
	commit := strings.TrimSpace(runGit(t, repo, "rev-parse", "HEAD"))

	writeTestFile(t, filepath.Join(dir, "silkspool.yaml"), `global:
  ssh_key_path: ./keys/id_test
hosts:
  keeper:
    address: "silkspool@192.168.7.230"
bundle_sources:
  - name: external
    type: git
    repo: `+repo+`
    path: deploy
    commit: `+commit+`
`)
	cfg, err := config.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := ResolveBundle(context.Background(), dir, cfg, "external", "keeper", ResolveOptions{WriteLock: true})
	if err != nil {
		t.Fatalf("ResolveBundle git source: %v", err)
	}
	source := plan.Lock.Resolved.Components["external"].Source
	if source == nil || source.Type != "git" || source.Commit != commit {
		t.Errorf("source = %+v", source)
	}
	if !strings.Contains(string(plan.Compose), "alpine:3.20@sha256:abc") {
		t.Errorf("git template not rendered:\n%s", plan.Compose)
	}
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}
