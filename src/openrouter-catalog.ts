import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { logOp } from './logger.js';
import { normalizeSlug } from './model-context.js';

export interface OpenRouterModelWindow {
  slug: string;
  minContextLength: number;
  providerCount: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const CACHE_PATH =
  process.env.WEVIBE_OPENROUTER_MODELS_PATH ?? join(homedir(), '.wevibe', 'openrouter-models.json');

interface DiskModelEntry {
  min_context_length: number;
  provider_count: number;
  fetched_at: number;
}

interface DiskCache {
  models: Record<string, DiskModelEntry>;
}

interface CachedWindow {
  window: OpenRouterModelWindow;
  fetchedAt: number;
}

const memoryCache = new Map<string, CachedWindow>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function positiveFiniteInteger(value: unknown): number | undefined {
  const parsed = positiveFiniteNumber(value);
  if (parsed === undefined) return undefined;
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < TTL_MS;
}

function ensureDir(): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
}

function parseDiskEntry(slug: string, value: unknown): CachedWindow | undefined {
  if (!isObject(value)) return undefined;

  const minContextLength = positiveFiniteNumber(value.min_context_length);
  const providerCount = positiveFiniteInteger(value.provider_count);
  const fetchedAt = positiveFiniteNumber(value.fetched_at);

  if (minContextLength === undefined || providerCount === undefined || fetchedAt === undefined) {
    return undefined;
  }

  return {
    window: {
      slug,
      minContextLength,
      providerCount,
    },
    fetchedAt,
  };
}

function readDiskCache(): Map<string, CachedWindow> | null {
  if (!existsSync(CACHE_PATH)) return null;

  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as unknown;
    if (!isObject(parsed) || !isObject(parsed.models)) {
      return null;
    }

    const models = new Map<string, CachedWindow>();
    for (const [rawSlug, rawEntry] of Object.entries(parsed.models)) {
      const slug = normalizeSlug(rawSlug);
      const entry = parseDiskEntry(slug, rawEntry);
      if (entry) {
        models.set(slug, entry);
      }
    }
    return models;
  } catch {
    return null;
  }
}

function readFreshDiskEntry(slug: string, now: number): CachedWindow | undefined {
  const disk = readDiskCache();
  if (!disk) return undefined;

  const entry = disk.get(slug);
  if (!entry) return undefined;
  if (!isFresh(entry.fetchedAt, now)) return undefined;
  return entry;
}

function writeDiskEntry(entry: CachedWindow): void {
  ensureDir();

  const disk = readDiskCache() ?? new Map<string, CachedWindow>();
  disk.set(entry.window.slug, entry);

  const models: Record<string, DiskModelEntry> = {};
  for (const [slug, cached] of disk.entries()) {
    models[slug] = {
      min_context_length: cached.window.minContextLength,
      provider_count: cached.window.providerCount,
      fetched_at: cached.fetchedAt,
    };
  }

  const payload: DiskCache = { models };
  const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best-effort */
  }
  renameSync(tmpPath, CACHE_PATH);
}

export function parseEndpointsResponse(
  json: unknown,
): { minContextLength: number; providerCount: number } | undefined {
  if (!isObject(json) || !isObject(json.data) || !Array.isArray(json.data.endpoints)) {
    return undefined;
  }

  const contextLengths: number[] = [];
  for (const endpoint of json.data.endpoints) {
    if (!isObject(endpoint)) continue;
    const contextLength = positiveFiniteNumber(endpoint.context_length);
    if (contextLength !== undefined) {
      contextLengths.push(contextLength);
    }
  }

  if (contextLengths.length === 0) {
    return undefined;
  }

  return {
    minContextLength: Math.min(...contextLengths),
    providerCount: contextLengths.length,
  };
}

export async function getModelMinContextWindow(
  slug: string,
  trace?: string,
): Promise<OpenRouterModelWindow | undefined> {
  const normalizedSlug = normalizeSlug(slug);
  const now = Date.now();

  const memoryEntry = memoryCache.get(normalizedSlug);
  if (memoryEntry && isFresh(memoryEntry.fetchedAt, now)) {
    logOp('openrouter_catalog', 'info', {
      trace,
      phase: 'lookup',
      source: 'memory',
      model: normalizedSlug,
      cache_hit: true,
    });
    return memoryEntry.window;
  }

  const diskEntry = readFreshDiskEntry(normalizedSlug, now);
  if (diskEntry) {
    memoryCache.set(normalizedSlug, diskEntry);
    logOp('openrouter_catalog', 'info', {
      trace,
      phase: 'lookup',
      source: 'disk',
      model: normalizedSlug,
      cache_hit: true,
    });
    return diskEntry.window;
  }

  const t0 = Date.now();
  const endpointsUrl = `https://openrouter.ai/api/v1/models/${normalizedSlug}/endpoints`;

  try {
    const res = await fetch(endpointsUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });

    if (!res.ok) {
      logOp('openrouter_catalog', 'warn', {
        trace,
        phase: 'miss',
        source: 'fetch',
        model: normalizedSlug,
        dur_ms: Date.now() - t0,
        err: `HTTP ${res.status}`,
      });
      return undefined;
    }

    const parsed = parseEndpointsResponse(await res.json());
    if (!parsed) {
      logOp('openrouter_catalog', 'warn', {
        trace,
        phase: 'miss',
        source: 'fetch',
        model: normalizedSlug,
        dur_ms: Date.now() - t0,
        err: 'no_usable_endpoints',
      });
      return undefined;
    }

    const fetchedAt = Date.now();
    const window: OpenRouterModelWindow = {
      slug: normalizedSlug,
      minContextLength: parsed.minContextLength,
      providerCount: parsed.providerCount,
    };

    memoryCache.set(normalizedSlug, { window, fetchedAt });

    try {
      writeDiskEntry({ window, fetchedAt });
    } catch (err) {
      logOp('openrouter_catalog', 'warn', {
        trace,
        phase: 'miss',
        source: 'disk_write',
        model: normalizedSlug,
        dur_ms: Date.now() - t0,
        err: errMessage(err),
      });
    }

    logOp('openrouter_catalog', 'info', {
      trace,
      phase: 'refresh',
      source: 'fetch',
      model: normalizedSlug,
      min_context_length: window.minContextLength,
      provider_count: window.providerCount,
      dur_ms: Date.now() - t0,
    });

    return window;
  } catch (err) {
    const fallback = readFreshDiskEntry(normalizedSlug, Date.now());
    if (fallback) {
      memoryCache.set(normalizedSlug, fallback);
      logOp('openrouter_catalog', 'warn', {
        trace,
        phase: 'miss',
        source: 'cache_fallback',
        model: normalizedSlug,
        min_context_length: fallback.window.minContextLength,
        provider_count: fallback.window.providerCount,
        cache_hit: true,
        dur_ms: Date.now() - t0,
        err: errMessage(err),
      });
      return fallback.window;
    }

    logOp('openrouter_catalog', 'warn', {
      trace,
      phase: 'miss',
      source: 'fetch',
      model: normalizedSlug,
      dur_ms: Date.now() - t0,
      err: errMessage(err),
    });
    return undefined;
  }
}
