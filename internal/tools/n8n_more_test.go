package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestShellQuoteWithVariousInputs(t *testing.T) {
	tests := []struct {
		input    string
		contains string
	}{
		{"http://localhost:5678/api/v1/workflows", "http://localhost:5678/api/v1/workflows"},
		{"POST", "POST"},
		{"api-key-12345", "api-key-12345"},
		{"value with spaces", "value with spaces"},
	}
	for _, tt := range tests {
		result := shellQuote(tt.input)
		if !containsStr(result, tt.contains) {
			t.Errorf("shellQuote(%q) = %q, should contain %q", tt.input, result, tt.contains)
		}
	}
}

func TestLoadWorkflowFromFileEdgeCases(t *testing.T) {
	dir := t.TempDir()

	t.Run("workflow with all optional fields", func(t *testing.T) {
		data := `{
			"name": "full-wf",
			"active": true,
			"nodes": [],
			"connections": {},
			"settings": {"executionOrder": "v1"}
		}`
		path := filepath.Join(dir, "full.json")
		os.WriteFile(path, []byte(data), 0644)

		wf, err := LoadWorkflowFromFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if wf.Name != "full-wf" {
			t.Errorf("Name = %q", wf.Name)
		}
		if !wf.Active {
			t.Error("Active should be true")
		}
	})

	t.Run("workflow with only name", func(t *testing.T) {
		data := `{"name": "name-only"}`
		path := filepath.Join(dir, "name-only.json")
		os.WriteFile(path, []byte(data), 0644)

		wf, err := LoadWorkflowFromFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if wf.Name != "name-only" {
			t.Errorf("Name = %q", wf.Name)
		}
	})
}

func TestListLocalWorkflowsEmptyDir(t *testing.T) {
	dir := t.TempDir()
	mgr := &N8NManager{}
	files, err := mgr.ListLocalWorkflows(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Errorf("empty dir should return 0 files, got %d", len(files))
	}
}

func TestListLocalWorkflowsMixedFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"B01-notify.json", "K01-rss.json", "readme.md", "data.csv", "00-config.json"} {
		os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0644)
	}

	mgr := &N8NManager{}
	files, err := mgr.ListLocalWorkflows(dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(files) != 2 {
		t.Fatalf("expected 2 JSON files (excluding 00-config.json), got %d", len(files))
	}
}

func TestSanitizeFilenamePreservesUnicode(t *testing.T) {
	result := sanitizeFilename("K01-RSS采集")
	if result != "K01-RSS采集" {
		t.Errorf("unicode should be preserved, got %q", result)
	}
}

func TestHandleN8NResponseSuccessCodes(t *testing.T) {
	codes := []int{200, 201, 202, 204, 301, 302, 304}
	for _, code := range codes {
		_, err := handleN8NResponse(code, []byte(`{}`))
		if err != nil {
			t.Errorf("status %d should not error: %v", code, err)
		}
	}
}

func TestHandleN8NResponseErrorCodes(t *testing.T) {
	codes := []int{400, 401, 403, 404, 500, 502, 503}
	for _, code := range codes {
		_, err := handleN8NResponse(code, []byte(`{}`))
		if err == nil {
			t.Errorf("status %d should error", code)
		}
	}
}

func TestHandleN8NResponseZeroCode(t *testing.T) {
	_, err := handleN8NResponse(0, []byte(`{}`))
	if err == nil {
		t.Error("status 0 should error")
	}
}

func TestParseRemoteHTTPOutputBodyPreservation(t *testing.T) {
	output := "__SPOOL_HTTP_STATUS__:200\n__SPOOL_CURL_STATUS__:0\n__SPOOL_CURL_ERROR__:\n__SPOOL_BODY_BEGIN__\n{\"data\":[1,2,3]}"
	statusCode, curlCode, _, body, err := parseRemoteHTTPOutput(output)
	if err != nil {
		t.Fatal(err)
	}
	if statusCode != 200 {
		t.Errorf("statusCode = %d", statusCode)
	}
	if curlCode != 0 {
		t.Errorf("curlCode = %d", curlCode)
	}
	if string(body) != `{"data":[1,2,3]}` {
		t.Errorf("body = %q", string(body))
	}
}

func TestN8NClientStructWithHTTPClient(t *testing.T) {
	c := &N8NClient{
		baseURL:  "http://localhost:5678",
		apiKey:   "test-key",
		hostConn: "user@host",
		sshKey:   "/key",
	}
	if c.baseURL != "http://localhost:5678" {
		t.Errorf("baseURL = %q", c.baseURL)
	}
}

func TestN8NManagerCloseNilClient(t *testing.T) {
	mgr := &N8NManager{client: nil}
	if err := mgr.Close(); err != nil {
		t.Errorf("Close with nil client should not error: %v", err)
	}
}

func TestCleanWorkflowForCreatePreservesNodes(t *testing.T) {
	wf := &N8NWorkflow{
		Name:  "test",
		Nodes: []N8NNode{
			{ID: "1", Name: "A", Type: "start", Position: []int{0, 0}},
			{ID: "2", Name: "B", Type: "end", Position: []int{100, 100}},
		},
		Connections: map[string]interface{}{"A": "B"},
		Settings:    nil,
	}

	clean := cleanWorkflowForCreate(wf)
	if len(clean.Nodes) != 2 {
		t.Errorf("Nodes count = %d, want 2", len(clean.Nodes))
	}
	if clean.Connections == nil {
		t.Error("Connections should be preserved")
	}
}

func TestCleanWorkflowForUpdatePreservesNodes(t *testing.T) {
	wf := &N8NWorkflow{
		Name:  "test",
		Nodes: []N8NNode{{ID: "1", Name: "A", Type: "start", Position: []int{0, 0}}},
	}

	clean := cleanWorkflowForUpdate(wf)
	if len(clean.Nodes) != 1 {
		t.Errorf("Nodes count = %d, want 1", len(clean.Nodes))
	}
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
