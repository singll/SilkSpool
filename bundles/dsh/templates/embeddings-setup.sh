#!/usr/bin/env bash
# ==============================================================================
# SilkSecAgent 向量嵌入模块安装器（幂等）
# 组装 plugins/embeddings（独立 node_modules，不经 dsh plugin 体系）
# ==============================================================================
set -euo pipefail

BASE_DIR="{{BASE_DIR}}"
EMB_DIR="$BASE_DIR/plugins/embeddings"

log() { echo "[embeddings] $*"; }

mkdir -p "$EMB_DIR"
cp "$BASE_DIR/embeddings.index.js" "$EMB_DIR/index.js"

if [ ! -f "$EMB_DIR/package.json" ]; then
    cat > "$EMB_DIR/package.json" <<'EOF'
{
  "name": "@silksec/sec-embeddings",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": { "@huggingface/transformers": "^3.7.6" }
}
EOF
fi

if [ ! -d "$EMB_DIR/node_modules/@huggingface/transformers" ]; then
    log "安装 @huggingface/transformers（首次约 30s）"
    (cd "$EMB_DIR" && PATH=/usr/local/node/bin:$PATH npm install --omit=dev --no-audit --no-fund)
fi
log "嵌入模块就绪: $EMB_DIR"
