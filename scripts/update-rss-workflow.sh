#!/bin/bash
# Update RSS workflow via n8n API

set -e

WORKFLOW_ID="F5xtnmMxDWgh9pxM"
WORKFLOW_FILE="/home/ubuntu/SilkSpool/hosts/keeper/n8n-workflows/04-rss-fetch.json"

# Extract only the fields needed for update (name, nodes, connections, settings)
PAYLOAD=$(jq '{name, nodes, connections, settings}' "$WORKFLOW_FILE")

# Get n8n API key from keeper .env
N8N_API_KEY=$(grep '^N8N_API_KEY=' /home/ubuntu/SilkSpool/hosts/keeper/.env | cut -d'=' -f2-)

# Update workflow via API
echo "Updating workflow $WORKFLOW_ID..."
RESPONSE=$(curl -s -X PUT \
  "http://192.168.7.230:5678/api/v1/workflows/$WORKFLOW_ID" \
  -H "Content-Type: application/json" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -d "$PAYLOAD")

# Check response
if echo "$RESPONSE" | jq -e '.id' > /dev/null 2>&1; then
  echo "✅ Workflow updated successfully"
  echo "$RESPONSE" | jq '{id, name, active, updatedAt}'
else
  echo "❌ Failed to update workflow"
  echo "$RESPONSE" | jq '.'
  exit 1
fi
