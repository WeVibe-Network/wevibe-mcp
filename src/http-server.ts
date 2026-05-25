import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { retrieve, type RetrieveInput } from './retrieve-cli.js';
import { runWeVibeGuard } from './guard.js';
import { verifySessionToken, extractBearer, _getActiveStore } from './session-token.js';
import { loadIdentity } from './key-store.js';
import { buildWeVibeSignedAuth } from './auth.js';
import { getProviderPolicy } from './risk-appetite.js';
import { addDenial, flushDenials } from './denial-queue.js';

const HTTP_HOST = process.env.WEVIBE_HTTP_HOST ?? '127.0.0.1';
const HTTP_PORT = 4450;
const HUB_URL = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';

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
  jsonResponse(res, 200, { status: 'ok', version: '0.2.0' });
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

async function handleRecall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) {
    return;
  }

  flushDenials().catch(err => console.error('denial flush on recall failed:', err));

  const body = await readBody(req);
  let input: RetrieveInput;
  let rawInput: Record<string, unknown>;
  try {
    rawInput = JSON.parse(body) as Record<string, unknown>;
    input = rawInput as unknown as RetrieveInput;
  } catch {
    jsonResponse(res, 400, { status: 'error', error: 'invalid JSON' });
    return;
  }

  if (!input.query || typeof input.query !== 'string') {
    jsonResponse(res, 400, { status: 'error', error: 'query is required and must be a string' });
    return;
  }

  const result = await retrieve(input);

  if (result.status === 'error') {
    jsonResponse(res, 500, { status: 'error', error: result.error });
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
      guard,
    });
  }

  const providerPolicy = getProviderPolicy();
  const detectedProvider = detectProvider(rawInput);
  const orgAllowlist = result.org_allowed_providers ?? [];

  if (!providerAllowedByPolicy(providerPolicy, detectedProvider, orgAllowlist)) {
    jsonResponse(res, 200, { status: 'ok', memories: [], reason_code: 'provider_not_allowed' });
    return;
  }

  jsonResponse(res, 200, { status: 'ok', memories: memoriesWithGuard });
}

interface ServeRequestBody {
  org_id: string;
  memory_hash: string;
  nullifier: string;
  model_id?: string;
  turn_count?: number;
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

  const identity = await loadIdentity();
  if (!identity) {
    jsonResponse(res, 500, { status: 'error', error: 'identity not found' });
    return;
  }

  const pubkeyHex = Buffer.from(identity.edPubkey).toString('hex');

  const hubBody = {
    org_id: body.org_id,
    epoch_id: 0,
    memory_content_hash: body.memory_hash,
    serve_key: `serve-${body.memory_hash}`,
    contributor_id: pubkeyHex,
    nullifier: body.nullifier,
    model_id: body.model_id ?? 'unknown',
    turn_count: body.turn_count ?? 0,
  };

  let authResult: { pubkeyHex: string; headers: Record<string, string> };
  try {
    authResult = await buildWeVibeSignedAuth();
  } catch {
    jsonResponse(res, 500, { status: 'error', error: 'failed to build auth' });
    return;
  }

  let hubResp: Response;
  try {
    hubResp = await fetch(`${HUB_URL}/v1/orgs/${body.org_id}/serves`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authResult.headers,
      },
      body: JSON.stringify(hubBody),
    });
  } catch {
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  if (hubResp.status >= 500) {
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  const hubBodyText = await hubResp.text();
  let hubBodyJson: unknown;
  try {
    hubBodyJson = JSON.parse(hubBodyText);
  } catch {
    hubBodyJson = hubBodyText;
  }

  jsonResponse(res, hubResp.status, hubBodyJson);
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

  let hubResp: Response;
  try {
    hubResp = await fetch(`${HUB_URL}/v1/orgs/${body.org_id}/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authResult.headers,
      },
      body: JSON.stringify(hubBody),
    });
  } catch {
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  if (hubResp.status >= 500) {
    jsonResponse(res, 502, { error: 'upstream error' });
    return;
  }

  const hubBodyText = await hubResp.text();
  let hubBodyJson: unknown;
  try {
    hubBodyJson = JSON.parse(hubBodyText);
  } catch {
    hubBodyJson = hubBodyText;
  }

  jsonResponse(res, hubResp.status, hubBodyJson);
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

  addDenial({
    org_id: body.org_id,
    memory_hash: body.memory_hash,
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

export function startHttpServer(): void {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error(`wevibe-mcp: HTTP request error: ${err}`);
      jsonResponse(res, 500, { status: 'error', error: 'internal error' });
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`wevibe-mcp: HTTP port ${HTTP_PORT} already in use — another wevibe-mcp instance may be running. HTTP API disabled.`);
    } else {
      console.error(`wevibe-mcp: HTTP server error: ${err}`);
    }
  });

  server.listen(HTTP_PORT, HTTP_HOST, () => {
    console.error(`wevibe-mcp: HTTP API listening on ${HTTP_HOST}:${HTTP_PORT}`);
    // Periodic flush of denial queue — ensures denials reach the hub even when
    // the consumer is idle (no recall triggered). 60s interval is sufficient for
    // background retry; the timer naturally stops when the process exits.
    setInterval(() => {
      flushDenials().catch(err => console.error('periodic denial flush failed:', err));
    }, 60_000);
  });
}
