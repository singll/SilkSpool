package tools

import (
	"encoding/json"
	"testing"
)

func TestRPCError(t *testing.T) {
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
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.err.Error(); got != tt.expected {
				t.Errorf("Error() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestTrueNASJobStruct(t *testing.T) {
	job := TrueNASJob{
		ID:       123,
		State:    "SUCCESS",
		Progress: 100.0,
		Result:   json.RawMessage(`{"key": "value"}`),
	}

	data, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("failed to marshal job: %v", err)
	}

	var parsed TrueNASJob
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal job: %v", err)
	}

	if parsed.ID != 123 {
		t.Errorf("ID = %d, want 123", parsed.ID)
	}
	if parsed.State != "SUCCESS" {
		t.Errorf("State = %q, want %q", parsed.State, "SUCCESS")
	}
}

func TestTrueNASSystemInfoStruct(t *testing.T) {
	info := TrueNASSystemInfo{
		Version:  "TrueNAS-13.0-U5",
		Hostname: "truenas.local",
		Uptime:   123456,
		Model:    "Generic",
		Serial:   "ABC123",
		MemTotal: 17179869184,
		MemFree:  8589934592,
		LoadAvg:  []float64{0.5, 0.3, 0.1},
	}

	data, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("failed to marshal system info: %v", err)
	}

	var parsed TrueNASSystemInfo
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal system info: %v", err)
	}

	if parsed.Version != "TrueNAS-13.0-U5" {
		t.Errorf("Version = %q, want %q", parsed.Version, "TrueNAS-13.0-U5")
	}
	if len(parsed.LoadAvg) != 3 {
		t.Errorf("LoadAvg length = %d, want 3", len(parsed.LoadAvg))
	}
}

func TestTrueNASPoolStruct(t *testing.T) {
	pool := TrueNASPool{
		ID:      1,
		Name:    "tank",
		Status:  "ONLINE",
		Size:    1000000000000,
		Free:    500000000000,
		Healthy: true,
	}

	data, err := json.Marshal(pool)
	if err != nil {
		t.Fatalf("failed to marshal pool: %v", err)
	}

	var parsed TrueNASPool
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal pool: %v", err)
	}

	if parsed.Name != "tank" {
		t.Errorf("Name = %q, want %q", parsed.Name, "tank")
	}
	if !parsed.Healthy {
		t.Error("Healthy should be true")
	}
}

func TestTrueNASDatasetStruct(t *testing.T) {
	ds := TrueNASDataset{
		ID:         "tank/dataset",
		Name:       "tank/dataset",
		Pool:       "tank",
		Type:       "filesystem",
		UsedBytes:  1000000000,
		AvailBytes: 500000000000,
	}

	data, err := json.Marshal(ds)
	if err != nil {
		t.Fatalf("failed to marshal dataset: %v", err)
	}

	var parsed TrueNASDataset
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal dataset: %v", err)
	}

	if parsed.Pool != "tank" {
		t.Errorf("Pool = %q, want %q", parsed.Pool, "tank")
	}
}

func TestTrueNASSnapshotStruct(t *testing.T) {
	snap := TrueNASSnapshot{
		ID:        "tank/dataset@snap1",
		Name:      "snap1",
		Dataset:   "tank/dataset",
		UsedBytes: 1000000,
		Created:   "2024-01-01T00:00:00",
	}

	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("failed to marshal snapshot: %v", err)
	}

	var parsed TrueNASSnapshot
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal snapshot: %v", err)
	}

	if snap.Name != "snap1" {
		t.Errorf("Name = %q, want %q", snap.Name, "snap1")
	}
}

func TestFormatUptime(t *testing.T) {
	tests := []struct {
		seconds  int
		expected string
	}{
		{0, "0m"},
		{59, "0m"},
		{60, "1m"},
		{3600, "1h 0m"},
		{3661, "1h 1m"},
		{86400, "1d 0h 0m"},
		{90061, "1d 1h 1m"},
		{172800, "2d 0h 0m"},
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

func TestRPCRequestStruct(t *testing.T) {
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "system.info",
		Params:  []interface{}{},
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}

	var parsed rpcRequest
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal request: %v", err)
	}

	if parsed.JSONRPC != "2.0" {
		t.Errorf("JSONRPC = %q, want %q", parsed.JSONRPC, "2.0")
	}
	if parsed.Method != "system.info" {
		t.Errorf("Method = %q, want %q", parsed.Method, "system.info")
	}
}

func TestRPCResponseStruct(t *testing.T) {
	resp := rpcResponse{
		ID:      1,
		JSONRPC: "2.0",
		Result:  json.RawMessage(`{"version": "13.0"}`),
		Error:   nil,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal response: %v", err)
	}

	var parsed rpcResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if parsed.ID != 1 {
		t.Errorf("ID = %d, want 1", parsed.ID)
	}
	if parsed.Error != nil {
		t.Error("Error should be nil")
	}
}

func TestRPCResponseWithError(t *testing.T) {
	resp := rpcResponse{
		ID:      1,
		JSONRPC: "2.0",
		Result:  nil,
		Error:   &rpcError{Code: 1, Message: "test error"},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("failed to marshal response: %v", err)
	}

	var parsed rpcResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if parsed.Error == nil {
		t.Fatal("Error should not be nil")
	}
	if parsed.Error.Code != 1 {
		t.Errorf("Error.Code = %d, want 1", parsed.Error.Code)
	}
	if parsed.Error.Message != "test error" {
		t.Errorf("Error.Message = %q, want %q", parsed.Error.Message, "test error")
	}
}
