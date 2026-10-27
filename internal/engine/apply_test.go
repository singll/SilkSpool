package engine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyWritesGenerationAndState(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.Generation != 1 || result.Status != "healthy" {
		t.Fatalf("result = %+v", result)
	}
	genDir := GenerationDir("/opt/silkspool/knowledge-stack", 1)
	for _, name := range []string{"docker-compose.yaml", "docker-compose.spool.yaml", ".env", "digest", "meta.yaml"} {
		if !runner.hasFile(filepath.Join(genDir, name)) {
			t.Errorf("missing generation snapshot %s", name)
		}
	}
	if got := runner.file(RemoteGenerationCurrentPath("/opt/silkspool/knowledge-stack")); got != "1\n" {
		t.Errorf("current = %q, want 1", got)
	}
	override := runner.file("/opt/silkspool/knowledge-stack/docker-compose.spool.yaml")
	if !strings.Contains(override, "super-secret") {
		t.Errorf("override should resolve secret at apply time:\n%s", override)
	}
	if strings.Contains(override, "secret://n8n_encryption_key") {
		t.Errorf("override still contains secret placeholder:\n%s", override)
	}
	if !strings.Contains(override, "io.silkspool.generation") {
		t.Errorf("override missing generation label:\n%s", override)
	}
	state, err := ReadLocalState(dir, "keeper", "knowledge-stack")
	if err != nil || state.Status != "healthy" || state.Generation != 1 {
		t.Errorf("state = %+v, err=%v", state, err)
	}
	for _, path := range runner.uploads {
		if strings.Contains(path, "silkdata") || strings.Contains(path, "postgres") {
			t.Errorf("dependency must not be applied, uploaded %s", path)
		}
	}
}

func TestApplyRetainsTwoGenerations(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	for i := 0; i < 3; i++ {
		if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true}); err != nil {
			t.Fatalf("apply %d: %v", i+1, err)
		}
	}
	genRoot := "/opt/silkspool/knowledge-stack/.spool-gen"
	if runner.hasFile(genRoot + "/1/meta.yaml") {
		t.Error("generation 1 should be pruned")
	}
	if !runner.hasFile(genRoot+"/2/meta.yaml") || !runner.hasFile(genRoot+"/3/meta.yaml") {
		t.Error("generations 2 and 3 should be retained")
	}
}

func TestApplyHealthFailureRollsBack(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true}); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	failOnce := true
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "bellkeeper\nn8n\n", nil
		}
		if strings.Contains(cmd, "exec -T") && failOnce {
			failOnce = false
			return "", errFakeHealth
		}
		return "", nil
	}
	result, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true})
	if err == nil {
		t.Fatal("expected health failure")
	}
	if result == nil || !result.RolledBack {
		t.Fatalf("expected rollback, result=%+v err=%v", result, err)
	}
	if got := runner.file(RemoteGenerationCurrentPath("/opt/silkspool/knowledge-stack")); got != "1\n" {
		t.Errorf("current = %q, want 1 after rollback", got)
	}
	if runner.hasFile(GenerationDir("/opt/silkspool/knowledge-stack", 2) + "/meta.yaml") {
		t.Error("failed generation 2 should be removed after rollback")
	}
	state, _ := ReadLocalState(dir, "keeper", "knowledge-stack")
	if state.Status != "rolled_back" {
		t.Errorf("state status = %q, want rolled_back", state.Status)
	}
}

func TestApplyIrreversibleRequiresExplicitApprovalAndKeepsFailedGeneration(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manifest := readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml")
	manifest += `  lifecycle:
    upgrade:
      irreversible: true
    restore:
      hook: scripts/restore.sh
  backup:
    hook: scripts/backup.sh
`
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), manifest)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "scripts", "backup.sh"), "#!/bin/sh\ntrue\n")
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "scripts", "restore.sh"), "#!/bin/sh\ntrue\n")

	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	resolved, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	seedDeployed(t, runner, resolved, 1)

	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{}); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("expected approval error, got %v", err)
	}

	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "bellkeeper\nn8n\n", nil
		}
		if strings.Contains(cmd, "exec -T") {
			return "", errFakeHealth
		}
		return "", nil
	}
	result, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true, AllowIrreversible: true})
	if err == nil {
		t.Fatal("expected health failure")
	}
	if result == nil || !result.NeedsAttention || result.RolledBack {
		t.Fatalf("result = %+v", result)
	}
	if got := runner.file(RemoteGenerationCurrentPath("/opt/silkspool/knowledge-stack")); got != "1\n" {
		t.Errorf("current = %q, want 1 (no auto rollback)", got)
	}
	if !runner.hasFile(GenerationDir("/opt/silkspool/knowledge-stack", 2) + "/meta.yaml") {
		t.Error("failed irreversible generation should be kept for inspection")
	}
	if !runner.commandContains("SPOOL_BACKUP_DIR=") || !runner.commandContains("SPOOL_GENERATION=") {
		t.Errorf("backup hook should receive env vars; commands=%v", runner.commands)
	}
	state, _ := ReadLocalState(dir, "keeper", "knowledge-stack")
	if state.Status != "needs_attention" {
		t.Errorf("state status = %q, want needs_attention", state.Status)
	}
}

func TestApplyLockedReproducesSnapshotAndRejectsMismatch(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	plan, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{WriteLock: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true, Locked: true})
	if err != nil {
		t.Fatalf("locked apply: %v", err)
	}
	if result.Generation != 1 {
		t.Errorf("generation = %d, want 1", result.Generation)
	}
	override := runner.file("/opt/silkspool/knowledge-stack/docker-compose.spool.yaml")
	for _, expected := range []string{"http://bellkeeper:8080", "silkdata-magic", "super-secret"} {
		if !strings.Contains(override, expected) {
			t.Errorf("locked override missing %q:\n%s", expected, override)
		}
	}
	if plan.Lock.LockHash == "" {
		t.Error("lock hash should not be empty")
	}

	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"),
		strings.Replace(readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml"),
			"docker.n8n.io/n8nio/n8n:1.62.1@sha256:ccc333", "docker.n8n.io/n8nio/n8n:1.63.0@sha256:ddd444", 1))
	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true, Locked: true}); !errors.Is(err, ErrLockMismatch) {
		t.Fatalf("expected lock mismatch, got %v", err)
	}
}

func TestHostLockSerializesSameHost(t *testing.T) {
	dir := t.TempDir()
	release, err := AcquireHostLock(dir, "keeper", 0)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer release()
	if _, err := AcquireHostLock(dir, "keeper", 0); !errors.Is(err, ErrHostLocked) {
		t.Fatalf("expected host locked, got %v", err)
	}
	other, err := AcquireHostLock(dir, "silkdata", 0)
	if err != nil {
		t.Fatalf("different host should not be locked: %v", err)
	}
	other()
}

func TestBackupAndRestoreHooks(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manifest := readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml")
	manifest += `  lifecycle:
    restore:
      hook: scripts/restore.sh
  backup:
    hook: scripts/backup.sh
`
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), manifest)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "scripts", "backup.sh"), "#!/bin/sh\ntrue\n")
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "scripts", "restore.sh"), "#!/bin/sh\ntrue\n")

	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	backupDir, err := manager.Backup(context.Background(), "knowledge-stack", "keeper", nil, nil)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if !strings.Contains(backupDir, "/backups/gen-") {
		t.Errorf("backup dir = %q", backupDir)
	}
	if !runner.commandContains("SPOOL_BACKUP_DIR=") {
		t.Error("backup hook should receive SPOOL_BACKUP_DIR")
	}

	resolved, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	seedDeployed(t, runner, resolved, 1)
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "bellkeeper\nn8n\n", nil
		}
		return "", nil
	}
	result, err := manager.Restore(context.Background(), "knowledge-stack", "keeper", backupDir)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if result.Status != "restored" {
		t.Errorf("restore status = %q", result.Status)
	}
	if !runner.commandContains("SPOOL_RESTORE_REF=") {
		t.Error("restore hook should receive SPOOL_RESTORE_REF")
	}
}

func TestRestoreWithoutHookIsManual(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	runner.setFile("/opt/silkspool/knowledge-stack/backups/gen-1-20260101T000000Z/digest", "")
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Restore(context.Background(), "knowledge-stack", "keeper", "")
	var manual *ManualRestoreError
	if !errors.As(err, &manual) {
		t.Fatalf("expected ManualRestoreError, got %v", err)
	}
	if len(manual.BackupDirs) != 1 {
		t.Errorf("backup dirs = %v", manual.BackupDirs)
	}
	if result == nil || len(result.Warnings) == 0 {
		t.Error("expected manual restore warning")
	}
}

func TestScriptApplyRequiresYes(t *testing.T) {
	dir, cfg := resolverFixture(t)
	writeTestFile(t, filepath.Join(dir, "bundles", "scripted", "manifest.yaml"), `name: scripted
type: script
templates: [setup.sh]
services: [scripted]
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "scripted", "templates", "setup.sh"), "#!/bin/sh\ntrue\n")
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "scripted", "keeper", ApplyOptions{}); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("expected approval error, got %v", err)
	}
	result, err := manager.Apply(context.Background(), "scripted", "keeper", ApplyOptions{Yes: true})
	if err != nil {
		t.Fatalf("script apply: %v", err)
	}
	if result.Status != "succeeded" {
		t.Errorf("status = %q", result.Status)
	}
	if !runner.commandContains("bash setup.sh") {
		t.Errorf("setup.sh should run; commands=%v", runner.commands)
	}
	found := false
	for _, warning := range result.Warnings {
		if strings.Contains(warning, "without diff confirmation") {
			found = true
		}
	}
	if !found {
		t.Errorf("missing diff warning: %v", result.Warnings)
	}
}

func TestRollbackRestoresPreviousGeneration(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true}); err != nil {
		t.Fatal(err)
	}
	result, err := manager.Rollback(context.Background(), "knowledge-stack", "keeper", 0)
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if result.Generation != 1 {
		t.Errorf("generation = %d, want 1", result.Generation)
	}
	if got := runner.file(RemoteGenerationCurrentPath("/opt/silkspool/knowledge-stack")); got != "1\n" {
		t.Errorf("current = %q, want 1", got)
	}
	if _, err := manager.Rollback(context.Background(), "knowledge-stack", "keeper", 99); !errors.Is(err, ErrGenerationNotFound) {
		t.Fatalf("expected generation not found, got %v", err)
	}
}

func TestApplyConfigEnvFileUploadedAsGenerationEnv(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true}); err != nil {
		t.Fatal(err)
	}
	env := runner.file(GenerationDir("/opt/silkspool/knowledge-stack", 1) + "/.env")
	if !strings.Contains(env, "N8N_ENCRYPTION_KEY=super-secret") {
		t.Errorf(".env snapshot = %q", env)
	}
	if _, err := os.Stat(StatePath(dir, "keeper", "knowledge-stack")); err != nil {
		t.Errorf("state file missing: %v", err)
	}
}

func TestApplyDefaultHealthFallsBackToRunning(t *testing.T) {
	dir, cfg := resolverFixture(t)
	writeTestFile(t, filepath.Join(dir, "bundles", "plain", "manifest.yaml"), `name: plain
type: compose
templates: [compose.yaml]
services: [app]
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "plain", "templates", "compose.yaml"), `services:
  app:
    image: alpine:3.20@sha256:aaa111
`)
	runner := newFakeRunner()
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "", nil
		}
		return "", nil
	}
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "plain", "keeper", ApplyOptions{Yes: true}); err == nil {
		t.Fatal("expected default health failure when service is not running")
	}
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "app\n", nil
		}
		return "", nil
	}
	result, err := manager.Apply(context.Background(), "plain", "keeper", ApplyOptions{Yes: true})
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	if result.Status != "healthy" {
		t.Errorf("status = %q", result.Status)
	}
}

func TestApplyOptionalComponentFailureOnlyWarns(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manifest := strings.Replace(readResolverFile(t, dir, "bundles/knowledge-stack/manifest.yaml"),
		"    n8n:\n      image:", "    n8n:\n      optional: true\n      image:", 1)
	writeTestFile(t, filepath.Join(dir, "bundles", "knowledge-stack", "manifest.yaml"), manifest)
	runner := newFakeRunner()
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "exec -T") && strings.Contains(cmd, "n8n") {
			return "", errFakeHealth
		}
		return "", nil
	}
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{Yes: true})
	if err != nil {
		t.Fatalf("optional failure should not fail stack: %v", err)
	}
	found := false
	for _, warning := range result.Warnings {
		if strings.Contains(warning, "optional component n8n") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected optional warning, got %v", result.Warnings)
	}
}

func TestComposeApplyRequiresApprovalWhenChangesExist(t *testing.T) {
	dir, cfg := resolverFixture(t)
	runner := newFakeRunner()
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Apply(context.Background(), "knowledge-stack", "keeper", ApplyOptions{}); !errors.Is(err, ErrApprovalRequired) {
		t.Fatalf("expected approval error, got %v", err)
	}
	if runner.commandContains("up -d") {
		t.Fatal("compose up must not run before approval")
	}
}

func TestRenderRuntimeOverrideEscapesLiteralDollar(t *testing.T) {
	input := []byte("services:\n  web:\n    environment:\n      TOKEN: secret://token\n")
	override, err := renderRuntimeOverride(input, map[string]string{"token": "abc$UNSET"}, 1, "hash")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(override, "abc$$UNSET") {
		t.Fatalf("literal $ must be escaped for Compose interpolation: %s", override)
	}
}
