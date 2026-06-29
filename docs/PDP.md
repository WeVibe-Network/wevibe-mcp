# wevibe-mcp PDP

## Architecture

- **Runtime:** Node.js 20.
- **Entry point:** `src/server.ts` bootstraps MCP tools and loads configuration.
- **Transport:** MCP stdio transport by default; socket transport available via `WEVIBE_MCP_SOCKET` env var.
- **Concurrency:** Uses async generators to stream tool responses; guard scans run via child-process gRPC client.

## Configuration

`wevibe.config.json` (generated during onboarding):
- `org_id`
- `member_public_key`
- `rpc_endpoint`
- `grpc_endpoint`
- `guard.address`
- `sdk.wasmPath`

Environment overrides:
- `WEVIBE_CHAIN_RPC`, `WEVIBE_CHAIN_GRPC`
- `WEVIBE_GUARD_ENDPOINT`
- `WEVIBE_MCP_LOG_LEVEL`

## Build & Test

- Package manager: `pnpm`.
- Commands:
  - `pnpm lint` (ESLint + TypeScript strict mode)
  - `pnpm test` (vitest contract tests)
  - `pnpm build` (transpile to ESM + bundle WASM assets)
- Integration tests spin up mock guard and SDK fixtures.

## Error Handling

- Structured errors with `code`, `message`, `remediation` displayed in agent UI.
- Retries: exponential backoff for transient chain RPC failures.
- Circuit breaker: disable recall if guard unavailable (configurable via `allow_unscanned_recall`).

## Logging & Metrics

- Winston logger -> `~/.wevibe/logs/mcp.log`.
- Optional OpenTelemetry exporter (OTLP) with `WEVIBE_MCP_OTEL_ENDPOINT`.
- MCP tool timing metrics summarised per request id.

## Packaging & Release

- Publish to npm under `@wevibe-network/wevibe-mcp`.
- CLI wrapper exposes `npx wevibe-mcp` for quick start.
- Docker image `ghcr.io/wevibe-network/wevibe-mcp` bundles Node runtime + guard client.

## Dependencies

- `@modelcontextprotocol/sdk` for MCP abstractions.
- `@cosmjs/stargate` for chain transactions.
- `wasm-bindgen` output from wevibe-sdk for cryptography.
- `pino` or `winston` for logging (depending on config).

## Known Gaps

- No built-in escalation path when moderator queue is saturated.
- Guard gRPC endpoint currently unauthenticated (relies on localhost).
- Serve receipt batching is in-memory; add durable queue for crash recovery.

## Sprint 28 Updates (CO-211)

- `src/trust-panel.ts` module added: `formatAccountAge` and `formatTrustPanel` for displaying trust statistics in retrieval results.
- Trust panel shows memory stats (retrieved, accepted) and contributor stats (account age, contributions, reports upheld, false reports against) per memory.
- `src/retrieve-cli.ts` now includes `memory_stats` and `contributor_stats` in JSON output, along with pre-formatted `trust_panel` string.
- `src/types.ts` and `src/deserialize.ts` updated to handle new `acceptanceCount` and `contributorStats` fields from hub.
