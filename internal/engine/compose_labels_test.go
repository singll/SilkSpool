package engine

import (
	"testing"

	"gopkg.in/yaml.v3"
)

func TestInjectSpoolLabels(t *testing.T) {
	input := `services:
  web:
    image: nginx
    labels:
      existing: keep
  db:
    image: postgres
  cache:
    image: redis
    labels:
      - existing=keep
      - io.silkspool.bundle=old
`
	merged, err := injectSpoolLabels([]byte(input), "keeper", "knowledge-stack", "1.2.3")
	if err != nil {
		t.Fatalf("injectSpoolLabels error: %v", err)
	}

	var doc map[string]interface{}
	if err := yaml.Unmarshal(merged, &doc); err != nil {
		t.Fatalf("unmarshal merged: %v", err)
	}
	services := doc["services"].(map[string]interface{})

	webLabels := services["web"].(map[string]interface{})["labels"].(map[string]interface{})
	if webLabels["existing"] != "keep" {
		t.Errorf("web existing label = %v, want keep", webLabels["existing"])
	}
	assertSpoolLabels(t, webLabels, "keeper", "knowledge-stack", "web", "1.2.3")

	dbLabels := services["db"].(map[string]interface{})["labels"].(map[string]interface{})
	assertSpoolLabels(t, dbLabels, "keeper", "knowledge-stack", "db", "1.2.3")

	cacheLabels := services["cache"].(map[string]interface{})["labels"].([]interface{})
	got := make(map[string]string, len(cacheLabels))
	for _, item := range cacheLabels {
		s := item.(string)
		for i := 0; i < len(s); i++ {
			if s[i] == '=' {
				got[s[:i]] = s[i+1:]
				break
			}
		}
	}
	if got["existing"] != "keep" {
		t.Errorf("cache existing label = %q, want keep", got["existing"])
	}
	if got["io.silkspool.bundle"] != "knowledge-stack" {
		t.Errorf("cache bundle label = %q, want knowledge-stack", got["io.silkspool.bundle"])
	}
	if got["io.silkspool.component"] != "cache" {
		t.Errorf("cache component label = %q, want cache", got["io.silkspool.component"])
	}
}

func TestInjectSpoolLabelsNoServices(t *testing.T) {
	input := "name: demo\n"
	merged, err := injectSpoolLabels([]byte(input), "keeper", "demo", "")
	if err != nil {
		t.Fatalf("injectSpoolLabels error: %v", err)
	}
	if string(merged) == "" {
		t.Error("merged output should not be empty")
	}
}

func TestInjectSpoolLabelsInvalidYAML(t *testing.T) {
	if _, err := injectSpoolLabels([]byte("{{invalid"), "keeper", "demo", ""); err == nil {
		t.Error("expected error for invalid YAML")
	}
}

func assertSpoolLabels(t *testing.T, labels map[string]interface{}, host, bundle, component, version string) {
	t.Helper()
	want := map[string]string{
		"io.silkspool.managed":   "true",
		"io.silkspool.host":      host,
		"io.silkspool.bundle":    bundle,
		"io.silkspool.component": component,
	}
	if version != "" {
		want["io.silkspool.version"] = version
	}
	for k, v := range want {
		if labels[k] != v {
			t.Errorf("%s = %v, want %q", k, labels[k], v)
		}
	}
}
