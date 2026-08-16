/**
 * OrcaRouter provider support: API key resolution, static per-model limits, and the live
 * OrcaRouter model catalog used to resolve context windows + completion caps for extraction.
 *
 * Secrets (D-MISSION-INVARIANT): the orcarouter key is read from opencode's auth.json and used
 * ONLY as a Bearer credential — it is NEVER logged. Logs carry key_len (bytes) and key_fp
 * (sha256 first-8, via fp()) instead.
 *
 * Fail semantics:
 * - Key resolution and the live catalog are FAIL-CLOSED: any miss throws, never a default window.
 * - Static limits from opencode.json are FAIL-OPEN: absence just means "use the live value".
 * Resolved limits are the per-dimension min of the live catalog value and the static cap.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { fp, logOp } from './logger.js';
import { ContextWindowResolutionError } from './model-context.js';

export const ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1';

export interface OrcarouterModelLimits {
  /** min(live context_length, static limit.context) */
  contextWindow: number;
  /** min(live max_completion_tokens, static limit.output) */
  maxCompletionTokens: number;
}

const CATALOG_NAME = 'OrcaRouter catalog';
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 15000;

interface CatalogEntry {
  context_length: number;
  max_completion_tokens: number;
}

interface CatalogCache {
  entries: Map<string, CatalogEntry>;
  fetchedAt: number;
}

// Full-catalog cache, in-memory ONLY (never persisted to disk). Keyed by lowercase model id.
let catalogCache: CatalogCache | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeModelId(modelId: string): string {
  let bare = modelId.trim().toLowerCase();
  if (bare.startsWith('orcarouter/')) {
    bare = bare.slice('orcarouter/'.length);
  }
  if (bare.startsWith('openrouter/')) {
    // defensive: dashboards historically sent openrouter/ prefixes
    bare = bare.slice('openrouter/'.length);
  }
  return bare;
}

export function resolveOrcarouterApiKey(): string {
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  const fail = (reason: string): never => {
    throw new Error(
      `orcarouter API key not found (${reason}) — expected a non-empty "key" field on the "orcarouter" entry in ${authPath} (run "opencode /connect" to register the orcarouter provider)`,
    );
  };

  let raw: string;
  try {
    raw = readFileSync(authPath, 'utf-8');
  } catch (err) {
    return fail(`unreadable: ${errMessage(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`malformed JSON: ${errMessage(err)}`);
  }

  if (!isObject(parsed)) {
    return fail('top-level JSON is not an object');
  }
  const entry = parsed['orcarouter'];
  if (!isObject(entry)) {
    return fail('the "orcarouter" entry is missing or not an object');
  }
  const key = entry['key'];
  if (typeof key !== 'string' || key.trim() === '') {
    return fail('"orcarouter.key" is not a non-empty string');
  }
  // Return the raw value verbatim — NEVER trim a secret (whitespace-only was rejected above).
  // Never logged anywhere in this module; callers log key_len / key_fp only.
  return key;
}

export function resolveOrcarouterStaticLimits(
  modelId: string,
): { context?: number; output?: number } | undefined {
  // Fail-open by contract: any absence/malformation means "no static cap" and the caller uses
  // the live catalog value alone. Silent catch mirrors openrouter-catalog.ts's cache reads.
  try {
    const normalized = normalizeModelId(modelId);
    if (normalized === '') return undefined;

    const configPath = join(homedir(), '.config', 'opencode', 'opencode.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    if (!isObject(parsed)) return undefined;

    const provider = parsed['provider'];
    if (!isObject(provider)) return undefined;
    const orcarouter = provider['orcarouter'];
    if (!isObject(orcarouter)) return undefined;
    const models = orcarouter['models'];
    if (!isObject(models)) return undefined;

    // Config model keys are the BARE vendor/model ids (e.g. "deepseek/deepseek-v4-pro-0813").
    const modelEntry = models[normalized];
    if (!isObject(modelEntry)) return undefined;
    const limit = modelEntry['limit'];
    if (!isObject(limit)) return undefined;

    const context = positiveFiniteNumber(limit['context']);
    const output = positiveFiniteNumber(limit['output']);
    if (context === undefined && output === undefined) return undefined;

    const result: { context?: number; output?: number } = {};
    if (context !== undefined) result.context = context;
    if (output !== undefined) result.output = output;
    return result;
  } catch {
    return undefined;
  }
}

function parseCatalog(json: unknown): Map<string, CatalogEntry> | undefined {
  if (!isObject(json) || !Array.isArray(json['data'])) {
    return undefined;
  }

  const entries = new Map<string, CatalogEntry>();
  for (const item of json['data']) {
    if (!isObject(item)) continue;
    const id = item['id'];
    if (typeof id !== 'string') continue;
    const contextLength = positiveFiniteNumber(item['context_length']);
    const maxCompletionTokens = positiveFiniteNumber(item['max_completion_tokens']);
    if (contextLength === undefined || maxCompletionTokens === undefined) continue;
    entries.set(id.toLowerCase(), {
      context_length: contextLength,
      max_completion_tokens: maxCompletionTokens,
    });
  }
  return entries;
}

async function refreshCatalog(
  modelId: string,
  normalized: string,
  trace?: string,
): Promise<CatalogEntry> {
  let apiKey: string;
  try {
    apiKey = resolveOrcarouterApiKey();
  } catch (err) {
    logOp('orcarouter_catalog', 'warn', {
      trace,
      phase: 'miss',
      source: 'api_key',
      model: normalized,
      err: errMessage(err),
    });
    // Propagate the actionable key error as-is (fail-closed); no key fields to log.
    throw err;
  }

  const keyLen = Buffer.byteLength(apiKey);
  const keyFp = fp(apiKey);
  const t0 = Date.now();

  const miss = (errText: string): never => {
    logOp('orcarouter_catalog', 'warn', {
      trace,
      phase: 'miss',
      source: 'fetch',
      model: normalized,
      key_len: keyLen,
      key_fp: keyFp,
      dur_ms: Date.now() - t0,
      err: errText,
    });
    throw new ContextWindowResolutionError(modelId, CATALOG_NAME);
  };

  let res: Response;
  try {
    res = await fetch(`${ORCAROUTER_BASE_URL}/models`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
  } catch (err) {
    return miss(errMessage(err));
  }
  if (!res.ok) {
    return miss(`HTTP ${res.status}`);
  }

  let entries: Map<string, CatalogEntry> | undefined;
  try {
    entries = parseCatalog(await res.json());
  } catch (err) {
    return miss(errMessage(err));
  }
  if (!entries) {
    return miss('unexpected_catalog_shape');
  }

  catalogCache = { entries, fetchedAt: Date.now() };

  const entry = entries.get(normalized);
  if (!entry) {
    return miss('model_absent');
  }

  logOp('orcarouter_catalog', 'info', {
    trace,
    phase: 'refresh',
    source: 'fetch',
    model: normalized,
    context_window: entry.context_length,
    max_completion_tokens: entry.max_completion_tokens,
    key_len: keyLen,
    key_fp: keyFp,
    dur_ms: Date.now() - t0,
  });
  return entry;
}

export async function resolveOrcarouterModelLimits(
  modelId: string,
  trace?: string,
): Promise<OrcarouterModelLimits> {
  const normalized = normalizeModelId(modelId);
  if (normalized === '') {
    throw new ContextWindowResolutionError(modelId || '(unknown)', CATALOG_NAME);
  }

  let live: CatalogEntry | undefined;

  const cached = catalogCache;
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    const hit = cached.entries.get(normalized);
    if (hit) {
      live = hit;
      logOp('orcarouter_catalog', 'info', {
        trace,
        phase: 'lookup',
        source: 'memory',
        model: normalized,
        cache_hit: true,
        context_window: hit.context_length,
        max_completion_tokens: hit.max_completion_tokens,
      });
    } else {
      logOp('orcarouter_catalog', 'warn', {
        trace,
        phase: 'miss',
        source: 'memory',
        model: normalized,
        cache_hit: true,
        err: 'model_absent',
      });
      throw new ContextWindowResolutionError(modelId, CATALOG_NAME);
    }
  }

  if (!live) {
    live = await refreshCatalog(modelId, normalized, trace);
  }

  const staticLimits = resolveOrcarouterStaticLimits(normalized);
  return {
    contextWindow:
      staticLimits?.context !== undefined
        ? Math.min(live.context_length, staticLimits.context)
        : live.context_length,
    maxCompletionTokens:
      staticLimits?.output !== undefined
        ? Math.min(live.max_completion_tokens, staticLimits.output)
        : live.max_completion_tokens,
  };
}
