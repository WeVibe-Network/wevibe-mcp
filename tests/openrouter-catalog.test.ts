import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeSlug } from '../src/model-context.js';

const MODULE_PATH = '../src/openrouter-catalog.js';

let cacheDir = '';

async function loadCatalogModule() {
  vi.resetModules();
  return import(MODULE_PATH);
}

describe('openrouter-catalog', () => {
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'wevibe-openrouter-catalog-test-'));
    process.env.WEVIBE_OPENROUTER_MODELS_PATH = join(cacheDir, 'openrouter-models.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WEVIBE_OPENROUTER_MODELS_PATH;
    if (cacheDir) {
      rmSync(cacheDir, { recursive: true, force: true });
      cacheDir = '';
    }
  });

  it('parseModelsResponse maps valid entries and skips malformed elements', async () => {
    const { parseModelsResponse } = await loadCatalogModule();

    const parsed = parseModelsResponse({
      data: [
        {
          id: 'moonshotai/kimi-k2.6',
          context_length: 262144,
          top_provider: {
            context_length: 262144,
            max_completion_tokens: 262144,
          },
        },
        {
          id: 'minimax/minimax-m3',
          context_length: 1048576,
          top_provider: {
            context_length: 524288,
          },
        },
        {
          context_length: 999,
        },
      ],
    });

    expect(parsed).toHaveLength(2);

    const kimi = parsed.find((entry) => entry.id === 'moonshotai/kimi-k2.6');
    expect(kimi).toEqual({
      id: 'moonshotai/kimi-k2.6',
      contextLength: 262144,
      topProviderContextLength: 262144,
      maxCompletionTokens: 262144,
    });

    const minimax = parsed.find((entry) => entry.id === 'minimax/minimax-m3');
    expect(minimax).toEqual({
      id: 'minimax/minimax-m3',
      contextLength: 1048576,
      topProviderContextLength: 524288,
      maxCompletionTokens: undefined,
    });
  });

  it('refreshOpenRouterCatalog fetches and returns normalized map keys', async () => {
    const { refreshOpenRouterCatalog } = await loadCatalogModule();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'moonshotai/kimi-k2.6',
              context_length: 262144,
              top_provider: {
                context_length: 262144,
                max_completion_tokens: 262144,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const catalog = await refreshOpenRouterCatalog('unit-refresh');
    expect(catalog.get(normalizeSlug('moonshotai/kimi-k2.6'))).toEqual({
      id: 'moonshotai/kimi-k2.6',
      contextLength: 262144,
      topProviderContextLength: 262144,
      maxCompletionTokens: 262144,
    });
  });

  it('returns empty map when fetch fails and no disk cache exists', async () => {
    const { refreshOpenRouterCatalog } = await loadCatalogModule();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const catalog = await refreshOpenRouterCatalog('unit-failure');
    expect(catalog).toBeInstanceOf(Map);
    expect(catalog.size).toBe(0);
  });
});
