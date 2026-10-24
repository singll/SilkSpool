package apiclient

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/singll/silkspool/internal/api"
	"github.com/singll/silkspool/internal/config"
)

type fakeRunner struct{}

func (fakeRunner) Run(ctx context.Context, action string, target api.Target, opts api.ActionOptions) (interface{}, error) {
	return map[string]interface{}{"action": action, "host": target.Host, "bundle": target.Bundle}, nil
}

func newTestClient(t *testing.T) *Client {
	t.Helper()
	dir := t.TempDir()
	manifest := `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: demo
  class: product
  version: 1.0.0
name: demo
type: compose
templates: [compose.yaml]
`
	if err := os.MkdirAll(filepath.Join(dir, "bundles", "demo"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bundles", "demo", "manifest.yaml"), []byte(manifest), 0644); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Hosts: map[string]config.HostConfig{
		"keeper": {Address: "spool@example.test", Bundles: []string{"demo"}},
	}}
	server := api.NewServer(dir, cfg, fakeRunner{}, "", nil)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return &Client{BaseURL: httpServer.URL}
}

func TestGeneratedClientEndToEnd(t *testing.T) {
	client := newTestClient(t)
	ctx := context.Background()

	health, err := client.GetHealth(ctx)
	if err != nil || health.Status != "ok" {
		t.Fatalf("health = %+v, err=%v", health, err)
	}

	inventory, err := client.GetInventory(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory.Hosts) != 1 || inventory.Hosts[0].Name != "keeper" {
		t.Fatalf("inventory = %+v", inventory)
	}

	detail, err := client.GetBundle(ctx, "keeper", "demo")
	if err != nil {
		t.Fatal(err)
	}
	if detail.Name != "demo" || detail.Class != "product" {
		t.Fatalf("detail = %+v", detail)
	}

	outputs, err := client.GetBundleOutputs(ctx, "keeper", "demo", nil)
	if err != nil {
		t.Fatal(err)
	}
	if outputs.Host != "keeper" || outputs.Bundle != "demo" {
		t.Fatalf("outputs = %+v", outputs)
	}

	accepted, err := client.SubmitAction(ctx, ActionRequest{
		Action:  "bundle.plan",
		Target:  Target{Host: "keeper", Bundle: "demo"},
		Options: ActionOptions{Offline: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if accepted.JobID == "" {
		t.Fatalf("accepted = %+v", accepted)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		job, err := client.GetJob(ctx, accepted.JobID)
		if err != nil {
			t.Fatal(err)
		}
		if job.State == "succeeded" || job.State == "failed" {
			if job.State != "succeeded" {
				t.Fatalf("job failed: %+v", job)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not finish: %+v", job)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGeneratedClientErrorResponse(t *testing.T) {
	client := newTestClient(t)
	_, err := client.GetBundle(context.Background(), "keeper", "missing")
	if err == nil {
		t.Fatal("expected error for missing bundle")
	}
}
