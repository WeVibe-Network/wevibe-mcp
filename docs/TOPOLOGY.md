# wevibe-mcp Topology (Updated: CO-266)

## Runtime Components

```
IDE / Agent -- MCP Transport (StdioServerTransport) -- wevibe-mcp --+-- wevibe-guard gRPC
                                                            |-- wevibe-sdk WASM (crypto)
                                                            |-- Umbral sidecar subprocess (WEVIBE_UMBRAL_SIDECAR_BIN)
                                                            +-- Cosmos RPC / gRPC (wevibe-chain)

Plugin (OpenCode) --+-- HTTP Transport -- wevibe-mcp HTTP API (127.0.0.1:4450, Bearer token auth)
                    |                   |-- GET /v1/health (Bearer token)
                    |                   |-- POST /v1/recall (Bearer token)
                    |                   |-- POST /v1/serves (Bearer token, value-add proxy)
                    |                   |-- POST /v1/reports (Bearer token, value-add proxy)
                    |                   |-- POST /v1/denials (Bearer token, queues denial to disk, flushes to hub)
                    +-- File-based queues (wevibe-guard-queue.json, etc.)
```

## Sprint 32 — CO-033b Serve forwarding contract

`POST /v1/serves` in `src/http-server.ts` is strict for matched-keyword ingress:

- Requires `matched_keywords` as a non-empty string array.
- Rejects missing/empty sets with HTTP 400 before hub round-trip.
- Forwards `matched_keywords` unchanged to hub `POST /v1/orgs/{orgID}/serves`.

This keeps MCP on the same one-path contract as hub and chain (`matched_keywords` required, non-empty).

## Request Traces

### Recall

1. Agent sends MCP tool call `wevibe_recall`.
2. wevibe-mcp computes keywords + vector and posts query to hub with `pre_pubkey` (from local secp256k1 PRE identity).
3. Hub returns PRE retrieval payload per result: `capsule`, `cfrag`, `umbral_ciphertext`, `epoch_id`, `cid`.
4. For each result, wevibe-mcp fetches ciphertext, loads epoch `umbral_pk` from manifest (`GET /v1/orgs/{orgID}/epoch/{epochID}/manifest`), and calls sidecar `decrypt-reencrypted`.
5. Sidecar returns DEK hex; wevibe-mcp performs AES-GCM decrypt locally, runs OCR/artifact policy transforms, then enforces provider leakage policy before response formatting.

**Blacklist Filter (CO-232):** After PRE decrypt (plaintext available) and before guard scan, memories are filtered by `pack_id` against the local blacklist (`~/.wevibe/blacklist.json`). `is_blacklisted(pack_id)` from `src/blacklist.ts` removes any memory that was denied by the user. Report actions do NOT add to blacklist — only Deny triggers local blacklist. This ensures denied memories never reappear in recall, while reported memories remain visible until moderator resolution.

**MemoryResult PRE Fields (CO-222):** `capsule`, `cfrag`, `umbral_ciphertext` replace the legacy `wrappedDekEnc` field. The `decrypt-reencrypted` sidecar subprocess handles Umbral re-encryption using the stored kfrags.

### Provider Leakage Policy Gate (CO-266)

Recall responses are now filtered by a local provider leakage policy after decrypt/scan/transform and before memories are returned:

- `provider_policy` modes: `unrestricted` (default), `local_only`, `allowlist`
- Policy source: `~/.wevibe/plugin-config.json` (same local config file used for `risk_appetite`)
- Provider detection fields accepted on recall input: `provider`, `provider_id`, `llm_provider`, `model_provider`
- `allowlist` evaluates against org-scoped allowed providers returned from hub membership (`org_allowed_providers`)
- Policy block response: HTTP 200 with `{ status: "ok", memories: [], reason_code: "provider_not_allowed" }`
- MCP config tool: `wevibe_set_provider_policy` sets/queries `provider_policy` in local plugin config
- If provider metadata is missing, wevibe-mcp logs a warning and defaults to unrestricted behavior for that request

### Moderation Relay (Sprint 24)

1. Accept / Deny / Report decisions from the OpenCode plugin are forwarded to hub report and vote endpoints.
2. **Deny** action: memory added to local blacklist (`~/.wevibe/blacklist.json`) via `add_to_blacklist(pack_id)`. Memory never shown again in recall for this user. Denials are also queued for hub flush via the denial queue (CO-014).
3. **Report** action: submitted to hub for moderator review. Does NOT add to local blacklist — memory remains visible in recall until resolution.
4. wevibe-mcp records reported memories locally so subsequent recall attempts stay blocked until hub marks them ready or resolved.
5. Moderator approvals issued after quorum use the refreshed transaction helpers that rely on fee grant allowances.

### Denial Queue (CO-014)

Denial events from the plugin are queued persistently and flushed to the hub.

**Queue file:** `~/.wevibe/pending-denials.json` (flat JSON array, crash-resilient via atomic `.tmp` + `renameSync`)

**Endpoint:** `POST /v1/denials` (MCP session token auth, same as `/v1/reports`)
- Request body: `{ org_id: string, memory_hash: string, reason?: string }`
- Response: `{ queued: true }` (200)
- Validation: `org_id` and `memory_hash` required and non-empty

**Queue entry shape:**
```typescript
interface PendingDenial {
  id: string;           // crypto.randomUUID()
  org_id: string;
  memory_hash: string;
  reason?: string;
  created_at: string;    // ISO 8601
}
```

**Flush triggers:**
1. **On recall** — `flushDenials()` called fire-and-forget at start of `handleRecall()`, before `retrieve()` runs
2. **On POST /v1/denials** — `flushDenials()` called fire-and-forget after queuing
3. **60-second timer** — periodic flush at server startup

**Hub flush:** `flushDenials()` POSTs to `${HUB_URL}/v1/orgs/${orgId}/denials` with WeVibe-Signed auth. Body: `{ org_id: denial.org_id, epoch_id: denial.epoch_id, memory_hash: memoryHashHex, serve_key_pubkey: serveKey.pubHex, serve_sig: serveSigHex, nonce: nonceHex, serve_fingerprint: serveFingerprintHex, reason: denial.reason ?? '' }`. Success (2xx) and 4xx remove from queue; 5xx and network failures leave in queue for retry.

### Dashboard Quorum Voting Bridge (CO-265)

Dashboard moderation flows now consume quorum-aware MCP moderation tools:

- `wevibe_mod_queue` includes `votes`, `required_approvals`, and `voter_pubkeys` per submission.
- `wevibe_mod_vote` calls hub `POST /v1/orgs/{orgID}/moderation/{submissionHash}/vote` and returns `{ status, votes, required_approvals, ready }`.
- For `required_approvals > 1`, dashboard uses `wevibe_mod_vote`; for `required_approvals == 1`, dashboard keeps direct approve path.

### Administrative Authoring Tool Gate (CO-266)

- `wevibe_author_memory` remains available for org seeding but is now strictly leader-only.
- Tool description explicitly marks it as an administrative shortcut, not the normal contributor path.

### Approval Simplified (CO-238)

1. Moderator approval decrypts the submission DEK with the moderator envelope key.
2. wevibe-mcp sends approval to hub with just: `epoch_id`, `memory_type`, `signed_by`, `moderator_sig`.
3. **No keyword extraction at approval time** — keywords are extracted later in the batch pipeline.
4. **No embedding computation at approval time** — embeddings computed on-demand at chain commit time.
5. **No Qdrant insert at approval time** — Qdrant insert happens after chain commit.

### Preference Flagging (CO-239)

**`preference_confidence` field:** Each extracted `MemoryCandidate` includes a `preference_confidence` score (0.0–1.0) indicating the extraction model's confidence that the memory represents a genuine user preference. This field is:

- Added to `MemoryCandidate` interface in `src/extraction.ts`
- Included in the JSON output schema of the extraction prompt
- Passed through `wevibe_extract_memories` MCP tool to dashboard
- Displayed on dashboard moderation and chain-submit pages as confidence badges

**Confidence thresholds:**
- `> 0.8`: Red badge — high confidence preference
- `> 0.5`: Amber badge — moderate confidence
- `≤ 0.5`: No badge — low confidence flagged for review

**Moderator decision:** `preference_confidence` is a flag, not a filter. The moderator decides what action to take; findings are informational.

### Vocabulary-Constrained Keyword Extraction (CO-236, CO-238)

**Two-pass extraction architecture:**
1. **Pass 1 — Memory extraction:** `extractMemories(rawBuffer, projectContext)` extracts individual technical insights from session transcript. Available via MCP tool `wevibe_extract_memories`.
2. **Pass 2 — Keyword classification:** `extractKeywords(plaintext, stackHint, orgVocabulary)` classifies each memory against the org's established keyword vocabulary. Available via MCP tool `wevibe_extract_keywords_batch`.

**Canonical extraction path (CO-238):**
- No other code should call the LLM for keywords or memories
- Dashboard `/api/extract` proxies to `wevibe_extract_memories` MCP tool

**Weight normalization (CO-238):**
- Classified keyword weights are normalized to sum to 1.0 across all classified keywords
- Suggestion weights are normalized separately to sum to 1.0
- The LLM assigns relative relevancy weights; normalization happens server-side

**New types in `src/extraction.ts`:**
- `ClassifiedKeyword { keyword: string, weight: number }` — keyword selected from org vocabulary (normalized to sum 1.0)
- `SuggestedKeyword { keyword: string, weight: number, rationale: string }` — new keyword suggestion (normalized separately)
- `KeywordExtractionResult { classified: ClassifiedKeyword[], suggestions: SuggestedKeyword[] }` — extraction result

**Validation rules:**
- Classified keywords MUST exist in orgVocabulary (case-insensitive). Invalid entries are dropped with `console.warn`.
- Suggestion keywords MUST NOT exist in orgVocabulary and must match `^[a-z][a-z0-9_]{1,39}$`. Invalid entries are dropped.
- Weights are clamped to [0.0, 1.0] then normalized.

### Keyword Weight Surfacing (CO-240)

**`RetrievedKeyword` type in `src/types.ts`:**
```typescript
interface RetrievedKeyword {
  keyword: string;
  weight: number; // 0.0-1.0, from chain keyword weight
}
```

**MemoryResult includes keyword weights:**
- `MemoryResult.keywords: RetrievedKeyword[]` — per-keyword weights from chain
- Displayed in retrieval output: `keyword (weight)` — e.g., "postgresql (0.85), nginx (0.72)"

**org-client.ts `QueryMemoryResult` interface:**
- Parses keyword weights from hub response
- Returns structured keyword data with weights

**Removed:** All references to memory-level confidence. Keyword weights are the health metric.

### PreIdentity Lifecycle (CO-222)

**Type:** `PreIdentity { secretKeyHex: string, publicKeyHex: string }`
- Secret key: 32-byte secp256k1 scalar stored as hex
- Public key: compressed 33-byte secp256k1 point stored as hex (derived via `@noble/secp256k1`)

**Storage:** file-backed keystore at `${WEVIBE_KEYSTORE_PATH}/keys.json` under service `wevibe-network`, account `pre-identity-key`

**Methods (`src/auth.ts`):**
- `getOrCreatePreIdentity(): Promise<PreIdentity>` — creates PRE identity if absent, returns existing
- `getPrePublicKeyHex(): string` — returns compressed 33-byte pubkey hex
- `getPreSecretKeyHex(): string` — returns 32-byte secret key hex

**Registration:** On startup, `getOrCreatePreIdentity()` is called and PRE pubkey registered with hub for each org membership via `POST /v1/orgs/{orgID}/members/{pubkey}/pre-key`. Registration is non-fatal on hub/unreachable/member-not-found errors; retried opportunistically on future startup/tool flows.

### Invite + Epoch PRE Material (CO-222)

**createOrg():** Hub returns `epoch_sk_hex` + `epoch_pk_hex`; wevibe-mcp stores both in keystore envelopes (`org-{orgId}-epoch-sk`, `org-{orgId}-epoch-pk`).

**rotateEpoch():** Persists returned `epoch_sk_hex` + `epoch_pk_hex` when included in hub response.

**inviteMember():** Sends both `epoch_sk` and invitee `pre_pubkey_hex` so hub can generate/store kfrags for retrieval re-encryption.

**registerPrePubkey():** `POST /v1/orgs/{orgID}/members/{pubkey}/pre-key` — registers PRE pubkey for member retrieval.

**PRE Retrieval Flow (CO-222):** `queryOrgMemories` accepts `pre_pubkey` parameter. Hub returns `capsule`, `cfrag`, `umbral_ciphertext` per result (replacing legacy `wrappedDekEnc`). Sidecar `decrypt-reencrypted` subprocess performs Umbral re-encryption to recover DEK.

### Contribute

1. Agent streams session buffer frames to `wevibe_contribute`.
2. wevibe-mcp forwards frames to guard for continuous scanning.
3. After final frame, wevibe-sdk encrypts payload and emits submission txn.
4. Broadcast `MsgSubmitCommitment` using Cosmos RPC and return commitment hash.

## Internal Modules

- `src/server.ts` — MCP server entry point and tool routing
- `src/http-server.ts` — HTTP API server on `127.0.0.1:4450` with `/v1/health`, `/v1/recall`, `/v1/serves`, `/v1/reports`, `/v1/denials` endpoints (CO-244, CO-260, CO-014). All endpoints require Bearer token auth (CO-260).
- `src/denial-queue.ts` — persistent denial queue with crash-resilient atomic writes. Exports: `addDenial`, `getPendingDenials`, `removeDenials`, `getPendingCount`, `flushDenials`. Queue file: `~/.wevibe/pending-denials.json`. (CO-014)
- `src/session-token.ts` — session token generation, disk persistence (mode 0600), and constant-time verification (CO-260 Task A). Token at `~/.wevibe/mcp-session-token`.
- `src/contribution.ts` — streaming encryptor and submission composer
- `src/retrieve-cli.ts` — Importable module for PRE retrieval (query → decrypt → sanitize → artifact policy → trust panel). No CLI wrapper — exported `retrieve(input: RetrieveInput): Promise<Output>` is called by HTTP server
- `src/session.ts` — session state management
- `src/vault.ts` — encrypted vault operations
- `src/key-store.ts` — key storage and retrieval (file-backed JSON keystore + delegate identity storage)
- `src/auth.ts` — WeVibe-Signed auth + PRE identity lifecycle (`getOrCreatePreIdentity`, `getPrePublicKeyHex`, `getPreSecretKeyHex`)
- `src/risk-appetite.ts` — local plugin policy config (`risk_appetite`, `provider_policy`) in `~/.wevibe/plugin-config.json`
- `src/org-client.ts` — org API client + PRE pubkey registration (`registerPrePubkey`) + PRE retrieval decrypt path + `getOrgKeywords()` for fetching org keyword vocabulary
- `src/moderation.ts` — moderation handling
- `src/sidecar.ts` — sidecar subprocess helper for Umbral `encrypt` and `decrypt-reencrypted` (JSON stderr parsing on sidecar failures)
- `src/guard.ts` — gRPC client wrapper for wevibe-guard (also used by http-server.ts for guard scanning in recall pipeline)
- `src/crypto.ts` — cryptographic utilities
- `src/canonical.ts` — canonical message generation
- `src/trust-panel.ts` — trust panel formatting for retrieval results
- `src/types.ts` — TypeScript type definitions (includes `DelegateIdentity` interface added CO-214)

## Persistence

- `~/.wevibe/cache/vector.sqlite` — recall index (shared with wevibe-sdk).
- `~/.wevibe/cache/pending/` — queued submissions and attestations.
- `~/.wevibe/logs/mcp.log` — structured logs.
- `~/.wevibe/plugin-config.json` — local recall policy config (`risk_appetite`, `provider_policy`).
- **`${WEVIBE_KEYSTORE_PATH}/keys.json`** — stores Ed25519 identity (`wevibe-network`/`identity-v1`), PRE identity (`wevibe-network`/`pre-identity-key`), per-org epoch PRE keys (`org-{orgId}-epoch-sk`, `org-{orgId}-epoch-pk`), and delegate identity mnemonics (`wevibe-delegate-{walletAddress}`, CO-214).

## Delegate Identity Storage (CO-214)

wevibe-mcp stores delegate key mnemonics in the local keystore, enabling wallet-backed signing:

- `storeDelegateIdentity(walletAddress, delegateAddress, delegateMnemonic, orgId)` — stores JSON `{ walletAddress, delegateAddress, delegateMnemonic, orgId }` under keystore service `wevibe-delegate-{walletAddress}`
- `getDelegateIdentity(walletAddress)` — retrieves delegate identity from keychain
- `hasDelegateIdentity(walletAddress)` — boolean check for existence
- `clearDelegateIdentity(walletAddress)` — removes delegate identity from keychain

This is separate from the Ed25519 identity flow (which uses `wevibe-network` service). The delegate identity enables wevibe-mcp to sign with the same delegate key that the dashboard authorized via MsgGrant.

## Networking Ports

- MCP stdio (default) or configured Unix socket / TCP port.
- HTTP API (CO-244, CO-260): `127.0.0.1:4450` by default (container sets `WEVIBE_HTTP_HOST=0.0.0.0`), **Bearer token auth required** (D-12.5a). Endpoints: `/v1/health`, `/v1/recall`, `/v1/serves`, `/v1/reports`. Token at `~/.wevibe/mcp-session-token` (mode 0600).
- Guard gRPC default: `127.0.0.1:9450`.
- Chain RPC default: `127.0.0.1:26657`; chain gRPC default: `127.0.0.1:9090`.

## Required Environment

- `WEVIBE_UMBRAL_SIDECAR_BIN` — absolute/relative path to `wevibe-umbral-sidecar` binary. Required for approval-time capsule generation and Umbral decrypt-reencrypted operations.

## Scaling Considerations

- Multiple agents can connect to a single wevibe-mcp daemon; concurrency handled via async streams.
- Guard gRPC connections pooled to avoid per-request process spawn overhead.
- Serve receipt queue flushes in batches (configurable `attestationBatchSize`).

## Signed Canonical Body — Contribution Path (CO-029)

### `src/canonical.ts`

`submitMemoryMessage(orgId, epochId, submissionHash, contributorPubkey, memoryType, ciphertextHash, plaintextHash, salt, wrappedDekHash)` builds the 9-field canonical body. The 10-line layout starts with the domain tag `wevibe.submit_memory.v1` followed by alphabetically-ordered key/value pairs:

```
wevibe.submit_memory.v1
ciphertext_hash:<hex>
contributor_pubkey:<hex>
epoch_id:<int>
memory_type:<correct_implementation|negative_signal>
org_id:<string>
plaintext_hash:<hex>
salt:<hex>
submission_hash:<hex>
wrapped_dek_hash:<hex>
```

Byte-identical to the hub `SubmitMemoryMessage` (Go) and the dashboard `submitMemoryCanonical` (WebCrypto TS). Locked by `wevibe-server/wevibe-hub/internal/verify/canonical_test.go::TestCanonicalBodyCrossLanguageConformance`.

### `src/contribution.ts` — hash + encrypt + sign block

The contribution flow now generates four hash commitments before signing:

```ts
const dek = generateDek();
const plaintextBytes = Buffer.from(sanitizedNotes, 'utf-8');
const salt = crypto.randomBytes(32);                             // 32 bytes
const plaintextHash = sha256(Buffer.concat([salt, plaintextBytes]));  // salt PREPENDS
const ciphertext = encryptSymmetric(plaintextBytes, dek);
const wrappedDekMod = sealToPubkey(dek, membership.modPubkey);
const ciphertextHash = sha256(ciphertext);
const wrappedDekHash = sha256(wrappedDekMod);
const submissionHash = sha256(Buffer.concat([ciphertext, wrappedDekMod]));

const canonical = submitMemoryMessage(
  orgId, membership.currentEpoch, submissionHash, contributorPubkeyHex,
  memoryType, ciphertextHash, plaintextHash, salt.toString('hex'), wrappedDekHash,
);
const sig = sign(identity.edPrivkey, canonical);
```

The salt **prepends** the plaintext bytes before hashing (locked by D-VR-3). Reversing the order silently invalidates Tier 2 verification at the chain.

### Submit payload

The outbound payload to `POST /v1/orgs/{orgID}/submit` carries the four new fields:

```ts
{
  org_id, epoch_id,
  ciphertext, wrapped_dek_mod, submission_hash,
  plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash,   // CO-029
  contributor_pubkey, contributor_sig,
  memory_type, stack_hint, attestation,
}
```

The hub validates each hash field is 64 hex chars and re-derives `ciphertext_hash`, `wrapped_dek_hash`, and `submission_hash` from the bytes before persisting. A mismatch is rejected with 400. The hub does NOT receive plaintext.

### Crypto primitives

- Ed25519 sign via `wevibe-sdk` (Rust → Node binding) — same as previously.
- SHA-256 via `node:crypto.createHash('sha256')`.
- Random salt via `node:crypto.randomBytes(32)`.

No new dependencies; the contribution path uses primitives that were already imported.
