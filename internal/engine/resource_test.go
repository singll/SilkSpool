package engine

import (
	"context"
	"errors"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func TestBundleResourceStatusAndPlan(t *testing.T) {
	dir, cfg := resolverFixture(t)
	if _, err := ResolveBundle(context.Background(), dir, cfg, "knowledge-stack", "keeper", ResolveOptions{WriteLock: true}); err != nil {
		t.Fatal(err)
	}
	if err := WriteLocalState(dir, &LocalState{Host: "keeper", Bundle: "knowledge-stack", Generation: 3, Status: "healthy"}); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(dir, cfg, nil)
	resource := NewBundleResource(manager, "knowledge-stack", "keeper")
	if resource.Kind() != "Bundle" || resource.Name() != "knowledge-stack" {
		t.Errorf("kind/name = %s/%s", resource.Kind(), resource.Name())
	}
	status, err := resource.Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Status != "healthy" || status.Generation != 3 {
		t.Errorf("status = %+v", status)
	}
	if status.Outputs["components.bellkeeper.internal"] != "bellkeeper:8080" {
		t.Errorf("outputs = %+v", status.Outputs)
	}
	plan, err := resource.Plan(context.Background(), ResourceOptions{Offline: true})
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if plan.Mode != "offline" {
		t.Errorf("mode = %q", plan.Mode)
	}
}

func TestServiceResourceUnsupportedVerbs(t *testing.T) {
	resource := NewServiceResource(t.TempDir(), "keeper", "n8n")
	if resource.Kind() != "Service" || resource.Name() != "n8n" {
		t.Errorf("kind/name = %s/%s", resource.Kind(), resource.Name())
	}
	if _, err := resource.Plan(context.Background(), ResourceOptions{}); err == nil {
		t.Fatal("expected plan unsupported")
	} else {
		var unsupported *UnsupportedError
		if !errors.As(err, &unsupported) {
			t.Errorf("error = %v, want UnsupportedError", err)
		}
	}
	if _, err := resource.Backup(context.Background(), ResourceOptions{}); err == nil {
		t.Fatal("expected backup unsupported")
	}
	if err := resource.Restore(context.Background(), BackupRef{}); err == nil {
		t.Fatal("expected restore unsupported")
	}
}

func TestListResourceStatusesIncludesBundleAndService(t *testing.T) {
	dir, cfg := resolverFixture(t)
	hostCfg := cfg.Hosts["keeper"]
	hostCfg.Services = []config.ServiceEntry{{Alias: "n8n", Type: "docker", Name: "sp-n8n"}}
	cfg.Hosts["keeper"] = hostCfg
	manager := NewManager(dir, cfg, nil)
	statuses := ListResourceStatuses(dir, cfg, manager)
	var bundleFound, serviceFound bool
	for _, status := range statuses {
		if status.Kind == "Bundle" && status.Name == "knowledge-stack" && status.Host == "keeper" {
			bundleFound = true
		}
		if status.Kind == "Service" && status.Name == "n8n" && status.Host == "keeper" {
			serviceFound = true
		}
	}
	if !bundleFound || !serviceFound {
		t.Errorf("statuses = %+v", statuses)
	}
}
