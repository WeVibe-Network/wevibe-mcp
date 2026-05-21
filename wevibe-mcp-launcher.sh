#!/bin/bash
# wevibe-mcp MCP server launcher
# Ollama is NOT required for the MCP server (embeddings bundled via transformers.js, LLM via MCP sampling)
# Ollama IS required for wevibe-admin CLI (moderation approval uses Ollama for extraction)

export WEVIBE_HUB_URL="http://localhost:4440"

# Admin CLI only — not used by MCP server:
export WEVIBE_OLLAMA_URL="http://localhost:11434"
export WEVIBE_EXTRACTION_MODEL="qwen3.5-128k:latest"

export WEVIBE_GUARD_BIN="/Users/jerrysmith/Desktop/wevibe-workspace/wevibe-guard/target/release/wevibe-guard"

export WEVIBE_AUTO_CONTRIBUTE="1"
export WEVIBE_ALLOW_UNREVIEWED=1
exec node /Users/jerrysmith/Desktop/wevibe-workspace/wevibe-mcp/dist/server.js
