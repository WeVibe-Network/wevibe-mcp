import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MODULE_PATH = '../src/openrouter-catalog.js';

let cacheDir = '';
let cachePath = '';

async function loadCatalogModule() {
  vi.resetModules();
  return import(MODULE_PATH);
}

function writeDiskCache(payload: unknown): void {
  writeFileSync(cachePath, JSON.stringify(payload), 'utf-8');
}

describe('openrouter-catalog', () => {
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'wevibe-openrouter-catalog-test-'));
    cachePath = join(cacheDir, 'openrouter-models.json');
    process.env.WEVIBE_OPENROUTER_MODELS_PATH = cachePath;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WEVIBE_OPENROUTER_MODELS_PATH;
    if (cacheDir) {
      rmSync(cacheDir, { recursive: true, force: true });
      cacheDir = '';
      cachePath = '';
    }
  });

  it('parseEndpointsResponse returns min context length across providers', async () => {
    const { parseEndpointsResponse } = await loadCatalogModule();

    const parsed = parseEndpointsResponse({
      data: {
        endpoints: [
          { context_length: 262144 },
          { context_length: 262144 },
          { context_length: 96000 },
          { context_length: 256000 },
        ],
      },
    });

    expect(parsed).toEqual({
      minContextLength: 96000,
      providerCount: 4,
    });
  });

  it('parseEndpointsResponse skips malformed and non-positive context lengths', async () => {
    const { parseEndpointsResponse } = await loadCatalogModule();

    const parsed = parseEndpointsResponse({
      data: {
        endpoints: [
          { context_length: 0 },
          { context_length: -100 },
          { context_length: '262144' },
          { context_length: null },
          { context_length: 96000 },
          {},
          'invalid',
        ],
      },
    });

    expect(parsed).toEqual({
      minContextLength: 96000,
      providerCount: 1,
    });
  });

  it('parseEndpointsResponse returns undefined for empty endpoints', async () => {
    const { parseEndpointsResponse } = await loadCatalogModule();

    expect(
      parseEndpointsResponse({
        data: { endpoints: [] },
      }),
    ).toBeUndefined();
  });

  it('parseEndpointsResponse returns undefined when data is missing', async () => {
    const { parseEndpointsResponse } = await loadCatalogModule();

    expect(parseEndpointsResponse({})).toBeUndefined();
    expect(parseEndpointsResponse({ data: {} })).toBeUndefined();
  });

  it('getModelMinContextWindow fetches endpoints and returns normalized slug + min window', async () => {
    const { getModelMinContextWindow } = await loadCatalogModule();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'moonshotai/kimi-k2.6',
            endpoints: [
              { context_length: 262144 },
              { context_length: 256000 },
              { context_length: 96000 },
              { context_length: 0 },
              { context_length: 'bad' },
            ],
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const result = await getModelMinContextWindow(' OpenRouter/MoonshotAI/Kimi-K2.6 ', 'unit-fetch-ok');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({
      slug: 'moonshotai/kimi-k2.6',
      minContextLength: 96000,
      providerCount: 3,
    });
  });

  it('getModelMinContextWindow returns undefined on 404', async () => {
    const { getModelMinContextWindow } = await loadCatalogModule();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const result = await getModelMinContextWindow('moonshotai/not-a-real-model', 'unit-404');
    expect(result).toBeUndefined();
  });

  it('getModelMinContextWindow returns undefined on network failure when no disk entry exists', async () => {
    const { getModelMinContextWindow } = await loadCatalogModule();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await getModelMinContextWindow('moonshotai/kimi-k2.6', 'unit-network-miss');
    expect(result).toBeUndefined();
  });

  it('getModelMinContextWindow falls back to fresh disk entry when fetch rejects', async () => {
    const { getModelMinContextWindow } = await loadCatalogModule();

    const normalizedSlug = 'moonshotai/kimi-k2.6';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      writeDiskCache({
        models: {
          [normalizedSlug]: {
            min_context_length: 96000,
            provider_count: 4,
            fetched_at: Date.now(),
          },
        },
      });
      throw new Error('network down after disk write');
    });

    const result = await getModelMinContextWindow(normalizedSlug, 'unit-network-fallback');
    expect(result).toEqual({
      slug: normalizedSlug,
      minContextLength: 96000,
      providerCount: 4,
    });
  });
});
