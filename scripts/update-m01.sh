#!/bin/bash
# Update M01 workflow in n8n

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load config
source "$PROJECT_ROOT/hosts/keeper/.env"

# Get M01 workflow ID
WORKFLOW_ID=$(curl -s "http://localhost:5678/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | \
  grep -o '"id":"[^"]*","name":"M01-Matrix[^"]*"' | \
  sed 's/"id":"\([^"]*\)".*/\1/')

if [ -z "$WORKFLOW_ID" ]; then
  echo "Error: M01 workflow not found in n8n"
  exit 1
fi

echo "Found M01 workflow ID: $WORKFLOW_ID"

# Update workflow
curl -s -X PUT "http://localhost:5678/api/v1/workflows/$WORKFLOW_ID" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @"$PROJECT_ROOT/hosts/keeper/n8n-workflows/M01-matrix-bot-base.json" | \
  grep -q '"id"' && echo "✅ M01 workflow updated successfully" || echo "❌ Failed to update M01"