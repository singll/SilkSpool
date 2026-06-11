package tools

import (
	"encoding/json"
	"net/url"
	"testing"
)

func TestFormatUptimeExtended(t *testing.T) {
	tests := []struct {
		seconds  int
		expected string
	}{
		{0, "0m"},
		{1, "0m"},
		{30, "0m"},
		{59, "0m"},
		{60, "1m"},
		{61, "1m"},
		{119, "1m"},
		{120, "2m"},
		{3599, "59m"},
		{3600, "1h 0m"},
		{3601, "1h 0m"},
		{3660, "1h 1m"},
		{3661, "1h 1m"},
		{7199, "1h 59m"},
		{7200, "2h 0m"},
		{86399, "23h 59m"},
		{86400, "1d 0h 0m"},
		{86401, "1d 0h 0m"},
		{90000, "1d 1h 0m"},
		{90061, "1d 1h 1m"},
		{172800, "2d 0h 0m"},
		{259200, "3d 0h 0m"},
		{864000, "10d 0h 0m"},
		{8640000, "100d 0h 0m"},
	}

	for _, tt := range tests {
		t.Run(tt.expected, func(t *testing.T) {
			result := formatUptime(tt.seconds)
			if result != tt.expected {
				t.Errorf("formatUptime(%d) = %q, want %q", tt.seconds, result, tt.expected)
			}
		})
	}
}

func TestFormatUptimeNegativeInput(t *testing.T) {
	result := formatUptime(-1)
	if result != "0m" {
		t.Errorf("formatUptime(-1) = %q, want %q (negative values treated as 0)", result, "0m")
	}
}

func TestRPCErrorExtended(t *testing.T) {
	tests := []struct {
		name     string
		err      *RPCError
		expected string
	}{
		{
			name:     "error with data",
			err:      &RPCError{Code: 1, Message: "test error", Data: "extra info"},
			expected: "test error (code=1)",
		},
		{
			name:     "error without data",
			err:      &RPCError{Code: 2, Message: "another error", Data: nil},
			expected: "another error (code=2)",
		},
		{
			name:     "error with empty message",
			err:      &RPCError{Code: 0, Message: "", Data: nil},
			expected: " (code=0)",
		},
		{
			name:     "error with struct data",
			err:      &RPCError{Code: 100, Message: "validation failed", Data: map[string]interface{}{"field": "name"}},
			expected: "validation failed (code=100)",
		},
		{
			name:     "error with large code",
			err:      &RPCError{Code: 99999, Message: "server error", Data: "details"},
			expected: "server error (code=99999)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.err.Error(); got != tt.expected {
				t.Errorf("Error() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestTrueNASJobStructExtended(t *testing.T) {
	tests := []struct {
		name string
		job  TrueNASJob
	}{
		{
			name: "successful job",
			job: TrueNASJob{
				ID:       123,
				State:    "SUCCESS",
				Progress: 100.0,
				Result:   json.RawMessage(`{"key": "value"}`),
			},
		},
		{
			name: "running job",
			job: TrueNASJob{
				ID:       456,
				State:    "RUNNING",
				Progress: 50.5,
			},
		},
		{
			name: "failed job",
			job: TrueNASJob{
				ID:    789,
				State: "FAILED",
				Error: "Something went wrong",
			},
		},
		{
			name: "aborted job",
			job: TrueNASJob{
				ID:    999,
				State: "ABORTED",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.job)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var parsed TrueNASJob
			if err := json.Unmarshal(data, &parsed); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if parsed.ID != tt.job.ID {
				t.Errorf("ID = %d, want %d", parsed.ID, tt.job.ID)
			}
			if parsed.State != tt.job.State {
				t.Errorf("State = %q, want %q", parsed.State, tt.job.State)
			}
		})
	}
}

func TestTrueNASSystemInfoExtended(t *testing.T) {
	info := TrueNASSystemInfo{
		Version:  "TrueNAS-13.0-U5.1",
		Hostname: "truenas.local",
		Uptime:   864000,
		Model:    "Dell PowerEdge R740",
		Serial:   "ABCD1234",
		MemTotal: 34359738368,
		MemFree:  17179869184,
		LoadAvg:  []float64{1.5, 1.2, 0.8},
	}

	data, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed TrueNASSystemInfo
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed.Version != info.Version {
		t.Errorf("Version = %q, want %q", parsed.Version, info.Version)
	}
	if parsed.Uptime != info.Uptime {
		t.Errorf("Uptime = %d, want %d", parsed.Uptime, info.Uptime)
	}
	if parsed.MemTotal != info.MemTotal {
		t.Errorf("MemTotal = %d, want %d", parsed.MemTotal, info.MemTotal)
	}
	if len(parsed.LoadAvg) != 3 {
		t.Errorf("LoadAvg length = %d, want 3", len(parsed.LoadAvg))
	}
}

func TestTrueNASPoolStructExtended(t *testing.T) {
	tests := []struct {
		name string
		pool TrueNASPool
	}{
		{
			name: "healthy pool",
			pool: TrueNASPool{
				ID: 1, Name: "tank", Status: "ONLINE",
				Size: 1000000000000, Free: 500000000000, Healthy: true,
			},
		},
		{
			name: "unhealthy pool",
			pool: TrueNASPool{
				ID: 2, Name: "backup", Status: "DEGRADED",
				Size: 2000000000000, Free: 1500000000000, Healthy: false,
			},
		},
		{
			name: "empty pool",
			pool: TrueNASPool{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.pool)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var parsed TrueNASPool
			if err := json.Unmarshal(data, &parsed); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if parsed.Name != tt.pool.Name {
				t.Errorf("Name = %q, want %q", parsed.Name, tt.pool.Name)
			}
			if parsed.Healthy != tt.pool.Healthy {
				t.Errorf("Healthy = %v, want %v", parsed.Healthy, tt.pool.Healthy)
			}
		})
	}
}

func TestTrueNASDatasetStructExtended(t *testing.T) {
	ds := TrueNASDataset{
		ID:         "tank/media",
		Name:       "tank/media",
		Pool:       "tank",
		Type:       "filesystem",
		UsedBytes:  500000000000,
		AvailBytes: 500000000000,
	}

	data, err := json.Marshal(ds)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed TrueNASDataset
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed.Pool != "tank" {
		t.Errorf("Pool = %q, want %q", parsed.Pool, "tank")
	}
	if parsed.Type != "filesystem" {
		t.Errorf("Type = %q, want %q", parsed.Type, "filesystem")
	}
}

func TestTrueNASSnapshotStructExtended(t *testing.T) {
	snap := TrueNASSnapshot{
		ID:        "tank/media@daily-20240101",
		Name:      "daily-20240101",
		Dataset:   "tank/media",
		UsedBytes: 1000000000,
		Created:   "2024-01-01T00:00:00",
	}

	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var parsed TrueNASSnapshot
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if parsed.Dataset != "tank/media" {
		t.Errorf("Dataset = %q, want %q", parsed.Dataset, "tank/media")
	}
	if parsed.Created != "2024-01-01T00:00:00" {
		t.Errorf("Created = %q, want %q", parsed.Created, "2024-01-01T00:00:00")
	}
}

func TestRPCRequestStructExtended(t *testing.T) {
	tests := []struct {
		name string
		req  rpcRequest
	}{
		{
			name: "system info request",
			req: rpcRequest{
				JSONRPC: "2.0",
				ID:      1,
				Method:  "system.info",
				Params:  []interface{}{},
			},
		},
		{
			name: "pool query with params",
			req: rpcRequest{
				JSONRPC: "2.0",
				ID:      2,
				Method:  "pool.query",
				Params:  []interface{}{map[string]interface{}{"id": 1}},
			},
		},
		{
			name: "auth request",
			req: rpcRequest{
				JSONRPC: "2.0",
				ID:      3,
				Method:  "auth.login_with_api_key",
				Params:  []interface{}{"my-api-key"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.req)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var parsed rpcRequest
			if err := json.Unmarshal(data, &parsed); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if parsed.JSONRPC != "2.0" {
				t.Errorf("JSONRPC = %q, want %q", parsed.JSONRPC, "2.0")
			}
			if parsed.Method != tt.req.Method {
				t.Errorf("Method = %q, want %q", parsed.Method, tt.req.Method)
			}
		})
	}
}

func TestRPCResponseStructExtended(t *testing.T) {
	tests := []struct {
		name string
		resp rpcResponse
	}{
		{
			name: "success response",
			resp: rpcResponse{
				ID:      1,
				JSONRPC: "2.0",
				Result:  json.RawMessage(`{"version": "13.0"}`),
				Error:   nil,
			},
		},
		{
			name: "error response",
			resp: rpcResponse{
				ID:      2,
				JSONRPC: "2.0",
				Result:  nil,
				Error:   &rpcError{Code: 1, Message: "test error"},
			},
		},
		{
			name: "response with error data",
			resp: rpcResponse{
				ID:      3,
				JSONRPC: "2.0",
				Result:  nil,
				Error:   &rpcError{Code: 2, Message: "validation error", Data: json.RawMessage(`{"field": "name"}`)},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.resp)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var parsed rpcResponse
			if err := json.Unmarshal(data, &parsed); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if parsed.ID != tt.resp.ID {
				t.Errorf("ID = %d, want %d", parsed.ID, tt.resp.ID)
			}
			if (parsed.Error == nil) != (tt.resp.Error == nil) {
				t.Errorf("Error nil mismatch: got %v, want %v", parsed.Error == nil, tt.resp.Error == nil)
			}
		})
	}
}

func TestTrueNASClientWebSocketURLConversion(t *testing.T) {
	tests := []struct {
		name     string
		apiURL   string
		wantWS   string
		wantErr  bool
	}{
		{"https to wss", "https://truenas.local/api/current", "wss://truenas.local/api/current", false},
		{"http to ws", "http://truenas.local/api/current", "ws://truenas.local/api/current", false},
		{"https with port", "https://truenas.local:443/api", "wss://truenas.local:443/api", false},
		{"invalid URL", "://invalid", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, err := url.Parse(tt.apiURL)
			if tt.wantErr {
				if err != nil {
					return
				}
			}
			if err != nil {
				if tt.wantErr {
					return
				}
				t.Fatalf("unexpected parse error: %v", err)
			}

			scheme := "wss"
			if u.Scheme == "http" {
				scheme = "ws"
			}
			wsPath := u.Path
			if wsPath == "" || wsPath == "/" {
				wsPath = "/api/current"
			}
			wsURL := scheme + "://" + u.Host + wsPath

			if wsURL != tt.wantWS {
				t.Errorf("wsURL = %q, want %q", wsURL, tt.wantWS)
			}
		})
	}
}

func TestTrueNASClientStructDefaults(t *testing.T) {
	c := &TrueNASClient{
		apiURL:   "https://truenas.local/api/current",
		username: "admin",
		apiKey:   "test-key",
		insecure: false,
		timeout:  30,
		nextID:   0,
	}

	if c.apiURL != "https://truenas.local/api/current" {
		t.Errorf("apiURL = %q", c.apiURL)
	}
	if c.insecure {
		t.Error("insecure should be false by default")
	}
	if c.nextID != 0 {
		t.Errorf("nextID = %d, want 0", c.nextID)
	}
	if c.conn != nil {
		t.Error("conn should be nil before Connect()")
	}
}

func TestTrueNASClientCallNotConnected(t *testing.T) {
	c := &TrueNASClient{}
	_, err := c.Call("system.info", []interface{}{})
	if err == nil {
		t.Error("expected error when calling on disconnected client")
	}
	if err.Error() != "not connected" {
		t.Errorf("error = %q, want %q", err.Error(), "not connected")
	}
}

func TestTrueNASClientNextIDIncrement(t *testing.T) {
	c := &TrueNASClient{}
	if c.nextID != 0 {
		t.Errorf("initial nextID = %d, want 0", c.nextID)
	}
	c.nextID++
	if c.nextID != 1 {
		t.Errorf("nextID after increment = %d, want 1", c.nextID)
	}
	c.nextID++
	if c.nextID != 2 {
		t.Errorf("nextID after second increment = %d, want 2", c.nextID)
	}
}

func TestTrueNASManagerCloseNil(t *testing.T) {
	m := &TrueNASManager{client: nil}
	if err := m.Close(); err != nil {
		t.Errorf("Close with nil client should not error, got %v", err)
	}
}

func TestTrueNASClientCloseNilConn(t *testing.T) {
	c := &TrueNASClient{conn: nil}
	if err := c.Close(); err != nil {
		t.Errorf("Close with nil conn should not error, got %v", err)
	}
}

func TestRPCErrorImplementsError(t *testing.T) {
	var err error = &RPCError{Code: 1, Message: "test"}
	if err.Error() != "test (code=1)" {
		t.Errorf("Error() = %q, want %q", err.Error(), "test (code=1)")
	}
}
