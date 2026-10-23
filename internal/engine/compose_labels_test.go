package engine

import (
	"testing"

	"gopkg.in/yaml.v3"
)

func TestRenderSpoolOverride(t *testing.T) {
	template := `services:
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
	override, err := renderSpoolOverride([][]byte{[]byte(template)}, "keeper", "knowledge-stack", "1.2.3")
	if err != nil {
		t.Fatalf("renderSpoolOverride error: %v", err)
	}

	var doc map[string]interface{}
	if err := yaml.Unmarshal(override, &doc); err != nil {
		t.Fatalf("unmarshal override: %v", err)
	}
	services := doc["services"].(map[string]interface{})

	for _, name := range []string{"web", "db", "cache"} {
		raw, ok := services[name].(map[string]interface{})
		if !ok {
			t.Fatalf("service %s missing from override", name)
		}
		labels := raw["labels"].(map[string]interface{})
		assertSpoolLabels(t, labels, "keeper", "knowledge-stack", name, "1.2.3")
	}

	// override 只包含 spool 注入项，不复制 image/labels 等原字段。
	web := services["web"].(map[string]interface{})
	if _, ok := web["image"]; ok {
		t.Error("override should not copy image")
	}
}

func TestRenderSpoolOverrideNoServices(t *testing.T) {
	override, err := renderSpoolOverride([][]byte{[]byte("name: demo\n")}, "keeper", "demo", "")
	if err != nil {
		t.Fatalf("renderSpoolOverride error: %v", err)
	}
	var doc map[string]interface{}
	if err := yaml.Unmarshal(override, &doc); err != nil {
		t.Fatalf("unmarshal override: %v", err)
	}
	if _, ok := doc["services"]; !ok {
		t.Error("override should contain an empty services map")
	}
}

func TestRenderSpoolOverrideInvalidYAML(t *testing.T) {
	if _, err := renderSpoolOverride([][]byte{[]byte("{{invalid")}, "keeper", "demo", ""); err == nil {
		t.Error("expected error for invalid YAML")
	}
}

func TestRenderComposeBaseSingle(t *testing.T) {
	data := []byte("services:\n  web:\n    image: nginx\n")
	base, err := renderComposeBase([]string{"00-base.yaml"}, [][]byte{data})
	if err != nil {
		t.Fatalf("renderComposeBase error: %v", err)
	}
	if string(base) != string(data) {
		t.Error("single template should be copied verbatim")
	}
}

func TestRenderComposeBaseMultipleUsesInclude(t *testing.T) {
	base, err := renderComposeBase([]string{"00-base.yaml", "10-app.yaml"}, [][]byte{[]byte("x: 1"), []byte("y: 2")})
	if err != nil {
		t.Fatalf("renderComposeBase error: %v", err)
	}
	var doc struct {
		Name    string   `yaml:"name"`
		Include []string `yaml:"include"`
	}
	if err := yaml.Unmarshal(base, &doc); err != nil {
		t.Fatalf("unmarshal base: %v", err)
	}
	if len(doc.Include) != 2 || doc.Include[0] != "00-base.yaml" || doc.Include[1] != "10-app.yaml" {
		t.Errorf("unexpected include list: %v", doc.Include)
	}
	if doc.Name != "" {
		t.Errorf("name should be empty when no template declares one, got %q", doc.Name)
	}
}

func TestRenderComposeBasePreservesProjectName(t *testing.T) {
	base, err := renderComposeBase(
		[]string{"00-base.yaml", "10-app.yaml"},
		[][]byte{[]byte("name: keeper\nnetworks: {}\n"), []byte("services:\n  app:\n    image: nginx\n")},
	)
	if err != nil {
		t.Fatalf("renderComposeBase error: %v", err)
	}
	var doc struct {
		Name    string   `yaml:"name"`
		Include []string `yaml:"include"`
	}
	if err := yaml.Unmarshal(base, &doc); err != nil {
		t.Fatalf("unmarshal base: %v", err)
	}
	if doc.Name != "keeper" {
		t.Errorf("project name = %q, want keeper", doc.Name)
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
