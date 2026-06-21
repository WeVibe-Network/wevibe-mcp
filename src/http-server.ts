import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getRecallMode, getRecallModeGovernor, retrieve, type RetrieveInput } from './retrieve-cli.js';
import { runWeVibeGuard } from './guard.js';
import { verifySessionToken, extractBearer, _getActiveStore } from './session-token.js';
import { loadIdentity } from './key-store.js';
import { buildWeVibeSignedAuth } from './auth.js';
import { getProviderPolicy } from './risk-appetite.js';
import { addDenial, flushDenials } from './denial-queue.js';
import { buildOrgCryptoSetup, persistOrgKeys, provisionRecall } from './org-client.js';
import { EXTRACTION_MODEL, HTTP_HOST, HUB_URL, OLLAMA_URL } from './config.js';
import { HubSignatureError, hubFetchVerified } from './hub-fetch.js';
import { DEFAULT_EXTRACTION_NUM_CTX, extractMemories, getExtractionPrompt } from './extraction.js';
import { EXTRACTION_PRESETS, RECOMMENDED_PRESET_ID } from './extraction-presets.js';
import { createOllamaProvider } from './llm-ollama.js';
import { createOpenAICompatibleProvider } from './llm-openai-compat.js';
import { exportIdentityPairing } from './pairing-export.js';
import type { LlmProvider } from './llm.js';
import {
  buildCanonicalServeBodyBytes,
  deriveOrgServeKeyFromIdentitySeed,
  normalizeHex,
  signCanonicalBody,
} from './serve-signing.js';

const HTTP_PORT = 4450;

const BUILD_STAMP = (() => {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    return 0;
  }
})();

let extractionProvider: LlmProvider | null = null;
let httpServerInstance: import('node:http').Server | null = null;
let denialFlushTimer: NodeJS.Timeout | null = null;
let recallModeWarningEmitted = false;

interface PendingOrgSetup {
  masterKeyHex: string;
  modPrivkeyHex: string;
  orgName: string;
  createdAt: number;
}

const pendingOrgSetups = new Map<string, PendingOrgSetup>();
const PENDING_ORG_SETUP_TTL_MS = 30 * 60 * 1000; // 30 minutes

function purgeExpiredOrgSetups(): void {
  const now = Date.now();
  for (const [id, entry] of pendingOrgSetups) {
    if (now - entry.createdAt > PENDING_ORG_SETUP_TTL_MS) {
      pendingOrgSetups.delete(id);
    }
  }
}

function getExtractionProvider(): LlmProvider {
  if (!extractionProvider) {
    extractionProvider = createOllamaProvider(OLLAMA_URL, EXTRACTION_MODEL);
  }
  return extractionProvider;
}

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    req.on('data', (chunk: string) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.join('')));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }
  jsonResponse(res, 200, { status: 'ok', version: '0.2.0', build_stamp: BUILD_STAMP });
}

async function handleShutdown(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  jsonResponse(res, 200, { status: 'ok' });
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      // no-op
    }
  }, 50);
}

function authorize(req: IncomingMessage, res: ServerResponse): boolean {
  const authHeader = req.headers['authorization'];
  const token = extractBearer(authHeader);
  if (!token || !_getActiveStore().verify(token)) {
    jsonResponse(res, 401, { status: 'error', error: 'unauthorized' });
    return false;
  }
  return true;
}

interface MemoryWithGuard {
  cid: string;
  epoch_id: number;
  memory_type: string;
  score: number;
  keywords: Array<{ keyword: string; weight: number }>;
  matched_keywords?: string[];
  text: string;
  redacted_count: number;
  annotations: string[];
  breakdown?: Record<string, unknown>;
  memory_stats: MemoryStats;
  contributor_stats: ContributorStats;
  trust_panel: string;
  guard: {
    passed: boolean;
    detections: string[];
    flags: string[];
  };
}

interface ExtractRequestBody {
  transcript?: unknown;
  model?: unknown;
  ollama_url?: unknown;
  prompt?: unknown;
  num_ctx?: unknown;
  org_id?: unknown;
  provider?: string;
  api_key?: string;
  base_url?: string;
  project_context?: {
    title?: unknown;
    directory?: unknown;
    stack?: unknown;
  };
}

interface OrgSetupRequestBody {
  org_name?: unknown;
  domain?: unknown;
  leader_wallet?: unknown;
}

interface OrgSetupFinalizeRequestBody {
  setup_id?: unknown;
  org_id?: unknown;
}

interface ProvisionRecallRequestBody {
  org_id?: unknown;
}

interface MemoryStats {
  retrieval_count: number;
  acceptance_count: number;
}

interface ContributorStats {
  account_age_days: number;
  contributions: number;
  serve_count: number;
  reports_upheld: number;
  false_reports_against: number;
}

function detectProvider(input: Record<string, unknown>): string | null {
  const providerCandidates = [
    input.provider,
    input.provider_id,
    input.llm_provider,
    input.model_provider,
  ];

  for (const candidate of providerCandidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase();
    }
  }

  return null;
}

function isLocalProvider(provider: string): boolean {
  const normalized = provider.toLowerCase();
  if (normalized === 'local' || normalized === 'localhost') return true;
  if (normalized === 'ollama' || normalized === 'lm_studio' || normalized === 'lmstudio') return true;
  return normalized.startsWith('local:') || normalized.startsWith('ollama:') || normalized.startsWith('lmstudio:');
}

function providerAllowedByPolicy(
  policy: 'unrestricted' | 'local_only' | 'allowlist',
  provider: string | null,
  orgAllowlist: string[],
): boolean {
  if (provider === null) {
    console.warn(`wevibe-mcp: provider metadata missing at recall; provider_policy=${policy}, defaulting to unrestricted behavior`);
    return true;
  }

  if (policy === 'unrestricted') {
    return true;
  }

  if (policy === 'local_only') {
    return isLocalProvider(provider);
  }

  const normalizedAllowlist = orgAllowlist.map(v => v.trim().toLowerCase()).filter(v => v.length > 0);
  return normalizedAllowlist.includes(provider);
}

function sanitizeRecallLogValue(value: string): string {
  return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

async function handleRecall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  flushDenials().catch(err => console.error('denial flush on recall failed:', err));

  const body = await readBody(req);
  const recallGovernor = getRecallModeGovernor();
  let input: RetrieveInput;
  let rawInput: Record<string, unknown>;
  try {
    rawInput = JSON.parse(body) as Record<string, unknown>;
    input = rawInput as unknown as RetrieveInput;

    input.limit = typeof rawInput.limit === 'number' && Number.isFinite(rawInput.limit)
      ? rawInput.limit
      : recallGovernor.recall_limit;

    input.relevance_floor = typeof rawInput.relevance_floor === 'number' && Number.isFinite(rawInput.relevance_floor)
      ? rawInput.relevance_floor
      : recallGovernor.relevance_floor;

    input.surface_budget = typeof rawInput.surface_budget === 'number' && Number.isFinite(rawInput.surface_budget)
      ? rawInput.surface_budget
      : recallGovernor.surface_budget;
  } catch {
    console.error('[recall] /v1/recall error=invalid JSON');
    jsonResponse(res, 400, { status: 'error', code: 'invalid_json', error: 'invalid JSON' });
    return;
  }

  if (!input.query || typeof input.query !== 'string') {
    console.error('[recall] /v1/recall error=query missing or invalid');
    jsonResponse(res, 400, {
      status: 'error',
      code: 'query_required',
      error: 'query is required and must be a string',
    });
    return;
  }

  const queryPreview = sanitizeRecallLogValue(input.query.slice(0, 80));
  const requestedLimit = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? input.limit
    : recallGovernor.recall_limit;
  console.error('[recall] /v1/recall received query="%s" limit=%d', queryPreview, requestedLimit);

  let result: Awaited<ReturnType<typeof retrieve>>;
  try {
    result = await retrieve(input);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const detail = sanitizeRecallLogValue(message);
    console.error('[recall] /v1/recall error=%s', detail);
    jsonResponse(res, 500, { status: 'error', code: 'internal_error', error: 'internal error', detail: message });
    return;
  }

  if (result.status === 'error') {
    console.error('[recall] /v1/recall error=%s', sanitizeRecallLogValue(result.error));
    const code = result.error === 'no identity found in keychain' ? 'no_identity' : 'recall_failed';
    jsonResponse(res, 500, { status: 'error', code, error: result.error });
    return;
  }

  const memoriesWithGuard: MemoryWithGuard[] = [];

  for (const memory of result.memories) {
    let guard = { passed: true, detections: [] as string[], flags: [] as string[] };
    try {
      const scanResult = runWeVibeGuard(memory.text, [], {});
      if (!scanResult.passed) {
        guard.passed = false;
        guard.detections = scanResult.detections.map(d => `${d.field}:${d.scanner}/${d.rule}`);
        guard.flags = scanResult.flags ?? [];
      } else {
        guard.flags = scanResult.flags ?? [];
      }
    } catch {
      guard = { passed: false, detections: ['guard_unavailable'], flags: [] };
    }

    memoriesWithGuard.push({
      ...memory,
      matched_keywords: memory.matched_keywords ?? [],
      guard,
    });
  }

  const providerPolicy = getProviderPolicy();
  const detectedProvider = detectProvider(rawInput);
  const orgAllowlist = result.org_allowed_providers ?? [];

  if (!providerAllowedByPolicy(providerPolicy, detectedProvider, orgAllowlist)) {
    console.error('[recall] /v1/recall result_count=0 reason_code=provider_not_allowed');
    jsonResponse(res, 200, { status: 'ok', memories: [], reason_code: 'provider_not_allowed' });
    return;
  }

  if (memoriesWithGuard.length === 0) {
    const reasonCode = result.reason_code ?? 'no_memories';
    console.error('[recall] /v1/recall result_count=0 reason_code=%s', reasonCode);

    const responseBody: {
      status: 'ok';
      memories: MemoryWithGuard[];
      reason_code: 'no_memories' | 'decrypt_failed' | 'filtered_out';
      reason?: string;
    } = {
      status: 'ok',
      memories: memoriesWithGuard,
      reason_code: reasonCode,
    };

    if (result.reason) {
      responseBody.reason = result.reason;
    }

    jsonResponse(res, 200, responseBody);
    return;
  }

  console.error('[recall] /v1/recall result_count=%d', memoriesWithGuard.length);
  jsonResponse(res, 200, { status: 'ok', memories: memoriesWithGuard });
}

async function handleExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  const bodyStr = await readBody(req);
  let body: ExtractRequestBody;
  try {
    body = JSON.parse(bodyStr) as ExtractRequestBody;
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON' });
    return;
  }

  if (typeof body.transcript !== 'string') {
    jsonResponse(res, 400, { error: 'transcript is required and must be a string' });
    return;
  }

  const title = typeof body.project_context?.title === 'string' ? body.project_context.title : '';
  const directory = typeof body.project_context?.directory === 'string' ? body.project_context.directory : '';
  const stack = Array.isArray(body.project_context?.stack)
    ? body.project_context.stack.filter((item): item is string => typeof item === 'string')
    : [];

  const modelOverride = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : undefined;
  const ollamaUrlOverride = typeof body.ollama_url === 'string' && body.ollama_url.trim()
    ? body.ollama_url.trim()
    : undefined;
  const systemPromptOverride = typeof body.prompt === 'string' && body.prompt.trim().length > 0
    ? body.prompt
    : undefined;
  const numCtxOverride = typeof body.num_ctx === 'number'
    ? body.num_ctx
    : undefined;
  const orgId = typeof body.org_id === 'string' && body.org_id.trim().length > 0
    ? body.org_id.trim()
    : undefined;
  const providerOverride = typeof body.provider === 'string' && body.provider.trim().length > 0
    ? body.provider.trim().toLowerCase()
    : undefined;
  const apiKeyOverride = typeof body.api_key === 'string'
    ? body.api_key
    : undefined;
  const baseUrlOverride = typeof body.base_url === 'string'
    ? body.base_url
    : undefined;

  const provider = providerOverride && providerOverride !== 'ollama'
    ? createOpenAICompatibleProvider(
      baseUrlOverride ?? 'https://openrouter.ai/api/v1',
      modelOverride ?? EXTRACTION_MODEL,
      apiKeyOverride ?? '',
    )
    : (modelOverride
      ? createOllamaProvider(ollamaUrlOverride ?? OLLAMA_URL, modelOverride)
      : getExtractionProvider());

  try {
    const result = await extractMemories(
      body.transcript,
      {
        name: title,
        directory,
        stack,
      },
      {
        provider,
        systemPrompt: systemPromptOverride,
        numCtx: numCtxOverride,
        orgContext: orgId
          ? { orgId, hubUrl: HUB_URL }
          : undefined,
      },
    );

    jsonResponse(res, 200, { memories: result.memories, ...(result.meta ? { meta: result.meta } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, { error: `extraction failed: ${message}` });
  }
}

async function handleExtractDefaults(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  jsonResponse(res, 200, {
    prompt: getExtractionPrompt(),
    num_ctx: DEFAULT_EXTRACTION_NUM_CTX,
    model: EXTRACTION_MODEL,
    recommended_id: RECOMMENDED_PRESET_ID,
    presets: EXTRACTION_PRESETS.map(p => ({
      id: p.id,
      label: p.label,
      goal: p.goal,
      recommended: p.recommended,
      system_prompt: p.system_prompt,
    })),
  });
}

async function handleIdentityExportPairing(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  try {
    const { token, pairingId } = await exportIdentityPairing();
    jsonResponse(res, 200, { code: token, pairing_id: pairingId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'No identity. Run setup-identity first.') {
      jsonResponse(res, 404, { status: 'error', code: 'no_identity', error: 'no_identity' });
      return;
    }

    jsonResponse(res, 500, { status: 'error', code: 'internal_error', error: message, detail: message });
  }
}

async function handleOrgSetup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  const bodyStr = await readBody(req);
  let body: OrgSetupRequestBody;
  try {
    body = JSON.parse(bodyStr) as OrgSetupRequestBody;
  } catch {
    jsonResponse(res, 400, { status: 'error', code: 'invalid_json', error: 'invalid JSON' });
    return;
  }

  const orgName = typeof body.org_name === 'string' ? body.org_name.trim() : '';
  if (orgName.length === 0) {
    jsonResponse(res, 400, {
      status: 'error',
      code: 'org_name_required',
      error: 'org_name is required and must be a non-empty string',
    });
    return;
  }

  const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
  if (domain.length === 0) {
    jsonResponse(res, 400, {
      status: 'error',
      code: 'domain_required',
      error: 'domain is required and must be a non-empty string',
    });
    return;
  }

  const leaderWallet = typeof body.leader_wallet === 'string' && body.leader_wallet.trim().length > 0
    ? body.leader_wallet.trim()
    : undefined;

  let setup: Awaited<ReturnType<typeof buildOrgCryptoSetup>>;
  try {
    setup = await buildOrgCryptoSetup({
      orgName,
      domain,
      hubUrl: HUB_URL,
      leaderWallet,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, { status: 'error', code: 'internal_error', error: message, detail: message });
    return;
  }

  purgeExpiredOrgSetups();
  const setupId = randomBytes(16).toString('hex');
  pendingOrgSetups.set(setupId, {
    masterKeyHex: setup.masterKeyHex,
    modPrivkeyHex: setup.modPrivkeyHex,
    orgName,
    createdAt: Date.now(),
  });

  jsonResponse(res, 200, {
    status: 'ok',
    setup_id: setupId,
    payload: setup.payload,
    recovery_phrase: setup.recoveryPhrase,
  });
}

async function handleOrgSetupFinalize(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  const bodyStr = await readBody(req);
  let body: OrgSetupFinalizeRequestBody;
  try {
    body = JSON.parse(bodyStr) as OrgSetupFinalizeRequestBody;
  } catch {
    jsonResponse(res, 400, { status: 'error', code: 'invalid_json', error: 'invalid JSON' });
    return;
  }

  const setupId = typeof body.setup_id === 'string' ? body.setup_id.trim() : '';
  if (setupId.length === 0) {
    jsonResponse(res, 400, {
      status: 'error',
      code: 'setup_id_required',
      error: 'setup_id is required and must be a non-empty string',
    });
    return;
  }

  const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
  if (orgId.length === 0) {
    jsonResponse(res, 400, {
      status: 'error',
      code: 'org_id_required',
      error: 'org_id is required and must be a non-empty string',
    });
    return;
  }

  purgeExpiredOrgSetups();
  const pending = pendingOrgSetups.get(setupId);
  if (!pending) {
    jsonResponse(res, 404, { status: 'error', code: 'setup_not_found', error: 'unknown or expired setup_id' });
    return;
  }

  try {
    await persistOrgKeys(orgId, pending.masterKeyHex, pending.modPrivkeyHex, pending.orgName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, { status: 'error', code: 'internal_error', error: message, detail: message });
    return;
  }

  pendingOrgSetups.delete(setupId);
  jsonResponse(res, 200, { status: 'ok' });
}

async function handleProvisionRecall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  const bodyStr = await readBody(req);
  let body: ProvisionRecallRequestBody;
  try {
    body = JSON.parse(bodyStr) as ProvisionRecallRequestBody;
  } catch {
    jsonResponse(res, 400, { status: 'error', code: 'invalid_json', error: 'invalid JSON' });
    return;
  }

  const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
  if (orgId.length === 0) {
    jsonResponse(res, 400, {
      status: 'error',
      code: 'org_id_required',
      error: 'org_id is required and must be a non-empty string',
    });
    return;
  }

  try {
    await provisionRecall(orgId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, 500, { status: 'error', code: 'provision_failed', error: message, detail: message });
    return;
  }

  jsonResponse(res, 200, { status: 'ok' });
}

interface ServeRequestBody {
  org_id: string;
  session_id?: string;
  memory_hash: string;
  model_id?: string;
  turn_count?: number;
  matched_keywords: string[];
}

function currentServeEpochId(): number {
  // Current MCP serve epoch source: fixed epoch 0 (existing behavior).
  return 0;
}

async function handleServes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  const bodyStr = await readBody(req);
  let body: ServeRequestBody;
  try {
    body = JSON.parse(bodyStr) as ServeRequestBody;
  } catch {
    jsonResponse(res, 400, { status: 'error', error: 'invalid JSON' });
    return;
  }

  if (!body.org_id || typeof body.org_id !== 'string' || body.org_id.trim() === '') {
    jsonResponse(res, 400, { status: 'error', error: 'org_id is required and must be a non-empty string' });
    return;
  }

  if (!body.memory_hash || typeof body.memory_hash !== 'string' || body.memory_hash.trim() === '') {
    jsonResponse(res, 400, { status: 'error', error: 'memory_hash is required and must be a non-empty string' });
    return;
  }

  if (
    !Array.isArray(body.matched_keywords)
    || body.matched_keywords.length === 0
    || body.matched_keywords.some(keyword => typeof keyword !== 'string')
  ) {
    jsonResponse(res, 400, { error: 'matched_keywords is required, non-empty (D-4.2 Implementation Clarifications)' });
    return;
  }

  const identity = await loadIdentity();
  if (!identity) {
    jsonResponse(res, 500, { status: 'error', error: 'identity not found' });
    return;
  }

  const contributorPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
  const epochId = currentServeEpochId();
  const sortedMatchedKeywords = [...body.matched_keywords].sort();

  let memoryContentHashHex: string;
  try {
    memoryContentHashHex = normalizeHex(body.memory_hash, 'memory_hash');
    if (Buffer.from(memoryContentHashHex, 'hex').length !== 32) {
      jsonResponse(res, 400, { status: 'error', error: 'memory_hash must be a 32-byte hex string' });
      return;
    }
  } catch {
    jsonResponse(res, 400, { status: 'error', error: 'memory_hash must be a 32-byte hex string' });
    return;
  }

  let orgServeKey: Awaited<ReturnType<typeof deriveOrgServeKeyFromIdentitySeed>>;
  try {
    orgServeKey = await deriveOrgServeKeyFromIdentitySeed(identity.edPrivkey, body.org_id);
  } catch {
    jsonResponse(res, 500, { status: 'error', error: 'failed to derive org serve key' });
    return;
  }

  const nonceHex = randomBytes(8).toString('hex');

  let serveSigHex: string;
  try {
    const canonicalServeBody = buildCanonicalServeBodyBytes({
      orgId: body.org_id,
      memoryContentHashHex,
      epoch: epochId,
      serveKeyPubkeyHex: orgServeKey.pubHex,
      matchedKeywords: sortedMatchedKeywords,
      nonceHex,
    });
    serveSigHex = await signCanonicalBody(canonicalServeBody, orgServeKey.priv);
  } catch {
    jsonResponse(res, 400, { status: 'error', error: 'failed to sign serve payload' });
    return;
  }

  const hubBody = {
    org_id: body.org_id,
    session_id: body.session_id ?? '',
    epoch_id: epochId,
    memory_content_hash: memoryContentHashHex,
    serve_key_pubkey: orgServeKey.pubHex,
    serve_sig: serveSigHex,
    nonce: nonceHex,
    contributor_id: contributorPubkeyHex,
    model_id: body.model_id ?? 'unknown',
    turn_count: body.turn_count ?? 0,
    matched_keywords: sortedMatchedKeywords,
  };

  let authResult: { pubkeyHex: string; headers: Record<string, string> };
  try {
    authResult = await buildWeVibeSignedAuth();
  } catch {
    jsonResponse(res, 500, { status: 'error', error: 'failed to build auth' });
    return;
  }

  let hubResp: Awaited<ReturnType<typeof hubFetchVerified>>;
  try {
    hubResp = await hubFetchVerified(body.org_id, `${HUB_URL}/v1/orgs/${body.org_id}/serves`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authResult.headers,
      },
      body: JSON.stringify(hubBody),
    });
  } catch (error) {
    if (error instanceof HubSignatureError) {
      jsonResponse(res, 502, { error: 'upstream signature verification failed' });
      return;
    }
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  if (hubResp.res.status >= 500) {
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  const hubBodyText = hubResp.bodyText;
  let hubBodyJson: unknown;
  try {
    hubBodyJson = JSON.parse(hubBodyText);
  } catch {
    hubBodyJson = hubBodyText;
  }

  jsonResponse(res, hubResp.res.status, hubBodyJson);
}

interface ReportRequestBody {
  org_id: string;
  memory_hash: string;
  reason: string;
  note?: string;
}

const VALID_REASONS = ['incorrect', 'outdated', 'security_risk', 'malicious'] as const;
type ValidReason = typeof VALID_REASONS[number];

export async function handleReports(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  const bodyStr = await readBody(req);
  let body: ReportRequestBody;
  try {
    body = JSON.parse(bodyStr) as ReportRequestBody;
  } catch {
    jsonResponse(res, 400, { status: 'error', error: 'invalid JSON' });
    return;
  }

  if (!body.org_id || typeof body.org_id !== 'string' || body.org_id.trim() === '') {
    jsonResponse(res, 400, { status: 'error', error: 'org_id is required and must be a non-empty string' });
    return;
  }

  if (!body.memory_hash || typeof body.memory_hash !== 'string' || body.memory_hash.trim() === '') {
    jsonResponse(res, 400, { status: 'error', error: 'memory_hash is required and must be a non-empty string' });
    return;
  }

  if (!body.reason || typeof body.reason !== 'string' || !VALID_REASONS.includes(body.reason as ValidReason)) {
    jsonResponse(res, 400, { status: 'error', error: 'reason must be one of: incorrect, outdated, security_risk, malicious' });
    return;
  }

  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) {
    jsonResponse(res, 400, { status: 'error', error: 'note must be a string with max 2000 characters' });
    return;
  }

  const identity = await loadIdentity();
  if (!identity) {
    jsonResponse(res, 500, { status: 'error', error: 'identity not found' });
    return;
  }

  const pubkeyHex = Buffer.from(identity.edPubkey).toString('hex');

  const hubBody = {
    memory_cid: body.memory_hash,
    reporter_pubkey: pubkeyHex,
    reporter_wallet: '',
    reason: body.reason,
    note: body.note ?? '',
  };

  let authResult: { pubkeyHex: string; headers: Record<string, string> };
  try {
    authResult = await buildWeVibeSignedAuth();
  } catch {
    jsonResponse(res, 500, { status: 'error', error: 'failed to build auth' });
    return;
  }

  let hubResp: Awaited<ReturnType<typeof hubFetchVerified>>;
  try {
    hubResp = await hubFetchVerified(body.org_id, `${HUB_URL}/v1/orgs/${body.org_id}/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authResult.headers,
      },
      body: JSON.stringify(hubBody),
    });
  } catch (error) {
    if (error instanceof HubSignatureError) {
      jsonResponse(res, 502, { error: 'upstream signature verification failed' });
      return;
    }
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  if (hubResp.res.status >= 500) {
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  const hubBodyText = hubResp.bodyText;
  let hubBodyJson: unknown;
  try {
    hubBodyJson = JSON.parse(hubBodyText);
  } catch {
    hubBodyJson = hubBodyText;
  }

  jsonResponse(res, hubResp.res.status, hubBodyJson);
}

interface DenialRequestBody {
  org_id: string;
  memory_hash: string;
  reason?: string;
}

async function handleDenials(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  const bodyStr = await readBody(req);
  let body: DenialRequestBody;
  try {
    body = JSON.parse(bodyStr) as DenialRequestBody;
  } catch {
    jsonResponse(res, 400, { status: 'error', error: 'invalid JSON' });
    return;
  }

  if (!body.org_id || typeof body.org_id !== 'string' || body.org_id.trim() === '') {
    jsonResponse(res, 400, { status: 'error', error: 'org_id is required and must be a non-empty string' });
    return;
  }

  if (!body.memory_hash || typeof body.memory_hash !== 'string' || body.memory_hash.trim() === '') {
    jsonResponse(res, 400, { status: 'error', error: 'memory_hash is required and must be a non-empty string' });
    return;
  }

  let memoryHashHex: string;
  try {
    memoryHashHex = normalizeHex(body.memory_hash, 'memory_hash');
    if (Buffer.from(memoryHashHex, 'hex').length !== 32) {
      jsonResponse(res, 400, { status: 'error', error: 'memory_hash must be a 32-byte hex string' });
      return;
    }
  } catch {
    jsonResponse(res, 400, { status: 'error', error: 'memory_hash must be a 32-byte hex string' });
    return;
  }

  addDenial({
    org_id: body.org_id,
    epoch_id: currentServeEpochId(),
    memory_hash: memoryHashHex,
    reason: body.reason,
  });

  flushDenials().catch(err => console.error('denial flush failed:', err));

  jsonResponse(res, 200, { queued: true });
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '';
  const method = req.method ?? '';

  if (method === 'GET' && url === '/v1/health') {
    await handleHealth(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/recall') {
    await handleRecall(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/extract') {
    await handleExtract(req, res);
    return;
  }

  if (method === 'GET' && url === '/v1/extract/defaults') {
    await handleExtractDefaults(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/identity/export-pairing') {
    await handleIdentityExportPairing(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/shutdown') {
    await handleShutdown(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/org-setup') {
    await handleOrgSetup(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/org-setup/finalize') {
    await handleOrgSetupFinalize(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/provision-recall') {
    await handleProvisionRecall(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/serves') {
    await handleServes(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/reports') {
    await handleReports(req, res);
    return;
  }

  if (method === 'POST' && url === '/v1/denials') {
    await handleDenials(req, res);
    return;
  }

  jsonResponse(res, 404, { status: 'error', error: 'not found' });
}

export function startHttpServer(): Promise<boolean> {
  return new Promise(resolve => {
    const recallMode = getRecallMode();
    if (recallMode === 'test' && !recallModeWarningEmitted) {
      const governor = getRecallModeGovernor(recallMode);
      console.error(
        '[recall] WARNING: WEVIBE_RECALL_MODE=test — governor bypassed (floor=%s budget=%d limit=%d)',
        governor.relevance_floor,
        governor.surface_budget,
        governor.recall_limit,
      );
      recallModeWarningEmitted = true;
    }

    const server = createServer((req, res) => {
      handleRequest(req, res).catch(err => {
        console.error(`wevibe-mcp: HTTP request error: ${err}`);
        jsonResponse(res, 500, { status: 'error', error: 'internal error' });
      });
    });
    httpServerInstance = server;

    let settled = false;
    const settle = (started: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(started);
    };

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`wevibe-mcp: HTTP port ${HTTP_PORT} already in use; another MCP instance owns the session token — not overwriting. HTTP API disabled.`);
      } else {
        console.error(`wevibe-mcp: HTTP server error: ${err}`);
      }
      settle(false);
    });

    server.listen(HTTP_PORT, HTTP_HOST, () => {
      console.error(`wevibe-mcp: HTTP API listening on ${HTTP_HOST}:${HTTP_PORT}`);
      // Periodic flush of denial queue — ensures denials reach the hub even when
      // the consumer is idle (no recall triggered). 60s interval is sufficient for
      // background retry; the timer naturally stops when the process exits.
      denialFlushTimer = setInterval(() => {
        flushDenials().catch(err => console.error('periodic denial flush failed:', err));
      }, 60_000);
      denialFlushTimer.unref();
      settle(true);
    });
  });
}

export async function stopHttpServer(): Promise<void> {
  if (denialFlushTimer) {
    clearInterval(denialFlushTimer);
    denialFlushTimer = null;
  }

  if (!httpServerInstance) {
    return;
  }

  const serverToClose = httpServerInstance;
  httpServerInstance = null;

  try {
    await new Promise<void>(resolve => {
      serverToClose.close(err => {
        if (err) {
          console.error(`wevibe-mcp: HTTP server close error: ${err}`);
        }
        resolve();
      });
    });
  } catch (err) {
    console.error(`wevibe-mcp: HTTP server close threw: ${err}`);
  }
}
