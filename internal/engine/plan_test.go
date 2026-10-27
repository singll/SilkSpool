package engine

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestPlanOfflineSkipsRemoteAndValidates(t *testing.T) {
	dir, cfg := resolverFixture(t)
	manager := NewManager(dir, cfg, nil)
	result, err := manager.Plan(context.Background(), "knowledge-stack", "keeper", PlanOptions{Offline: true})
	if err != nil {
		t.Fatalf("Plan offline: %v", err)
	}
	if result.Mode != "offline" {
		t.Errorf("mode = %q, want offline", result.Mode)
	}
	if len(result.Diff) != 0 {
		t.Errorf("offline diff = %v, want empty", result.Diff)
	}
	if result.Unsupported {
		t.Error("compose bundle should be supported")
	}
}

func TestPlanOfflineInvalidReturnsError(t *testing.T) {
	dir, cfg := resolverFixture(t)
	writeTestFile(t, dir+"/bundles/knowledge-stack/manifest.yaml", `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: knowledge-stack
  class: composition
spec:
  components:
    missing:
      bundle: does-not-exist
`)
	manager := NewManager(dir, cfg, nil)
	if _, err := manager.Plan(context.Background(), "knowledge-stack", "keeper", PlanOptions{Offline: true}); err == nil {
		t.Fatal("expected offline validation error")
	}
}

func TestPlanOnlineNoDiff(t *testing.T) {
	dir, cfg := resolverFixture(t)
	resolved, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	runner := newFakeRunner()
	seedDeployed(t, runner, resolved, 1)
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "bellkeeper\nn8n\n", nil
		}
		return "", nil
	}
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Plan(context.Background(), "knowledge-stack", "keeper", PlanOptions{})
	if err != nil {
		t.Fatalf("Plan online: %v", err)
	}
	if result.Mode != "online" {
		t.Errorf("mode = %q, want online", result.Mode)
	}
	if len(result.Diff) != 0 {
		t.Fatalf("unexpected diff: %+v", result.Diff)
	}
	if result.Actual.Generation != 1 {
		t.Errorf("actual generation = %d, want 1", result.Actual.Generation)
	}
}

func TestPlanOnlineDetectsDiff(t *testing.T) {
	dir, cfg := resolverFixture(t)
	resolved, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	runner := newFakeRunner()
	seedDeployed(t, runner, resolved, 1)
	metaPath := GenerationDir(resolved.DeployPath, 1) + "/meta.yaml"
	meta := GenerationMeta{
		Version:     1,
		Bundle:      "knowledge-stack",
		Host:        "keeper",
		Generation:  1,
		LockHash:    "sha256:old",
		ComposeHash: "sha256:old",
		Status:      "healthy",
		Services:    resolved.Services,
	}
	data, _ := yaml.Marshal(meta)
	runner.setFile(metaPath, string(data))
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "bellkeeper\n", nil
		}
		return "", nil
	}
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Plan(context.Background(), "knowledge-stack", "keeper", PlanOptions{})
	if err != nil {
		t.Fatalf("Plan online: %v", err)
	}
	if len(result.Diff) == 0 {
		t.Fatal("expected diff")
	}
	found := false
	for _, entry := range result.Diff {
		if entry.Field == "lock_hash" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected lock_hash diff, got %+v", result.Diff)
	}
}

func seedDeployed(t *testing.T, runner *fakeRunner, plan *ResolvedPlan, generation int) {
	t.Helper()
	runner.setFile(plan.DeployPath+"/docker-compose.yaml", string(plan.Compose))
	runner.setFile(plan.DeployPath+"/docker-compose.spool.yaml", string(plan.Override))
	runner.setFile(RemoteGenerationCurrentPath(plan.DeployPath), "1\n")
	meta := GenerationMeta{
		Version:     1,
		Bundle:      "knowledge-stack",
		Host:        "keeper",
		Generation:  generation,
		LockHash:    plan.Lock.LockHash,
		ComposeHash: plan.Lock.Rendered.ComposeSHA256,
		Status:      "healthy",
		Services:    plan.Services,
	}
	data, _ := yaml.Marshal(meta)
	runner.setFile(GenerationDir(plan.DeployPath, generation)+"/meta.yaml", string(data))
	runner.setFile(GenerationDir(plan.DeployPath, generation)+"/docker-compose.yaml", string(plan.Compose))
	runner.setFile(GenerationDir(plan.DeployPath, generation)+"/docker-compose.spool.yaml", string(plan.Override))
	for path, data := range plan.Uploads {
		runner.setFile(plan.DeployPath+"/"+filepath.ToSlash(path), string(data))
	}
}

func TestPlanScriptUnsupported(t *testing.T) {
	dir, cfg := resolverFixture(t)
	writeTestFile(t, dir+"/bundles/scripted/manifest.yaml", `name: scripted
type: script
templates: [setup.sh]
services: [scripted]
`)
	writeTestFile(t, dir+"/bundles/scripted/templates/setup.sh", "#!/bin/sh\ntrue\n")
	manager := NewManager(dir, cfg, nil)
	result, err := manager.Plan(context.Background(), "scripted", "keeper", PlanOptions{Offline: true})
	if err != nil {
		t.Fatalf("offline plan: %v", err)
	}
	if result.Unsupported {
		t.Error("offline plan for script should still be statically valid")
	}
	result, err = manager.Plan(context.Background(), "scripted", "keeper", PlanOptions{})
	if err != nil {
		t.Fatalf("online plan: %v", err)
	}
	if !result.Unsupported {
		t.Error("online script plan should be unsupported")
	}
}

func TestPlanOnlineDetectsRemoteFileDrift(t *testing.T) {
	dir, cfg := resolverFixture(t)
	resolved, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{})
	if err != nil {
		t.Fatal(err)
	}
	runner := newFakeRunner()
	seedDeployed(t, runner, resolved, 1)
	runner.execFn = func(cmd string) (string, error) {
		if strings.Contains(cmd, "ps --status running --services") {
			return "bellkeeper\nn8n\n", nil
		}
		return "", nil
	}
	// 直接修改远端 compose，但保持 generation 元数据不变。
	runner.setFile(resolved.DeployPath+"/docker-compose.yaml", "services:\n  drifted:\n    image: example/drifted:9.9.9\n")
	manager := NewManager(dir, cfg, runner)
	result, err := manager.Plan(context.Background(), "knowledge-stack", "keeper", PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diff) == 0 {
		t.Fatal("remote file drift must produce a non-empty diff")
	}
}
