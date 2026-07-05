import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { logOp } from './logger.js';
import { normalizeSlug } from './model-context.js';

export interface OpenRouterModelEntry {
  id: string;
  contextLength?: number;
  topProviderContextLength?: number;
  maxCompletionTokens?: number;
}

export type OpenRouterCatalog = Map<string, OpenRouterModelEntry>;

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const CACHE_PATH =
  process.env.WEVIBE_OPENROUTER_MODELS_PATH ?? join(homedir(), '.wevibe', 'openrouter-models.json');

let memoryCatalog: OpenRouterCatalog | null = null;
let memoryFetchedAt = 0;

interface DiskCache {
  fetched_at: number;
  models: OpenRouterModelEntry[];
}

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

function ensureDir(): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
  }
}

function buildCatalog(models: OpenRouterModelEntry[]): OpenRouterCatalog {
  const catalog: OpenRouterCatalog = new Map();
  for (const model of models) {
    catalog.set(normalizeSlug(model.id), model);
  }
  return catalog;
}

function parseCachedModels(value: unknown): OpenRouterModelEntry[] {
  if (!Array.isArray(value)) return [];
  const models: OpenRouterModelEntry[] = [];

  for (const item of value) {
    if (!isObject(item)) continue;
    if (typeof item.id !== 'string') continue;

    models.push({
      id: item.id,
      contextLength: positiveFiniteNumber(item.contextLength),
      topProviderContextLength: positiveFiniteNumber(item.topProviderContextLength),
      maxCompletionTokens: positiveFiniteNumber(item.maxCompletionTokens),
    });
  }

  return models;
}

function readDiskCache(): DiskCache | null {
  if (!existsSync(CACHE_PATH)) return null;

  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as unknown;
    if (!isObject(parsed)) return null;

    const fetchedAt = positiveFiniteNumber(parsed.fetched_at);
    if (fetchedAt === undefined) return null;

    return {
      fetched_at: fetchedAt,
      models: parseCachedModels(parsed.models),
    };
  } catch {
    return null;
  }
}

function writeDiskCache(fetchedAt: number, models: OpenRouterModelEntry[]): void {
  ensureDir();
  const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ fetched_at: fetchedAt, models }), 'utf-8');
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best-effort */
  }
  renameSync(tmpPath, CACHE_PATH);
}

export function parseModelsResponse(json: unknown): OpenRouterModelEntry[] {
  if (!isObject(json) || !Array.isArray(json.data)) {
    return [];
  }

  const models: OpenRouterModelEntry[] = [];
  for (const item of json.data) {
    if (!isObject(item)) continue;
    if (typeof item.id !== 'string') continue;

    const topProvider = isObject(item.top_provider) ? item.top_provider : null;
    models.push({
      id: item.id,
      contextLength: positiveFiniteNumber(item.context_length),
      topProviderContextLength: topProvider
        ? positiveFiniteNumber(topProvider.context_length)
        : undefined,
      maxCompletionTokens: topProvider
        ? positiveFiniteNumber(topProvider.max_completion_tokens)
        : undefined,
    });
  }

  return models;
}

export async function refreshOpenRouterCatalog(trace?: string): Promise<OpenRouterCatalog> {
  const t0 = Date.now();

  try {
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const models = parseModelsResponse(await res.json());
    const catalog = buildCatalog(models);
    const fetchedAt = Date.now();

    memoryCatalog = catalog;
    memoryFetchedAt = fetchedAt;
    writeDiskCache(fetchedAt, models);

    logOp('openrouter_catalog', 'info', {
      trace,
      phase: 'refresh',
      source: 'fetch',
      url: CATALOG_URL,
      model_count: models.length,
      dur_ms: Date.now() - t0,
      cache_hit: false,
    });

    return catalog;
  } catch (err) {
    const disk = readDiskCache();
    if (disk) {
      const catalog = buildCatalog(disk.models);
      memoryCatalog = catalog;
      memoryFetchedAt = disk.fetched_at;

      logOp('openrouter_catalog', 'warn', {
        trace,
        phase: 'refresh',
        source: 'cache_fallback',
        model_count: catalog.size,
        dur_ms: Date.now() - t0,
        age_ms: Date.now() - disk.fetched_at,
        err: errMessage(err),
      });

      return catalog;
    }

    logOp('openrouter_catalog', 'error', {
      trace,
      phase: 'refresh',
      source: 'miss',
      dur_ms: Date.now() - t0,
      err: errMessage(err),
    });

    memoryCatalog = new Map();
    memoryFetchedAt = 0;
    return memoryCatalog;
  }
}

export async function getOpenRouterCatalog(trace?: string): Promise<OpenRouterCatalog> {
  const now = Date.now();

  if (memoryCatalog && now - memoryFetchedAt < TTL_MS) {
    logOp('openrouter_catalog', 'info', {
      trace,
      phase: 'lookup',
      source: 'memory',
      cache_hit: true,
      model_count: memoryCatalog.size,
    });
    return memoryCatalog;
  }

  if (!memoryCatalog) {
    const disk = readDiskCache();
    if (disk) {
      const catalog = buildCatalog(disk.models);
      memoryCatalog = catalog;
      memoryFetchedAt = disk.fetched_at;

      if (now - disk.fetched_at < TTL_MS) {
        logOp('openrouter_catalog', 'info', {
          trace,
          phase: 'lookup',
          source: 'disk',
          cache_hit: true,
          model_count: catalog.size,
        });
        return catalog;
      }
    }
  }

  return refreshOpenRouterCatalog(trace);
}
