#!/bin/bash
# wevibe-mcp MCP server launcher
# Ollama is NOT required for the MCP server (embeddings bundled via transformers.js, LLM via MCP sampling)
# Admin CLI moderation approval uses the dashboard-configured LLM provider.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export WEVIBE_HUB_URL="${WEVIBE_HUB_URL:-http://localhost:4440}"

# Admin CLI only — not used by MCP server:
export WEVIBE_OLLAMA_URL="${WEVIBE_OLLAMA_URL:-http://localhost:11434}"

# Path to the wevibe-guard binary (override WEVIBE_GUARD_BIN to point elsewhere).
# Defaults to a sibling wevibe-guard checkout's release build.
export WEVIBE_GUARD_BIN="${WEVIBE_GUARD_BIN:-$SCRIPT_DIR/../wevibe-guard/target/release/wevibe-guard}"

export WEVIBE_AUTO_CONTRIBUTE="1"
exec node "${WEVIBE_MCP_SERVER:-$SCRIPT_DIR/dist/server.js}"
