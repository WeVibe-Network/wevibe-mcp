<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:02100a,100:2fe07a&height=160&section=header&text=wevibe-mcp&fontColor=54f59a&fontSize=42&fontAlignY=40&desc=Local%20recall%20and%20human-approval%20gateway&descAlignY=64&descSize=16" alt="wevibe-mcp" width="100%" />

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
[![status-alpha](https://img.shields.io/badge/status-alpha-ffc266?style=flat-square)](https://github.com/WeVibe-Network)
[![license-Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-82aaff?style=flat-square)](LICENSE)
[![docs-wevibe-docs](https://img.shields.io/badge/docs-wevibe--docs-54f59a?style=flat-square)](https://github.com/WeVibe-Network/wevibe-docs)
[![%40WeVibe__Network](https://img.shields.io/badge/%40WeVibe__Network-0a0a0a?style=flat-square&logo=x&logoColor=white)](https://x.com/WeVibe_Network)

</div>

---

Local safety, identity, and approval gateway for WeVibe memory in coding agents.

## Overview

`wevibe-mcp` is a TypeScript/Node (ESM) service that runs on the developer's machine and handles local memory retrieval and policy enforcement.

Core responsibilities in the current implementation:

- Runs an MCP server and a loopback HTTP API (`127.0.0.1:4450`, Bearer-token gated).
- Builds recall queries from local session signals and computes query embeddings locally.
- Fetches encrypted memory candidates from the hub, then decrypts them locally through the Umbral sidecar flow.
- Applies local safety controls (`wevibe-guard` scan, artifact policy checks, OCR sanitization, blacklist handling) before candidate presentation.
- Powers the human approval gate used before memory injection.
- Maintains local identity and keystore data under `~/.wevibe/`.
- Ships CLI entrypoints: `wevibe-mcp`, `wevibe-admin`, and `wevibe-retrieve`.
- Bundles OpenCode plugin source for local onboarding automation.

> Note: this repository still contains some legacy Python-era artifacts, but the shipped runtime path is TypeScript.

## Role in the WeVibe Network

`wevibe-mcp` is the local enforcement layer between an agent client and network memory.

It is responsible for:

1. Local recall query shaping and embedding.
2. Secure retrieval + local decrypt path.
3. Local guard/policy enforcement.
4. Mandatory human review before memory reaches the active coding session.

In practice, this is the path that governs memory injection into the agent runtime.

## Getting started

### Prerequisites

- Node.js `>=20`
- npm
- Local WeVibe dependencies used by your setup (for example, `wevibe-guard`, Umbral sidecar binary, and model provider such as Ollama)

### Build

```bash
npm install
npm run build
```

### Run

Development mode:

```bash
npm run dev
```

Run built artifacts:

```bash
node dist/admin.js setup-identity
node dist/server.js
```

Optional OpenCode onboarding helper:

```bash
cd ../wevibe-opencode-plugin && npm run install-opencode
# or: npx tsx bin/install-opencode.ts install-opencode
```

Docker support is available via the repository `Dockerfile`.

## Testing

```bash
npm test
npm run test:integration
```

## Configuration

Common environment variables:

- `WEVIBE_HUB_URL` — hub API base URL.
- `WEVIBE_CHAIN_REST_URL` — chain REST endpoint used for resolver workflows.
- `WEVIBE_DASHBOARD_URL` — dashboard base URL used by pairing/adoption flows.
- `WEVIBE_OLLAMA_URL` / `OLLAMA_HOST` — local model + embedding endpoints.
- Extraction model — configured in Dashboard Settings UI (required, no default).
- `WEVIBE_EMBEDDING_MODEL` — embedding model ID.
- `WEVIBE_HTTP_HOST` — bind host for local HTTP API (default loopback).
- `WEVIBE_DASHBOARD_PORT` — local dashboard server port.
- `WEVIBE_UMBRAL_SIDECAR_BIN` — path to Umbral sidecar binary.

Local files/paths to be aware of:

- `~/.wevibe/mcp-session-token` — token consumed by local clients for HTTP auth.
- `~/.wevibe/plugin-config.json` — local risk/provider policy config.
- `~/.wevibe/` — identity, keystore, and local state.

## Roadmap

See [ROADMAP.md](./ROADMAP.md).

## License

Apache-2.0.

## Links

- Docs: https://github.com/WeVibe-Network/wevibe-docs
- Org: https://github.com/WeVibe-Network
- X: https://x.com/WeVibe_Network
