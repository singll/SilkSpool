package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/singll/silkspool/internal/config"
	"github.com/singll/silkspool/internal/engine"
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

func apiFixture(t *testing.T) (string, *config.Config) {
	t.Helper()
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "silkspool.yaml"), `global:
  ssh_key_path: ./keys/id_test
hosts:
  h1:
    address: "user@127.0.0.1"
    magicdns: h1-magic
    bundles: [demo]
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "demo", "manifest.yaml"), `apiVersion: spool/v1alpha1
kind: Bundle
metadata:
  name: demo
  class: product
  version: 1.2.3
name: demo
type: compose
deploy_path: /opt/demo
templates: [compose.yaml]
services: [demo]
spec:
  outputs:
    internal:
      kind: endpoint
      service: demo
      port: 8081
`)
	writeTestFile(t, filepath.Join(dir, "bundles", "demo", "compose.yaml"), `services:
  demo:
    image: alpine:3.20@sha256:aaa111
`)
	cfg, err := config.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	return dir, cfg
}

type funcRunner struct {
	fn func(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error)
}

func (r *funcRunner) Run(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error) {
	return r.fn(ctx, action, target, opts)
}

func newTestHTTPServer(t *testing.T, dir string, cfg *config.Config, runner ActionRunner, token string, audit *AuditLogger) *httptest.Server {
	t.Helper()
	server := NewServer(dir, cfg, runner, token, audit)
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return httpServer
}

func getJSON(t *testing.T, url string, target interface{}) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if target != nil {
		if err := json.NewDecoder(resp.Body).Decode(target); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func postAction(t *testing.T, url string, request ActionRequest, headers map[string]string) (*http.Response, map[string]interface{}) {
	t.Helper()
	body, _ := json.Marshal(request)
	req, err := http.NewRequest(http.MethodPost, url+"/v1/actions", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]interface{}
	_ = json.NewDecoder(resp.Body).Decode(&doc)
	resp.Body.Close()
	return resp, doc
}

func waitJob(t *testing.T, server *httptest.Server, id string) Job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		req, err := http.NewRequest(http.MethodGet, server.URL+"/v1/jobs/"+id, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer secret")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var job Job
		decodeErr := json.NewDecoder(resp.Body).Decode(&job)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("job status = %d", resp.StatusCode)
		}
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if job.State == JobSucceeded || job.State == JobFailed {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return Job{}
}

func TestListenUnixPermission(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "spool.sock")
	listener, err := ListenUnix(socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Stat(socket)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("socket mode = %o, want 600", info.Mode().Perm())
	}
}

func TestInventoryBundleAndOutputs(t *testing.T) {
	dir, cfg := apiFixture(t)
	if _, err := engine.ResolveBundle(context.Background(), dir, cfg, "demo", "h1", engine.ResolveOptions{WriteLock: true}); err != nil {
		t.Fatal(err)
	}
	server := newTestHTTPServer(t, dir, cfg, &funcRunner{fn: func(context.Context, string, Target, ActionOptions) (interface{}, error) {
		return nil, nil
	}}, "", nil)

	var inventory Inventory
	if status := getJSON(t, server.URL+"/v1/inventory", &inventory); status != http.StatusOK {
		t.Fatalf("inventory status = %d", status)
	}
	if len(inventory.Hosts) != 1 || inventory.Hosts[0].Name != "h1" || len(inventory.Hosts[0].Bundles) != 1 {
		t.Fatalf("inventory = %+v", inventory)
	}

	var detail BundleDetail
	if status := getJSON(t, server.URL+"/v1/hosts/h1/bundles/demo", &detail); status != http.StatusOK {
		t.Fatalf("bundle detail status = %d", status)
	}
	if detail.Class != "product" || detail.Version != "1.2.3" || detail.DeployPath != "/opt/demo" {
		t.Errorf("detail = %+v", detail)
	}
	if detail.ResolvedOutputs["components.demo.internal"] != "demo:8081" {
		t.Errorf("resolved outputs = %+v", detail.ResolvedOutputs)
	}

	var outputs OutputsResponse
	if status := getJSON(t, server.URL+"/v1/hosts/h1/bundles/demo/outputs", &outputs); status != http.StatusOK {
		t.Fatalf("outputs status = %d", status)
	}
	if outputs.Outputs["internal"] != "endpoint:demo:8081" {
		t.Errorf("logical outputs = %+v", outputs.Outputs)
	}
	if status := getJSON(t, server.URL+"/v1/hosts/h1/bundles/demo/outputs?resolved=true", &outputs); status != http.StatusOK {
		t.Fatalf("resolved outputs status = %d", status)
	}
	if outputs.Outputs["components.demo.internal"] != "demo:8081" || !outputs.Resolved {
		t.Errorf("resolved outputs = %+v", outputs)
	}
}

func TestActionJobLifecycleAndAudit(t *testing.T) {
	dir, cfg := apiFixture(t)
	var audit bytes.Buffer
	runner := &funcRunner{fn: func(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error) {
		return map[string]interface{}{"generation": 7, "action": action}, nil
	}}
	server := newTestHTTPServer(t, dir, cfg, runner, "", NewAuditLogger(&audit))
	resp, doc := postAction(t, server.URL, ActionRequest{
		Action:         "bundle.apply",
		Target:         Target{Host: "h1", Bundle: "demo"},
		Options:        ActionOptions{Yes: true, Locked: true},
		IdempotencyKey: "deploy-1",
	}, map[string]string{ActorHeader: "ci"})
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, doc=%v", resp.StatusCode, doc)
	}
	id, _ := doc["job_id"].(string)
	job := waitJob(t, server, id)
	if job.State != JobSucceeded {
		t.Fatalf("job = %+v", job)
	}
	if job.Actor != "ci" || job.IdempotencyKey != "deploy-1" {
		t.Errorf("job identity = %+v", job)
	}
	result, _ := job.Result.(map[string]interface{})
	if result["generation"].(float64) != 7 {
		t.Errorf("result = %+v", job.Result)
	}
	logged := audit.String()
	for _, expected := range []string{`"actor":"ci"`, `"action":"bundle.apply"`, `"bundle":"demo"`, `"idempotency_key":"deploy-1"`, `"state":"succeeded"`} {
		if !strings.Contains(logged, expected) {
			t.Errorf("audit log missing %s: %s", expected, logged)
		}
	}
}

func TestIdempotencyKeyReusesUnfinishedJob(t *testing.T) {
	dir, cfg := apiFixture(t)
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	runner := &funcRunner{fn: func(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error) {
		started <- struct{}{}
		<-release
		return nil, nil
	}}
	server := newTestHTTPServer(t, dir, cfg, runner, "", nil)
	request := ActionRequest{
		Action:         "bundle.apply",
		Target:         Target{Host: "h1", Bundle: "demo"},
		Options:        ActionOptions{Yes: true},
		IdempotencyKey: "same-key",
	}
	resp1, doc1 := postAction(t, server.URL, request, nil)
	if resp1.StatusCode != http.StatusAccepted {
		t.Fatalf("first status = %d", resp1.StatusCode)
	}
	<-started
	resp2, doc2 := postAction(t, server.URL, request, nil)
	if resp2.StatusCode != http.StatusAccepted {
		t.Fatalf("second status = %d", resp2.StatusCode)
	}
	if doc1["job_id"] != doc2["job_id"] {
		t.Fatalf("job ids differ: %v vs %v", doc1["job_id"], doc2["job_id"])
	}
	if doc2["idempotent_reuse"] != true {
		t.Errorf("expected idempotent_reuse, got %v", doc2)
	}
	close(release)
	waitJob(t, server, doc1["job_id"].(string))
}

type concurrencyRunner struct {
	mu        sync.Mutex
	active    map[string]int
	maxActive map[string]int
	total     int
	maxTotal  int
	started   chan string
	release   chan struct{}
}

func (r *concurrencyRunner) Run(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error) {
	r.mu.Lock()
	r.active[target.Host]++
	r.total++
	if r.active[target.Host] > r.maxActive[target.Host] {
		r.maxActive[target.Host] = r.active[target.Host]
	}
	if r.total > r.maxTotal {
		r.maxTotal = r.total
	}
	r.mu.Unlock()
	r.started <- target.Host
	<-r.release
	r.mu.Lock()
	r.active[target.Host]--
	r.total--
	r.mu.Unlock()
	return nil, nil
}

func TestSameHostQueuesDifferentHostsParallel(t *testing.T) {
	dir, cfg := apiFixture(t)
	hostCfg := cfg.Hosts["h1"]
	hostCfg.Bundles = []string{"demo"}
	cfg.Hosts["h1"] = hostCfg
	cfg.Hosts["h2"] = config.HostConfig{Address: "user@127.0.0.2", Bundles: []string{"demo"}}
	runner := &concurrencyRunner{
		active:    map[string]int{},
		maxActive: map[string]int{},
		started:   make(chan string, 10),
		release:   make(chan struct{}),
	}
	server := newTestHTTPServer(t, dir, cfg, runner, "", nil)
	submit := func(host string) string {
		resp, doc := postAction(t, server.URL, ActionRequest{
			Action:  "bundle.apply",
			Target:  Target{Host: host, Bundle: "demo"},
			Options: ActionOptions{Yes: true},
		}, nil)
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("submit %s status = %d", host, resp.StatusCode)
		}
		return doc["job_id"].(string)
	}

	jobs := []string{submit("h1"), submit("h1"), submit("h2")}
	seen := map[string]bool{}
	deadline := time.After(2 * time.Second)
	for len(seen) < 2 {
		select {
		case id := <-runner.started:
			seen[id] = true
		case <-deadline:
			t.Fatalf("expected two hosts to start in parallel, started=%v", seen)
		}
	}
	if runner.maxActive["h1"] > 1 {
		t.Errorf("same host ran concurrently: %d", runner.maxActive["h1"])
	}
	close(runner.release)
	for _, id := range jobs {
		waitJob(t, server, id)
	}
	if runner.maxActive["h1"] != 1 {
		t.Errorf("h1 max active = %d, want 1", runner.maxActive["h1"])
	}
	if runner.maxTotal < 2 {
		t.Errorf("different hosts did not run in parallel: max total = %d", runner.maxTotal)
	}
}

func TestFailedJobAndApprovalAndToken(t *testing.T) {
	dir, cfg := apiFixture(t)
	runner := &funcRunner{fn: func(ctx context.Context, action string, target Target, opts ActionOptions) (interface{}, error) {
		return nil, fmt.Errorf("boom")
	}}
	server := newTestHTTPServer(t, dir, cfg, runner, "secret", nil)

	request := ActionRequest{Action: "bundle.apply", Target: Target{Host: "h1", Bundle: "demo"}}
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/actions", strings.NewReader(`{"action":"bundle.apply","target":{"host":"h1","bundle":"demo"}}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp, doc := postAction(t, server.URL, request, map[string]string{"Authorization": "Bearer secret"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected approval required, got %d doc=%v", resp.StatusCode, doc)
	}

	resp, doc = postAction(t, server.URL, ActionRequest{
		Action:  "bundle.apply",
		Target:  Target{Host: "h1", Bundle: "demo"},
		Options: ActionOptions{Yes: true},
	}, map[string]string{"Authorization": "Bearer secret", ActorHeader: "n8n"})
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d doc=%v", resp.StatusCode, doc)
	}
	job := waitJob(t, server, doc["job_id"].(string))
	if job.State != JobFailed || !strings.Contains(job.Error, "boom") {
		t.Fatalf("job = %+v", job)
	}

	resp, doc = postAction(t, server.URL, ActionRequest{
		Action: "bundle.rollback",
		Target: Target{Host: "h1", Bundle: "demo"},
	}, map[string]string{"Authorization": "Bearer secret", ApprovalHeader: "secret"})
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("approval token should allow rollback, got %d doc=%v", resp.StatusCode, doc)
	}
}
