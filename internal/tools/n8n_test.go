package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestN8NWorkflowStruct(t *testing.T) {
	wf := N8NWorkflow{
		Name:   "test-workflow",
		Active: true,
		Nodes: []N8NNode{
			{
				ID:       "node1",
				Name:     "Start",
				Type:     "n8n-nodes-base.start",
				Position: []int{100, 200},
			},
		},
	}

	data, err := json.Marshal(wf)
	if err != nil {
		t.Fatalf("failed to marshal workflow: %v", err)
	}

	var parsed N8NWorkflow
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal workflow: %v", err)
	}

	if parsed.Name != "test-workflow" {
		t.Errorf("Name = %q, want %q", parsed.Name, "test-workflow")
	}
	if !parsed.Active {
		t.Error("Active should be true")
	}
	if len(parsed.Nodes) != 1 {
		t.Fatalf("Nodes count = %d, want 1", len(parsed.Nodes))
	}
	if parsed.Nodes[0].ID != "node1" {
		t.Errorf("Node ID = %q, want %q", parsed.Nodes[0].ID, "node1")
	}
}

func TestN8NNodeStruct(t *testing.T) {
	node := N8NNode{
		ID:          "test-node",
		Name:        "HTTP Request",
		Type:        "n8n-nodes-base.httpRequest",
		TypeVersion: 4.2,
		Position:    []int{300, 400},
		Parameters: map[string]interface{}{
			"url":      "https://example.com",
			"method":   "GET",
		},
	}

	data, err := json.Marshal(node)
	if err != nil {
		t.Fatalf("failed to marshal node: %v", err)
	}

	var parsed N8NNode
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal node: %v", err)
	}

	if parsed.ID != "test-node" {
		t.Errorf("ID = %q, want %q", parsed.ID, "test-node")
	}
	if parsed.TypeVersion != 4.2 {
		t.Errorf("TypeVersion = %v, want 4.2", parsed.TypeVersion)
	}
	if len(parsed.Position) != 2 {
		t.Errorf("Position length = %d, want 2", len(parsed.Position))
	}
}

func TestLoadWorkflowFromFile(t *testing.T) {
	dir := t.TempDir()

	t.Run("valid workflow", func(t *testing.T) {
		wf := N8NWorkflow{
			Name: "K01-RSS采集",
			Nodes: []N8NNode{
				{ID: "n1", Name: "Start", Type: "n8n-nodes-base.start", Position: []int{0, 0}},
			},
		}
		data, _ := json.MarshalIndent(wf, "", "  ")
		path := filepath.Join(dir, "K01-rss-collect.json")
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}

		loaded, err := LoadWorkflowFromFile(path)
		if err != nil {
			t.Fatalf("LoadWorkflowFromFile failed: %v", err)
		}
		if loaded.Name != "K01-RSS采集" {
			t.Errorf("Name = %q, want %q", loaded.Name, "K01-RSS采集")
		}
	})

	t.Run("workflow without name uses filename", func(t *testing.T) {
		data := `{"nodes": []}`
		path := filepath.Join(dir, "B01-notify.json")
		if err := os.WriteFile(path, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}

		loaded, err := LoadWorkflowFromFile(path)
		if err != nil {
			t.Fatalf("LoadWorkflowFromFile failed: %v", err)
		}
		if loaded.Name != "B01-notify" {
			t.Errorf("Name = %q, want %q", loaded.Name, "B01-notify")
		}
	})

	t.Run("skip 00-config.json when name is empty", func(t *testing.T) {
		data := `{"nodes": []}`
		path := filepath.Join(dir, "00-config.json")
		if err := os.WriteFile(path, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}

		_, err := LoadWorkflowFromFile(path)
		if err == nil {
			t.Error("expected error for 00-config.json, got nil")
		}
	})

	t.Run("file not found", func(t *testing.T) {
		_, err := LoadWorkflowFromFile(filepath.Join(dir, "nonexistent.json"))
		if err == nil {
			t.Error("expected error for missing file, got nil")
		}
	})

	t.Run("invalid JSON", func(t *testing.T) {
		path := filepath.Join(dir, "invalid.json")
		if err := os.WriteFile(path, []byte("not json"), 0644); err != nil {
			t.Fatal(err)
		}
		_, err := LoadWorkflowFromFile(path)
		if err == nil {
			t.Error("expected error for invalid JSON, got nil")
		}
	})
}

func TestListLocalWorkflows(t *testing.T) {
	dir := t.TempDir()

	for _, name := range []string{"B01-notify.json", "K01-rss.json", "00-config.json", "readme.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}

	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0755); err != nil {
		t.Fatal(err)
	}

	mgr := &N8NManager{}
	files, err := mgr.ListLocalWorkflows(dir)
	if err != nil {
		t.Fatalf("ListLocalWorkflows failed: %v", err)
	}

	expected := map[string]bool{
		"B01-notify.json": false,
		"K01-rss.json":    false,
	}
	for _, f := range files {
		base := filepath.Base(f)
		if _, ok := expected[base]; ok {
			expected[base] = true
		} else if base == "00-config.json" || base == "readme.txt" {
			t.Errorf("unexpected file in result: %s", base)
		}
	}
	for name, found := range expected {
		if !found {
			t.Errorf("expected file %s not found in result", name)
		}
	}
}

func TestListLocalWorkflowsDirNotFound(t *testing.T) {
	mgr := &N8NManager{}
	_, err := mgr.ListLocalWorkflows("/nonexistent/path")
	if err == nil {
		t.Error("expected error for nonexistent dir, got nil")
	}
}

func TestCleanWorkflowForCreate(t *testing.T) {
	wf := &N8NWorkflow{
		ID:          "should-be-removed",
		Name:        "test-workflow",
		Active:      true,
		Nodes:       []N8NNode{{ID: "n1", Name: "Start", Type: "start", Position: []int{0, 0}}},
		Connections: map[string]interface{}{"conn1": "data"},
		Settings:    map[string]interface{}{"saveManualExecutions": true},
	}

	clean := cleanWorkflowForCreate(wf)

	if clean.ID != "" {
		t.Errorf("ID should be empty, got %q", clean.ID)
	}
	if clean.Active {
		t.Error("Active should be false")
	}
	if clean.Name != "test-workflow" {
		t.Errorf("Name = %q, want %q", clean.Name, "test-workflow")
	}
	if len(clean.Nodes) != 1 {
		t.Errorf("Nodes count = %d, want 1", len(clean.Nodes))
	}
	if _, ok := clean.Settings["executionOrder"]; !ok {
		t.Error("executionOrder should be set in settings")
	}
}

func TestCleanWorkflowForUpdate(t *testing.T) {
	wf := &N8NWorkflow{
		ID:          "should-be-removed",
		Name:        "test-workflow",
		Active:      true,
		Nodes:       []N8NNode{{ID: "n1", Name: "Start", Type: "start", Position: []int{0, 0}}},
		Connections: map[string]interface{}{"conn1": "data"},
		Settings:    nil,
	}

	clean := cleanWorkflowForUpdate(wf)

	if clean.ID != "" {
		t.Errorf("ID should be empty, got %q", clean.ID)
	}
	if clean.Name != "test-workflow" {
		t.Errorf("Name = %q, want %q", clean.Name, "test-workflow")
	}
	if _, ok := clean.Settings["executionOrder"]; !ok {
		t.Error("executionOrder should be set in settings")
	}
}

func TestWorkflowSettingsWithDefault(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]interface{}
		expected map[string]interface{}
	}{
		{
			name:     "nil settings",
			input:    nil,
			expected: map[string]interface{}{"executionOrder": "v1"},
		},
		{
			name:     "empty settings",
			input:    map[string]interface{}{},
			expected: map[string]interface{}{"executionOrder": "v1"},
		},
		{
			name: "settings without executionOrder",
			input: map[string]interface{}{"saveManualExecutions": true},
			expected: map[string]interface{}{"saveManualExecutions": true, "executionOrder": "v1"},
		},
		{
			name: "settings with executionOrder",
			input: map[string]interface{}{"executionOrder": "v0"},
			expected: map[string]interface{}{"executionOrder": "v0"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := workflowSettingsWithDefault(tt.input)
			if result["executionOrder"] != tt.expected["executionOrder"] {
				t.Errorf("executionOrder = %v, want %v", result["executionOrder"], tt.expected["executionOrder"])
			}
		})
	}
}

func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"simple-name", "simple-name"},
		{"name/with/slashes", "name-with-slashes"},
		{"name\\with\\backslashes", "name-with-backslashes"},
		{"name:with:colons", "name-with-colons"},
		{"mixed/path\\and:colon", "mixed-path-and-colon"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := sanitizeFilename(tt.input)
			if result != tt.expected {
				t.Errorf("sanitizeFilename(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestShellQuote(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"simple", "'simple'"},
		{"with'quote", "'with'\"'\"'quote'"},
		{"", "''"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := shellQuote(tt.input)
			if result != tt.expected {
				t.Errorf("shellQuote(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestHandleN8NResponse(t *testing.T) {
	t.Run("success response", func(t *testing.T) {
		body := []byte(`{"data": {"id": "1"}}`)
		result, err := handleN8NResponse(200, body)
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if string(result) != string(body) {
			t.Error("body should be returned unchanged")
		}
	})

	t.Run("error response with message", func(t *testing.T) {
		body := []byte(`{"message": "Workflow not found"}`)
		_, err := handleN8NResponse(404, body)
		if err == nil {
			t.Error("expected error for 404, got nil")
		}
	})

	t.Run("error response without message", func(t *testing.T) {
		body := []byte(`{}`)
		_, err := handleN8NResponse(500, body)
		if err == nil {
			t.Error("expected error for 500, got nil")
		}
	})

	t.Run("zero status code", func(t *testing.T) {
		body := []byte(`{}`)
		_, err := handleN8NResponse(0, body)
		if err == nil {
			t.Error("expected error for status 0, got nil")
		}
	})
}

func TestParseRemoteHTTPOutput(t *testing.T) {
	t.Run("valid output", func(t *testing.T) {
		output := "__SPOOL_HTTP_STATUS__:200\n__SPOOL_CURL_STATUS__:0\n__SPOOL_CURL_ERROR__:\n__SPOOL_BODY_BEGIN__\n{\"id\":\"123\"}"
		statusCode, curlCode, curlErr, body, err := parseRemoteHTTPOutput(output)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if statusCode != 200 {
			t.Errorf("statusCode = %d, want 200", statusCode)
		}
		if curlCode != 0 {
			t.Errorf("curlCode = %d, want 0", curlCode)
		}
		if curlErr != "" {
			t.Errorf("curlErr = %q, want empty", curlErr)
		}
		if string(body) != `{"id":"123"}` {
			t.Errorf("body = %q, want %q", string(body), `{"id":"123"}`)
		}
	})

	t.Run("missing body marker", func(t *testing.T) {
		output := "__SPOOL_HTTP_STATUS__:200\n__SPOOL_CURL_STATUS__:0"
		_, _, _, _, err := parseRemoteHTTPOutput(output)
		if err == nil {
			t.Error("expected error for missing body marker, got nil")
		}
	})

	t.Run("missing HTTP status", func(t *testing.T) {
		output := "__SPOOL_CURL_STATUS__:0\n__SPOOL_BODY_BEGIN__\n{}"
		_, _, _, _, err := parseRemoteHTTPOutput(output)
		if err == nil {
			t.Error("expected error for missing HTTP status, got nil")
		}
	})

	t.Run("missing curl status", func(t *testing.T) {
		output := "__SPOOL_HTTP_STATUS__:200\n__SPOOL_BODY_BEGIN__\n{}"
		_, _, _, _, err := parseRemoteHTTPOutput(output)
		if err == nil {
			t.Error("expected error for missing curl status, got nil")
		}
	})

	t.Run("invalid HTTP status", func(t *testing.T) {
		output := "__SPOOL_HTTP_STATUS__:abc\n__SPOOL_CURL_STATUS__:0\n__SPOOL_BODY_BEGIN__\n{}"
		_, _, _, _, err := parseRemoteHTTPOutput(output)
		if err == nil {
			t.Error("expected error for invalid HTTP status, got nil")
		}
	})

	t.Run("with curl error", func(t *testing.T) {
		output := "__SPOOL_HTTP_STATUS__:0\n__SPOOL_CURL_STATUS__:6\n__SPOOL_CURL_ERROR__:Could not resolve host\n__SPOOL_BODY_BEGIN__\n"
		statusCode, curlCode, curlErr, _, err := parseRemoteHTTPOutput(output)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if statusCode != 0 {
			t.Errorf("statusCode = %d, want 0", statusCode)
		}
		if curlCode != 6 {
			t.Errorf("curlCode = %d, want 6", curlCode)
		}
		if curlErr != "Could not resolve host" {
			t.Errorf("curlErr = %q, want %q", curlErr, "Could not resolve host")
		}
	})
}

func TestShouldUseRemoteAPI(t *testing.T) {
	tests := []struct {
		name     string
		baseURL  string
		hostConn string
		sshKey   string
		expected bool
	}{
		{"localhost with connection", "http://localhost:5678", "user@host", "/key", true},
		{"127.0.0.1 with connection", "http://127.0.0.1:5678", "user@host", "/key", true},
		{"::1 with connection", "http://[::1]:5678", "user@host", "/key", true},
		{"remote URL", "https://n8n.example.com", "user@host", "/key", false},
		{"no host connection", "http://localhost:5678", "", "/key", false},
		{"no ssh key", "http://localhost:5678", "user@host", "", false},
		{"invalid URL", "://invalid", "user@host", "/key", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &N8NClient{
				baseURL:  tt.baseURL,
				hostConn: tt.hostConn,
				sshKey:   tt.sshKey,
			}
			result := c.shouldUseRemoteAPI()
			if result != tt.expected {
				t.Errorf("shouldUseRemoteAPI() = %v, want %v", result, tt.expected)
			}
		})
	}
}

func TestWorkflowMatchesTargets(t *testing.T) {
	targets := map[string]struct{}{
		"target-workflow": {},
		"target-file":     {},
	}

	tests := []struct {
		name     string
		file     string
		wfName   string
		expected bool
	}{
		{"match by name", "/path/to/file.json", "target-workflow", true},
		{"match by filename", "/path/to/target-file.json", "other-name", true},
		{"match by file key", "/path/to/target-workflow.json", "other-name", true},
		{"no match", "/path/to/other.json", "other-name", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wf := &N8NWorkflow{Name: tt.wfName}
			result := workflowMatchesTargets(tt.file, wf, targets)
			if result != tt.expected {
				t.Errorf("workflowMatchesTargets() = %v, want %v", result, tt.expected)
			}
		})
	}
}
