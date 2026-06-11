package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkflowMatchesTargetsExtended(t *testing.T) {
	tests := []struct {
		name    string
		file    string
		wfName  string
		targets map[string]struct{}
		want    bool
	}{
		{
			name:   "match by workflow name",
			file:   "/path/to/K01-rss.json",
			wfName: "K01-RSS采集",
			targets: map[string]struct{}{
				"K01-RSS采集": {},
			},
			want: true,
		},
		{
			name:   "match by full filename",
			file:   "/path/to/K01-rss.json",
			wfName: "other",
			targets: map[string]struct{}{
				"K01-rss.json": {},
			},
			want: true,
		},
		{
			name:   "match by filename without extension",
			file:   "/path/to/K01-rss.json",
			wfName: "other",
			targets: map[string]struct{}{
				"K01-rss": {},
			},
			want: true,
		},
		{
			name:   "no match at all",
			file:   "/path/to/K01-rss.json",
			wfName: "other",
			targets: map[string]struct{}{
				"B01-notify": {},
			},
			want: false,
		},
		{
			name:   "empty targets should not match",
			file:   "/path/to/K01-rss.json",
			wfName: "K01-RSS采集",
			targets: map[string]struct{}{},
			want:    false,
		},
		{
			name:   "match when multiple targets exist",
			file:   "/path/to/K01-rss.json",
			wfName: "K01-RSS采集",
			targets: map[string]struct{}{
				"B01-notify": {},
				"K01-RSS采集": {},
			},
			want: true,
		},
		{
			name:   "match by filename key with nested path",
			file:   "/deep/nested/path/B01-notify.json",
			wfName: "B01-通知服务",
			targets: map[string]struct{}{
				"B01-notify": {},
			},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wf := &N8NWorkflow{Name: tt.wfName}
			got := workflowMatchesTargets(tt.file, wf, tt.targets)
			if got != tt.want {
				t.Errorf("workflowMatchesTargets() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSanitizeFilenameExtended(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"simple-name", "simple-name"},
		{"name/with/slashes", "name-with-slashes"},
		{"name\\with\\backslashes", "name-with-backslashes"},
		{"name:with:colons", "name-with-colons"},
		{"mixed/path\\and:colon", "mixed-path-and-colon"},
		{"", ""},
		{"no-special-chars", "no-special-chars"},
		{"multiple///slashes", "multiple---slashes"},
		{"\\:/:\\:", "------"},
		{"K01-RSS采集", "K01-RSS采集"},
		{"workflow (copy)", "workflow (copy)"},
		{"name with spaces", "name with spaces"},
		{"/leading/slash", "-leading-slash"},
		{"trailing/slash/", "trailing-slash-"},
		{strings.Repeat("a", 200), strings.Repeat("a", 200)},
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

func TestShellQuoteExtended(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"simple", "'simple'"},
		{"with'quote", "'with'\"'\"'quote'"},
		{"", "''"},
		{"with spaces", "'with spaces'"},
		{"with$var", "'with$var'"},
		{"with`backtick", "'with`backtick'"},
		{"with\"double", "'with\"double'"},
		{"multiple''quotes", "'multiple'\"'\"''\"'\"'quotes'"},
		{"a'b'c", "'a'\"'\"'b'\"'\"'c'"},
		{"newline\nhere", "'newline\nhere'"},
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

func TestHandleN8NResponseExtended(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		wantErr    bool
		errMsg     string
	}{
		{"200 OK", 200, `{"data": "test"}`, false, ""},
		{"201 Created", 201, `{"id": "123"}`, false, ""},
		{"204 No Content", 204, ``, false, ""},
		{"301 Moved", 301, `{}`, false, ""},
		{"400 Bad Request with message", 400, `{"message": "Invalid input"}`, true, "Invalid input"},
		{"401 Unauthorized", 401, `{"message": "Unauthorized"}`, true, "Unauthorized"},
		{"403 Forbidden", 403, `{"message": "Forbidden"}`, true, "Forbidden"},
		{"404 Not Found", 404, `{"message": "Not found"}`, true, "Not found"},
		{"500 Internal Server Error", 500, `Internal Server Error`, true, "Internal Server Error"},
		{"zero status code", 0, `{}`, true, "API error"},
		{"399 below threshold", 399, `{"data": "ok"}`, false, ""},
		{"400 empty JSON", 400, `{}`, true, "API error: 400"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := handleN8NResponse(tt.statusCode, []byte(tt.body))
			if tt.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				}
				if tt.errMsg != "" && !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("error = %q, want to contain %q", err.Error(), tt.errMsg)
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
				if result == nil {
					t.Error("result should not be nil for success")
				}
			}
		})
	}
}

func TestShouldUseRemoteAPIExtended(t *testing.T) {
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
		{"empty URL", "", "user@host", "/key", false},
		{"HTTPS localhost", "https://localhost:5678", "user@host", "/key", true},
		{"0.0.0.0 is not localhost", "http://0.0.0.0:5678", "user@host", "/key", false},
		{"remote IP", "http://192.168.1.100:5678", "user@host", "/key", false},
		{"localhost without port", "http://localhost", "user@host", "/key", true},
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

func TestParseRemoteHTTPOutputExtended(t *testing.T) {
	tests := []struct {
		name           string
		output         string
		wantStatusCode int
		wantCurlCode   int
		wantCurlErr    string
		wantBody       string
		wantErr        bool
	}{
		{
			name:           "valid 200 response",
			output:         "__SPOOL_HTTP_STATUS__:200\n__SPOOL_CURL_STATUS__:0\n__SPOOL_CURL_ERROR__:\n__SPOOL_BODY_BEGIN__\n{\"id\":\"123\"}",
			wantStatusCode: 200,
			wantCurlCode:   0,
			wantCurlErr:    "",
			wantBody:       `{"id":"123"}`,
			wantErr:        false,
		},
		{
			name:           "valid 201 response",
			output:         "__SPOOL_HTTP_STATUS__:201\n__SPOOL_CURL_STATUS__:0\n__SPOOL_CURL_ERROR__:\n__SPOOL_BODY_BEGIN__\ncreated",
			wantStatusCode: 201,
			wantCurlCode:   0,
			wantBody:       "created",
			wantErr:        false,
		},
		{
			name:    "missing body marker",
			output:  "__SPOOL_HTTP_STATUS__:200\n__SPOOL_CURL_STATUS__:0",
			wantErr: true,
		},
		{
			name:    "missing HTTP status",
			output:  "__SPOOL_CURL_STATUS__:0\n__SPOOL_BODY_BEGIN__\n{}",
			wantErr: true,
		},
		{
			name:    "missing curl status",
			output:  "__SPOOL_HTTP_STATUS__:200\n__SPOOL_BODY_BEGIN__\n{}",
			wantErr: true,
		},
		{
			name:    "invalid HTTP status",
			output:  "__SPOOL_HTTP_STATUS__:abc\n__SPOOL_CURL_STATUS__:0\n__SPOOL_BODY_BEGIN__\n{}",
			wantErr: true,
		},
		{
			name:    "invalid curl status",
			output:  "__SPOOL_HTTP_STATUS__:200\n__SPOOL_CURL_STATUS__:abc\n__SPOOL_BODY_BEGIN__\n{}",
			wantErr: true,
		},
		{
			name:           "with curl error",
			output:         "__SPOOL_HTTP_STATUS__:0\n__SPOOL_CURL_STATUS__:6\n__SPOOL_CURL_ERROR__:Could not resolve host\n__SPOOL_BODY_BEGIN__\n",
			wantStatusCode: 0,
			wantCurlCode:   6,
			wantCurlErr:    "Could not resolve host",
			wantErr:        false,
		},
		{
			name:           "empty body",
			output:         "__SPOOL_HTTP_STATUS__:204\n__SPOOL_CURL_STATUS__:0\n__SPOOL_CURL_ERROR__:\n__SPOOL_BODY_BEGIN__\n",
			wantStatusCode: 204,
			wantCurlCode:   0,
			wantBody:       "",
			wantErr:        false,
		},
		{
			name:           "body with newlines",
			output:         "__SPOOL_HTTP_STATUS__:200\n__SPOOL_CURL_STATUS__:0\n__SPOOL_CURL_ERROR__:\n__SPOOL_BODY_BEGIN__\n{\"key\": \"value\"}\nextra line",
			wantStatusCode: 200,
			wantCurlCode:   0,
			wantBody:       "{\"key\": \"value\"}\nextra line",
			wantErr:        false,
		},
		{
			name:           "empty HTTP status value defaults to 0",
			output:         "__SPOOL_HTTP_STATUS__:\n__SPOOL_CURL_STATUS__:0\n__SPOOL_CURL_ERROR__:\n__SPOOL_BODY_BEGIN__\n",
			wantStatusCode: 0,
			wantCurlCode:   0,
			wantErr:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			statusCode, curlCode, curlErr, body, err := parseRemoteHTTPOutput(tt.output)
			if tt.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if statusCode != tt.wantStatusCode {
				t.Errorf("statusCode = %d, want %d", statusCode, tt.wantStatusCode)
			}
			if curlCode != tt.wantCurlCode {
				t.Errorf("curlCode = %d, want %d", curlCode, tt.wantCurlCode)
			}
			if curlErr != tt.wantCurlErr {
				t.Errorf("curlErr = %q, want %q", curlErr, tt.wantCurlErr)
			}
			if string(body) != tt.wantBody {
				t.Errorf("body = %q, want %q", string(body), tt.wantBody)
			}
		})
	}
}

func TestCleanWorkflowForCreateExtended(t *testing.T) {
	tests := []struct {
		name     string
		input    *N8NWorkflow
		wantName string
		wantID   string
		wantLen  int
	}{
		{
			name: "full workflow",
			input: &N8NWorkflow{
				ID:          "123",
				Name:        "test-wf",
				Active:      true,
				Nodes:       []N8NNode{{ID: "n1", Name: "Start", Type: "start", Position: []int{0, 0}}},
				Connections: map[string]interface{}{"c1": "d1"},
				Settings:    map[string]interface{}{"saveManualExecutions": true},
			},
			wantName: "test-wf",
			wantID:   "",
			wantLen:  1,
		},
		{
			name: "minimal workflow",
			input: &N8NWorkflow{
				Name:  "minimal",
				Nodes: []N8NNode{},
			},
			wantName: "minimal",
			wantID:   "",
			wantLen:  0,
		},
		{
			name: "workflow with nil settings",
			input: &N8NWorkflow{
				Name:     "nil-settings",
				Settings: nil,
			},
			wantName: "nil-settings",
			wantID:   "",
			wantLen:  0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clean := cleanWorkflowForCreate(tt.input)
			if clean.ID != tt.wantID {
				t.Errorf("ID = %q, want %q", clean.ID, tt.wantID)
			}
			if clean.Name != tt.wantName {
				t.Errorf("Name = %q, want %q", clean.Name, tt.wantName)
			}
			if clean.Active {
				t.Error("Active should be false in cleaned workflow")
			}
			if len(clean.Nodes) != tt.wantLen {
				t.Errorf("Nodes length = %d, want %d", len(clean.Nodes), tt.wantLen)
			}
			if _, ok := clean.Settings["executionOrder"]; !ok {
				t.Error("executionOrder should be set in settings")
			}
		})
	}
}

func TestCleanWorkflowForUpdateExtended(t *testing.T) {
	wf := &N8NWorkflow{
		ID:     "should-be-removed",
		Name:   "update-test",
		Active: true,
		Nodes:  []N8NNode{{ID: "n1", Name: "Start", Type: "start", Position: []int{0, 0}}},
		Settings: map[string]interface{}{
			"executionOrder": "v0",
		},
	}

	clean := cleanWorkflowForUpdate(wf)
	if clean.ID != "" {
		t.Errorf("ID should be empty, got %q", clean.ID)
	}
	if clean.Name != "update-test" {
		t.Errorf("Name = %q, want %q", clean.Name, "update-test")
	}
	if clean.Settings["executionOrder"] != "v0" {
		t.Errorf("executionOrder should be preserved as v0, got %v", clean.Settings["executionOrder"])
	}
}

func TestWorkflowSettingsWithDefaultExtended(t *testing.T) {
	tests := []struct {
		name            string
		input           map[string]interface{}
		wantExecOrder   string
		wantPreserved   map[string]interface{}
	}{
		{
			name:          "nil settings gets default",
			input:         nil,
			wantExecOrder: "v1",
		},
		{
			name:          "empty settings gets default",
			input:         map[string]interface{}{},
			wantExecOrder: "v1",
		},
		{
			name:          "settings without executionOrder gets default",
			input:         map[string]interface{}{"saveManualExecutions": true},
			wantExecOrder: "v1",
			wantPreserved: map[string]interface{}{"saveManualExecutions": true},
		},
		{
			name:          "settings with executionOrder preserves it",
			input:         map[string]interface{}{"executionOrder": "v0"},
			wantExecOrder: "v0",
		},
		{
			name:          "settings with multiple keys",
			input:         map[string]interface{}{"key1": "val1", "key2": 42},
			wantExecOrder: "v1",
			wantPreserved: map[string]interface{}{"key1": "val1", "key2": 42},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := workflowSettingsWithDefault(tt.input)
			if result["executionOrder"] != tt.wantExecOrder {
				t.Errorf("executionOrder = %v, want %v", result["executionOrder"], tt.wantExecOrder)
			}
			for k, v := range tt.wantPreserved {
				if result[k] != v {
					t.Errorf("result[%q] = %v, want %v", k, result[k], v)
				}
			}
		})
	}
}

func TestLoadWorkflowFromFileExtended(t *testing.T) {
	dir := t.TempDir()

	t.Run("workflow with nodes and connections", func(t *testing.T) {
		wf := N8NWorkflow{
			Name:   "full-workflow",
			Active: true,
			Nodes: []N8NNode{
				{ID: "n1", Name: "Webhook", Type: "n8n-nodes-base.webhook", Position: []int{0, 0}},
				{ID: "n2", Name: "HTTP", Type: "n8n-nodes-base.httpRequest", Position: []int{200, 0}},
			},
			Connections: map[string]interface{}{
				"Webhook": map[string]interface{}{
					"main": []interface{}{
						[]interface{}{map[string]interface{}{"node": "HTTP", "type": "main", "index": 0}},
					},
				},
			},
		}
		data, _ := json.MarshalIndent(wf, "", "  ")
		path := filepath.Join(dir, "full-workflow.json")
		if err := os.WriteFile(path, data, 0644); err != nil {
			t.Fatal(err)
		}

		loaded, err := LoadWorkflowFromFile(path)
		if err != nil {
			t.Fatalf("LoadWorkflowFromFile: %v", err)
		}
		if loaded.Name != "full-workflow" {
			t.Errorf("Name = %q, want %q", loaded.Name, "full-workflow")
		}
		if len(loaded.Nodes) != 2 {
			t.Errorf("Nodes count = %d, want 2", len(loaded.Nodes))
		}
		if len(loaded.Connections) != 1 {
			t.Errorf("Connections count = %d, want 1", len(loaded.Connections))
		}
	})

	t.Run("empty workflow JSON", func(t *testing.T) {
		path := filepath.Join(dir, "empty.json")
		if err := os.WriteFile(path, []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}

		loaded, err := LoadWorkflowFromFile(path)
		if err != nil {
			t.Fatalf("LoadWorkflowFromFile: %v", err)
		}
		if loaded.Name != "empty" {
			t.Errorf("Name = %q, want %q (derived from filename)", loaded.Name, "empty")
		}
	})

	t.Run("workflow with unicode name", func(t *testing.T) {
		data := `{"name": "K02-RSS定时采集", "nodes": []}`
		path := filepath.Join(dir, "K02-rss-timer.json")
		if err := os.WriteFile(path, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}

		loaded, err := LoadWorkflowFromFile(path)
		if err != nil {
			t.Fatalf("LoadWorkflowFromFile: %v", err)
		}
		if loaded.Name != "K02-RSS定时采集" {
			t.Errorf("Name = %q, want %q", loaded.Name, "K02-RSS定时采集")
		}
	})
}

func TestN8NWorkflowJSONRoundTrip(t *testing.T) {
	original := N8NWorkflow{
		Name:   "round-trip-test",
		Active: true,
		Nodes: []N8NNode{
			{
				ID:          "node-1",
				Name:        "Webhook",
				Type:        "n8n-nodes-base.webhook",
				TypeVersion: 1.5,
				Position:    []int{100, 200},
				Parameters:  map[string]interface{}{"path": "/test", "method": "POST"},
				Credentials: map[string]interface{}{"httpBasicAuth": map[string]interface{}{"id": "1", "name": "Test Auth"}},
			},
		},
		Connections: map[string]interface{}{
			"Webhook": map[string]interface{}{
				"main": []interface{}{},
			},
		},
		Settings: map[string]interface{}{
			"executionOrder":     "v1",
			"saveManualExecutions": true,
		},
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed N8NWorkflow
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed.Name != original.Name {
		t.Errorf("Name = %q, want %q", parsed.Name, original.Name)
	}
	if parsed.Active != original.Active {
		t.Errorf("Active = %v, want %v", parsed.Active, original.Active)
	}
	if len(parsed.Nodes) != len(original.Nodes) {
		t.Errorf("Nodes count = %d, want %d", len(parsed.Nodes), len(original.Nodes))
	}
	if parsed.Nodes[0].TypeVersion != 1.5 {
		t.Errorf("TypeVersion = %v, want 1.5", parsed.Nodes[0].TypeVersion)
	}
}

func TestN8NClientStructDefaults(t *testing.T) {
	c := &N8NClient{
		baseURL:  "http://localhost:5678",
		apiKey:   "test-key",
		hostConn: "user@host",
		sshKey:   "/path/to/key",
	}

	if c.baseURL != "http://localhost:5678" {
		t.Errorf("baseURL = %q", c.baseURL)
	}
	if c.apiKey != "test-key" {
		t.Errorf("apiKey = %q", c.apiKey)
	}
	if c.httpClient != nil {
		t.Error("httpClient should be nil when not initialized")
	}
}

func TestN8NManagerClose(t *testing.T) {
	mgr := &N8NManager{}
	if err := mgr.Close(); err != nil {
		t.Errorf("Close should return nil, got %v", err)
	}
}

func TestN8NNodeWithData(t *testing.T) {
	node := N8NNode{
		ID:       "test",
		Name:     "Test Node",
		Type:     "n8n-nodes-base.test",
		Position: []int{0, 0},
		Data:     map[string]interface{}{"key": "value"},
		Parameters: map[string]interface{}{
			"url":    "https://example.com",
			"method": "GET",
			"headers": map[string]interface{}{
				"Authorization": "Bearer token",
			},
		},
	}

	data, err := json.Marshal(node)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed N8NNode
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed.Data["key"] != "value" {
		t.Errorf("Data[key] = %v, want value", parsed.Data["key"])
	}
	if parsed.Parameters["method"] != "GET" {
		t.Errorf("Parameters[method] = %v, want GET", parsed.Parameters["method"])
	}
}
