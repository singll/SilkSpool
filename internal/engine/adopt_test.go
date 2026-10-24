package engine

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/singll/silkspool/internal/config"
)

func adoptFixture(t *testing.T) (string, *config.Config, *fakeRunner) {
	t.Helper()
	dir := t.TempDir()
	cfg := &config.Config{
		Hosts: map[string]config.HostConfig{
			"keeper": {Address: "spool@example.test", AppPrefix: "sp-"},
		},
		Global: config.GlobalConfig{Defaults: config.DefaultsConfig{DeployPath: "/opt/silkspool"}},
	}
	runner := newFakeRunner()
	containers := []map[string]interface{}{
		{
			"Id": "id1", "Name": "/sp-demo-app", "Image": "sha256:app",
			"State": map[string]interface{}{"Status": "running", "Running": true},
			"Config": map[string]interface{}{
				"Image": "demo/app:1.0.0",
				"Labels": map[string]string{
					"com.docker.compose.project":              "demo",
					"com.docker.compose.service":              "app",
					"com.docker.compose.project.working_dir":  "/opt/app",
					"com.docker.compose.project.config_files": "/opt/app/docker-compose.yaml",
					"io.silkspool.generation":                 "7",
					"io.silkspool.version":                    "1.0.0",
				},
			},
			"Mounts":          []map[string]string{{"Type": "volume", "Name": "demo_data", "Source": "/var/lib/docker/volumes/demo_data/_data", "Destination": "/data"}},
			"NetworkSettings": map[string]interface{}{"Networks": map[string]interface{}{"demo_default": map[string]string{"NetworkID": "net1"}}},
		},
		{
			"Id": "id2", "Name": "/sp-demo-db", "Image": "sha256:db",
			"State": map[string]interface{}{"Status": "running", "Running": true},
			"Config": map[string]interface{}{
				"Image": "demo/db:1.0.0",
				"Labels": map[string]string{
					"com.docker.compose.project":             "demo",
					"com.docker.compose.service":             "db",
					"com.docker.compose.project.working_dir": "/opt/app",
				},
			},
			"Mounts":          []map[string]string{{"Type": "bind", "Source": "/srv/db", "Destination": "/var/lib/db"}},
			"NetworkSettings": map[string]interface{}{"Networks": map[string]interface{}{"demo_default": map[string]string{"NetworkID": "net1"}}},
		},
	}
	containerJSON, err := json.Marshal(containers)
	if err != nil {
		t.Fatal(err)
	}
	volumeJSON, err := json.Marshal([]map[string]interface{}{{
		"Name": "demo_data", "Driver": "local", "Mountpoint": "/var/lib/docker/volumes/demo_data/_data",
		"Labels": map[string]string{"com.docker.compose.project": "demo", "com.docker.compose.volume": "data"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	networkJSON, err := json.Marshal([]map[string]interface{}{{
		"Name": "demo_default", "Driver": "bridge", "Scope": "local",
		"Labels": map[string]string{"com.docker.compose.project": "demo", "com.docker.compose.network": "default"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	runner.execFn = func(cmd string) (string, error) {
		switch {
		case cmd == "docker ps -aq --filter label=com.docker.compose.project":
			return "id1\nid2\n", nil
		case strings.HasPrefix(cmd, "docker inspect "):
			return string(containerJSON), nil
		case strings.HasPrefix(cmd, "docker volume ls "):
			return "demo_data\n", nil
		case strings.HasPrefix(cmd, "docker volume inspect "):
			return string(volumeJSON), nil
		case strings.HasPrefix(cmd, "docker network ls "):
			return "net1\n", nil
		case strings.HasPrefix(cmd, "docker network inspect "):
			return string(networkJSON), nil
		default:
			return "", nil
		}
	}
	runner.setFile("/opt/app/docker-compose.yaml", `services:
  app:
    image: demo/app:1.0.0
  db:
    image: demo/db:1.0.0
`)
	return dir, cfg, runner
}

func TestAdoptDryRunWritesNothingAndUsesReadOnlyDockerCommands(t *testing.T) {
	dir, cfg, runner := adoptFixture(t)
	manager := NewManager(dir, cfg, runner)
	report, err := manager.Adopt(context.Background(), "keeper", AdoptOptions{Bundle: "demo", DryRun: true})
	if err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	if report.Written || report.DryRun != true {
		t.Fatalf("report = %+v", report)
	}
	if len(report.Containers) != 2 || report.Project != "demo" || report.DeployPath != "/opt/app" {
		t.Fatalf("report = %+v", report)
	}
	if len(report.Stateful) != 2 || report.Stateful[0] != "app" || report.Stateful[1] != "db" {
		t.Fatalf("stateful = %v", report.Stateful)
	}
	if _, err := os.Stat(filepath.Join(dir, "bundles", "demo", "manifest.yaml")); !os.IsNotExist(err) {
		t.Fatalf("dry-run wrote manifest: %v", err)
	}
	for _, cmd := range runner.commands {
		for _, forbidden := range []string{"docker stop", "docker start", "docker rm", "docker restart", "compose up", "compose down", "docker run"} {
			if strings.Contains(cmd, forbidden) {
				t.Fatalf("adopt must not mutate containers, ran %q", cmd)
			}
		}
	}
}

func TestAdoptWritesManifestStateAndLockWithoutRebuild(t *testing.T) {
	dir, cfg, runner := adoptFixture(t)
	manager := NewManager(dir, cfg, runner)
	report, err := manager.Adopt(context.Background(), "keeper", AdoptOptions{Bundle: "demo"})
	if err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	if !report.Written || report.Generation != 7 {
		t.Fatalf("report = %+v", report)
	}
	manifestPath := filepath.Join(dir, "bundles", "demo", "manifest.yaml")
	manifest, err := LoadManifestFromDir(filepath.Dir(manifestPath), "demo")
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Labels["io.silkspool.adopted"] != "true" {
		t.Fatalf("manifest labels = %+v", manifest.Labels)
	}
	if manifest.DeployPath != "/opt/app" || len(manifest.Templates) != 1 || manifest.Templates[0] != "docker-compose.yaml" {
		t.Fatalf("manifest = %+v", manifest)
	}
	if _, err := os.Stat(filepath.Join(dir, "bundles", "demo", "templates", "docker-compose.yaml")); err != nil {
		t.Fatalf("compose template not copied: %v", err)
	}
	state, err := ReadLocalState(dir, "keeper", "demo")
	if err != nil || state.Status != "adopted" || state.Generation != 7 {
		t.Fatalf("state = %+v, err=%v", state, err)
	}
	lock, err := LoadLock(dir, "keeper", "demo")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := lock.Resolved.Components["app"]; !ok {
		t.Fatalf("lock components = %+v", lock.Resolved.Components)
	}
	if lock.Rendered.ComposeSHA256 == "" || lock.LockHash == "" {
		t.Fatalf("lock = %+v", lock)
	}
	plan, err := manager.Plan(context.Background(), "demo", "keeper", PlanOptions{Offline: true})
	if err != nil {
		t.Fatalf("adopted bundle should plan offline: %v", err)
	}
	if len(plan.Desired.Services) != 2 {
		t.Fatalf("adopted services = %+v", plan.Desired.Services)
	}
	for _, cmd := range runner.commands {
		for _, forbidden := range []string{"docker stop", "docker start", "docker rm", "docker restart", "compose up", "compose down", "docker run"} {
			if strings.Contains(cmd, forbidden) {
				t.Fatalf("adopt must not mutate containers, ran %q", cmd)
			}
		}
	}
}

func TestAdoptRequiresBundleWhenMultipleProjects(t *testing.T) {
	dir, cfg, runner := adoptFixture(t)
	containers := []map[string]interface{}{
		{"Id": "id1", "Name": "/a", "Config": map[string]interface{}{"Labels": map[string]string{"com.docker.compose.project": "one"}}},
		{"Id": "id2", "Name": "/b", "Config": map[string]interface{}{"Labels": map[string]string{"com.docker.compose.project": "two"}}},
	}
	data, _ := json.Marshal(containers)
	runner.execFn = func(cmd string) (string, error) {
		if cmd == "docker ps -aq --filter label=com.docker.compose.project" {
			return "id1\nid2\n", nil
		}
		if strings.HasPrefix(cmd, "docker inspect ") {
			return string(data), nil
		}
		return "", nil
	}
	manager := NewManager(dir, cfg, runner)
	_, err := manager.Adopt(context.Background(), "keeper", AdoptOptions{})
	if err == nil || !strings.Contains(err.Error(), "multiple compose projects") {
		t.Fatalf("expected multiple project error, got %v", err)
	}
}

func TestAdoptRefusesToOverwriteWithoutForce(t *testing.T) {
	dir, cfg, runner := adoptFixture(t)
	manager := NewManager(dir, cfg, runner)
	if _, err := manager.Adopt(context.Background(), "keeper", AdoptOptions{Bundle: "demo"}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Adopt(context.Background(), "keeper", AdoptOptions{Bundle: "demo"}); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("expected overwrite refusal, got %v", err)
	}
	if _, err := manager.Adopt(context.Background(), "keeper", AdoptOptions{Bundle: "demo", Force: true}); err != nil {
		t.Fatalf("force adopt: %v", err)
	}
}
