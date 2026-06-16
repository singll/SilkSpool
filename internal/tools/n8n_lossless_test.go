package tools

import (
	"encoding/json"
	"testing"
)

// TestN8NNodePreservesUnknownFields 锁定回归：节点级未知字段经 round-trip 必须原样保留。
// 历史 bug：N8NNode 未建模 webhookId/onError，update/export 时被静默丢弃，
// 导致线上 webhook 的 webhookId 变 null，n8n 退化注册到 {workflowId}/webhook/{path} 畸形路径。
func TestN8NNodePreservesUnknownFields(t *testing.T) {
	raw := `{
		"id": "webhook-trigger",
		"name": "Webhook",
		"type": "n8n-nodes-base.webhook",
		"typeVersion": 2,
		"position": [0, 300],
		"webhookId": "article-ingest",
		"parameters": {"path": "article-ingest", "httpMethod": "POST"},
		"onError": "continueErrorOutput",
		"disabled": true,
		"notes": "keep me"
	}`

	var n N8NNode
	if err := json.Unmarshal([]byte(raw), &n); err != nil {
		t.Fatalf("unmarshal node: %v", err)
	}

	// 显式字段仍正确解析
	if n.Type != "n8n-nodes-base.webhook" {
		t.Errorf("Type = %q, want n8n-nodes-base.webhook", n.Type)
	}
	if n.Parameters["path"] != "article-ingest" {
		t.Errorf("Parameters[path] = %v, want article-ingest", n.Parameters["path"])
	}

	out, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("marshal node: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("re-unmarshal: %v", err)
	}

	// 未知字段必须原样保留
	if m["webhookId"] != "article-ingest" {
		t.Errorf("webhookId lost/altered: got %v, want article-ingest", m["webhookId"])
	}
	if m["onError"] != "continueErrorOutput" {
		t.Errorf("onError lost/altered: got %v, want continueErrorOutput", m["onError"])
	}
	if m["disabled"] != true {
		t.Errorf("disabled lost/altered: got %v, want true", m["disabled"])
	}
	if m["notes"] != "keep me" {
		t.Errorf("notes lost/altered: got %v, want 'keep me'", m["notes"])
	}
}

// TestUpdatePayloadPreservesWebhookID 锁定回归：spool n8n update 实际发往 n8n 的 payload
// （经 cleanWorkflowForUpdate）必须保留 webhook 节点的 webhookId。
func TestUpdatePayloadPreservesWebhookID(t *testing.T) {
	raw := `{
		"name": "K01-test",
		"nodes": [{
			"id": "webhook-trigger",
			"name": "Webhook",
			"type": "n8n-nodes-base.webhook",
			"typeVersion": 2,
			"position": [0, 300],
			"webhookId": "article-ingest",
			"parameters": {"path": "article-ingest"}
		}],
		"connections": {},
		"settings": {"executionOrder": "v1"}
	}`

	var wf N8NWorkflow
	if err := json.Unmarshal([]byte(raw), &wf); err != nil {
		t.Fatalf("unmarshal workflow: %v", err)
	}

	clean := cleanWorkflowForUpdate(&wf)
	out, err := json.Marshal(clean)
	if err != nil {
		t.Fatalf("marshal clean workflow: %v", err)
	}

	var parsed struct {
		Nodes []map[string]interface{} `json:"nodes"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("re-unmarshal payload: %v", err)
	}
	if len(parsed.Nodes) != 1 {
		t.Fatalf("nodes count = %d, want 1", len(parsed.Nodes))
	}
	if parsed.Nodes[0]["webhookId"] != "article-ingest" {
		t.Errorf("update payload dropped webhookId: got %v, want article-ingest", parsed.Nodes[0]["webhookId"])
	}
}
