package tools

import (
	"encoding/json"
	"testing"
)

func TestTrueNASClientStructAllFields(t *testing.T) {
	c := &TrueNASClient{
		apiURL:   "https://truenas.local/api/current",
		username: "admin",
		apiKey:   "my-api-key",
		insecure: false,
		timeout:  30,
		nextID:   5,
	}
	if c.apiURL != "https://truenas.local/api/current" {
		t.Errorf("apiURL = %q", c.apiURL)
	}
	if c.username != "admin" {
		t.Errorf("username = %q", c.username)
	}
	if c.apiKey != "my-api-key" {
		t.Errorf("apiKey = %q", c.apiKey)
	}
	if c.nextID != 5 {
		t.Errorf("nextID = %d, want 5", c.nextID)
	}
}

func TestFormatUptimeBoundaryValues(t *testing.T) {
	tests := []struct {
		seconds  int
		expected string
	}{
		{0, "0m"},
		{59, "0m"},
		{60, "1m"},
		{3599, "59m"},
		{3600, "1h 0m"},
		{86399, "23h 59m"},
		{86400, "1d 0h 0m"},
		{86400 * 365, "365d 0h 0m"},
	}
	for _, tt := range tests {
		result := formatUptime(tt.seconds)
		if result != tt.expected {
			t.Errorf("formatUptime(%d) = %q, want %q", tt.seconds, result, tt.expected)
		}
	}
}

func TestRPCErrorImplementsError2(t *testing.T) {
	var err error = &RPCError{Code: 42, Message: "test"}
	if err.Error() != "test (code=42)" {
		t.Errorf("Error() = %q", err.Error())
	}
}

func TestTrueNASJobJSONRoundTrip(t *testing.T) {
	job := TrueNASJob{
		ID:       999,
		State:    "RUNNING",
		Progress: 75.5,
		Result:   json.RawMessage(`{"status": "ok"}`),
	}
	data, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	var parsed TrueNASJob
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.ID != 999 {
		t.Errorf("ID = %d, want 999", parsed.ID)
	}
	if parsed.Progress != 75.5 {
		t.Errorf("Progress = %v, want 75.5", parsed.Progress)
	}
}

func TestTrueNASPoolZeroValues(t *testing.T) {
	pool := TrueNASPool{}
	data, err := json.Marshal(pool)
	if err != nil {
		t.Fatal(err)
	}
	var parsed TrueNASPool
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Healthy {
		t.Error("Healthy default should be false")
	}
}

func TestTrueNASDatasetJSONRoundTrip(t *testing.T) {
	ds := TrueNASDataset{
		ID:         "tank/media",
		Name:       "tank/media",
		Pool:       "tank",
		Type:       "filesystem",
		UsedBytes:  1000,
		AvailBytes: 2000,
	}
	data, err := json.Marshal(ds)
	if err != nil {
		t.Fatal(err)
	}
	var parsed TrueNASDataset
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.UsedBytes != 1000 {
		t.Errorf("UsedBytes = %d, want 1000", parsed.UsedBytes)
	}
}

func TestRPCRequestJSONFormat(t *testing.T) {
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "pool.query",
		Params:  []interface{}{},
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if m["jsonrpc"] != "2.0" {
		t.Errorf("jsonrpc = %v", m["jsonrpc"])
	}
	if m["method"] != "pool.query" {
		t.Errorf("method = %v", m["method"])
	}
}

func TestRPCResponseWithNilError(t *testing.T) {
	resp := rpcResponse{
		ID:      1,
		JSONRPC: "2.0",
		Result:  json.RawMessage(`{"ok": true}`),
		Error:   nil,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var parsed rpcResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Error != nil {
		t.Error("Error should be nil")
	}
}

func TestTrueNASSnapshotJSONRoundTrip(t *testing.T) {
	snap := TrueNASSnapshot{
		ID:        "tank/data@snap1",
		Name:      "snap1",
		Dataset:   "tank/data",
		UsedBytes: 500,
		Created:   "2024-06-01T00:00:00",
	}
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	var parsed TrueNASSnapshot
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Created != "2024-06-01T00:00:00" {
		t.Errorf("Created = %q", parsed.Created)
	}
}

func TestTrueNASClientCloseNil(t *testing.T) {
	c := &TrueNASClient{conn: nil}
	if err := c.Close(); err != nil {
		t.Errorf("Close with nil conn should not error: %v", err)
	}
}

func TestTrueNASManagerCloseNilClient(t *testing.T) {
	m := &TrueNASManager{client: nil}
	if err := m.Close(); err != nil {
		t.Errorf("Close with nil client should not error: %v", err)
	}
}

func TestTrueNASClientCallNotConnected2(t *testing.T) {
	c := &TrueNASClient{conn: nil}
	_, err := c.Call("system.info", nil)
	if err == nil {
		t.Error("expected error when not connected")
	}
}
