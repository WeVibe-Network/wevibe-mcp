# wevibe-mcp Whitepaper

Version: 1.0 · Sprint 24

## Abstract

`wevibe-mcp` implements the Model Context Protocol server that connects coding agents to WeVibe’s encrypted memory. It mediates contribution, recall, and rejection flows while orchestrating guard scans, SDK encryption, and serve attestation batching.

## Key Objectives

1. **Agent neutrality** — any MCP-capable IDE/agent can adopt WeVibe without custom integrations.
2. **Security boundary** — MCP server never emits plaintext beyond approved contexts; all encryption/decryption is delegated to wevibe-sdk.
3. **Streaming UX** — contributions, retrieval candidates, and guard findings stream incrementally for responsive moderation.

## Tool Surface

| Tool | Description |
|------|-------------|
| `wevibe_recall` | Retrieves candidate memories, runs guard scans, renders approval cards, queues serve attestations. |
| `wevibe_contribute` | Streams session buffers, triggers guard scans, encrypts via wevibe-sdk, and submits commitments. |
| `wevibe_reject` | Records negative feedback and updates local blacklist/quarantine hints. |

## Security Model

- Agent ↔ MCP communication occurs over stdio pipes (MCP spec) with optional TLS when using socket transport.
- All secret material (DEKs, epoch keys) stays within wevibe-sdk; MCP only handles ciphertext envelopes.
- Serve attestations are signed by the org member key stored locally.

## Workflow Hooks

- `beforeContribute`: run guard pre-flight; return blocking errors when credentials detected.
- `afterApprove`: persist approval metadata locally for audit, queue attestation for wevibe-chain.
- `onReject`: append to session blacklist; optionally notify dashboard via hub webhook.

## Extensibility

- Custom MCP tools can be registered for org-specific automation (e.g., `wevibe_gap_analysis`).
- Middleware API enables additional logging or analytics before responses reach the agent.

## Roadmap

- Multi-agent sessions with shared collaboration buffers.
- Fine-grained rate limiting per org membership role.
- Telemetry plugin (opt-in) for aggregated UX metrics.

## Sprint 24 Updates

- MCP transports now coordinate with the OpenCode plugin's Accept / Deny / Report flow, ensuring reported memories never reach the agent until hub quorum marks them ready.
- Added references to the new hub vote and report endpoints used when moderators act inside the plugin-driven UI.
- Integration guidance highlights the fee grant trial allowance path and moderator approvals that occur once hub-enforced quorum succeeds.

## Sprint 28 Updates (CO-211)

- Trust panel: retrieval results now include per-memory stats (`retrieval_count`, `acceptance_count`) and per-contributor stats (`account_age_days`, `contributions`, `reports_upheld`, `false_reports_against`).
- Consumer workflow: every recall candidate is presented with a formatted trust panel showing social signals (contributor account age, history) alongside memory quality signals (retrieval/acceptance counts).
- `wevibe_reject` tool reference updated: rejection feedback goes through the report system (`POST /v1/orgs/{orgID}/reports`), not a dedicated reject endpoint — the endpoint was removed from hub.
- Trust stats are always shown even if zero (no fallback path), ensuring consistent consumer experience regardless of hub deployment state.
