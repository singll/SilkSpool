package engine

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/tools"
)

type fakeDatasetLister struct {
	datasets []tools.TrueNASDataset
	err      error
}

func (f fakeDatasetLister) Datasets() ([]tools.TrueNASDataset, error) {
	return f.datasets, f.err
}

type fakeKeyChecker struct {
	statuses []KeyStatus
	err      error
}

func (f fakeKeyChecker) CheckStatus(hosts []string) ([]KeyStatus, error) {
	return f.statuses, f.err
}

func TestDatasetResourceContract(t *testing.T) {
	lister := fakeDatasetLister{datasets: []tools.TrueNASDataset{{
		ID: "tank/data", Name: "tank/data", Pool: "tank", Type: "FILESYSTEM", UsedBytes: 1024, AvailBytes: 2048,
	}}}
	resource := NewDatasetResource(t.TempDir(), "nas", "tank/data", lister)
	if resource.Kind() != "Dataset" || resource.Name() != "tank/data" {
		t.Fatalf("kind/name = %s/%s", resource.Kind(), resource.Name())
	}
	status, err := resource.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "present" || status.Host != "nas" || status.Outputs["pool"] != "tank" || status.Outputs["used_bytes"] != "1024" {
		t.Fatalf("status = %+v", status)
	}
	plan, err := resource.Plan(context.Background(), ResourceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Diff) != 0 || plan.Desired.LockHash != "dataset:present" {
		t.Fatalf("plan = %+v", plan)
	}
	plan, err = resource.Plan(context.Background(), ResourceOptions{Delete: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Diff) != 1 || plan.Diff[0].Desired != "absent" {
		t.Fatalf("delete plan = %+v", plan)
	}
	if _, err := resource.Apply(context.Background(), ResourceOptions{}); err == nil {
		t.Fatal("expected dataset apply unsupported")
	} else {
		var unsupported *UnsupportedError
		if !errors.As(err, &unsupported) || !strings.Contains(err.Error(), "unsupported") {
			t.Fatalf("error = %v, want UnsupportedError", err)
		}
	}
	if _, err := resource.Backup(context.Background(), ResourceOptions{}); err == nil {
		t.Fatal("expected dataset backup unsupported")
	}
	if err := resource.Restore(context.Background(), BackupRef{}); err == nil {
		t.Fatal("expected dataset restore unsupported")
	}
}

func TestDatasetResourceMissingAndError(t *testing.T) {
	resource := NewDatasetResource(t.TempDir(), "nas", "tank/missing", fakeDatasetLister{})
	status, err := resource.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "absent" {
		t.Fatalf("status = %+v", status)
	}
	plan, err := resource.Plan(context.Background(), ResourceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Diff) != 1 || plan.Diff[0].Actual != "absent" {
		t.Fatalf("plan = %+v", plan)
	}
	broken := NewDatasetResource(t.TempDir(), "nas", "tank/data", fakeDatasetLister{err: errors.New("api down")})
	if _, err := broken.Status(context.Background()); err == nil {
		t.Fatal("expected provider error")
	}
}

func TestKeyResourceContract(t *testing.T) {
	resource := NewKeyResource(t.TempDir(), "keeper", fakeKeyChecker{statuses: []KeyStatus{{Host: "keeper", Authorized: true}}})
	if resource.Kind() != "Key" || resource.Name() != "canonical" {
		t.Fatalf("kind/name = %s/%s", resource.Kind(), resource.Name())
	}
	status, err := resource.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "authorized" || status.Host != "keeper" {
		t.Fatalf("status = %+v", status)
	}
	for key, value := range status.Outputs {
		if !strings.HasPrefix(value, "secret://") {
			t.Fatalf("key output %s must be a reference, got %q", key, value)
		}
	}
	plan, err := resource.Plan(context.Background(), ResourceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Diff) != 0 || plan.Desired.LockHash != "key:authorized" {
		t.Fatalf("plan = %+v", plan)
	}
	missing := NewKeyResource(t.TempDir(), "keeper", fakeKeyChecker{statuses: []KeyStatus{{Host: "keeper"}}})
	plan, err = missing.Plan(context.Background(), ResourceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Diff) != 1 || plan.Diff[0].Actual != "missing" {
		t.Fatalf("missing plan = %+v", plan)
	}
	if _, err := resource.Apply(context.Background(), ResourceOptions{}); err == nil {
		t.Fatal("expected key apply unsupported")
	} else {
		var unsupported *UnsupportedError
		if !errors.As(err, &unsupported) {
			t.Fatalf("error = %v, want UnsupportedError", err)
		}
	}
	if _, err := resource.Backup(context.Background(), ResourceOptions{}); err == nil {
		t.Fatal("expected key backup unsupported")
	}
	if err := resource.Restore(context.Background(), BackupRef{}); err == nil {
		t.Fatal("expected key restore unsupported")
	}
}

func TestInventoryIncludesKeyAndDatasetResources(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{
		Hosts:   map[string]config.HostConfig{"keeper": {Address: "spool@example.test"}},
		TrueNAS: config.TrueNASConfig{Host: "nas", APIURL: "https://nas.example.test"},
	}
	declared := ListResourceStatusesWithOptions(dir, cfg, NewManager(dir, cfg, nil), ResourceInventoryOptions{})
	var keyDeclared, datasetDeclared bool
	for _, status := range declared {
		if status.Kind == "Key" && status.Host == "keeper" && status.Status == "declared" {
			keyDeclared = true
			for _, value := range status.Outputs {
				if strings.Contains(value, "PRIVATE") {
					t.Fatalf("key inventory leaked secret: %+v", status.Outputs)
				}
			}
		}
		if status.Kind == "Dataset" && status.Host == "nas" && status.Status == "declared" {
			datasetDeclared = true
		}
	}
	if !keyDeclared || !datasetDeclared {
		t.Fatalf("declared resources = %+v", declared)
	}

	probed := ListResourceStatusesWithOptions(dir, cfg, NewManager(dir, cfg, nil), ResourceInventoryOptions{
		Probe:         true,
		DatasetLister: fakeDatasetLister{datasets: []tools.TrueNASDataset{{Name: "tank/data", Pool: "tank", Type: "FILESYSTEM", UsedBytes: 1, AvailBytes: 2}}},
		KeyChecker:    fakeKeyChecker{statuses: []KeyStatus{{Host: "keeper", Authorized: true}}},
	})
	var datasetFound, keyAuthorized bool
	for _, status := range probed {
		if status.Kind == "Dataset" && status.Name == "tank/data" && status.Status == "present" {
			datasetFound = true
		}
		if status.Kind == "Key" && status.Host == "keeper" && status.Status == "authorized" {
			keyAuthorized = true
		}
	}
	if !datasetFound || !keyAuthorized {
		t.Fatalf("probed resources = %+v", probed)
	}
}
