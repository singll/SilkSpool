package openapigen

import (
	"bytes"
	"os"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestGeneratedClientIsUpToDate(t *testing.T) {
	specData, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	generated, err := Generate(specData)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := os.ReadFile("../../pkg/apiclient/client.gen.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(generated, committed) {
		t.Fatal("pkg/apiclient/client.gen.go is stale; run go generate ./internal/openapigen")
	}
}

func TestSpecCoversServeEndpoints(t *testing.T) {
	specData, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var parsed spec
	if err := yaml.Unmarshal(specData, &parsed); err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{
		"/healthz":                          false,
		"/v1/inventory":                     false,
		"/v1/hosts/{host}/bundles/{bundle}": false,
		"/v1/hosts/{host}/bundles/{bundle}/outputs": false,
		"/v1/actions":   false,
		"/v1/jobs/{id}": false,
	}
	for path := range parsed.Paths {
		if _, ok := expected[path]; !ok {
			t.Fatalf("unexpected OpenAPI path %s", path)
		}
		expected[path] = true
	}
	for path, found := range expected {
		if !found {
			t.Fatalf("missing OpenAPI path %s", path)
		}
	}
}
