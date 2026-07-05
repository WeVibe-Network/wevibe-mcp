import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeSlug } from '../../src/model-context.js';

const MODULE_PATH = '../../src/openrouter-catalog.js';

let cacheDir = '';

function isLikelyNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('fetch failed')
    || lower.includes('network')
    || lower.includes('enotfound')
    || lower.includes('eai_again')
    || lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('ecconnrefused')
    || lower.includes('econnrefused')
  );
}

async function loadCatalogModule() {
  vi.resetModules();
  return import(MODULE_PATH);
}

describe('openrouter-catalog integration', () => {
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'wevibe-openrouter-catalog-integration-'));
    process.env.WEVIBE_OPENROUTER_MODELS_PATH = join(cacheDir, 'openrouter-models.json');
  });

  afterEach(() => {
    delete process.env.WEVIBE_OPENROUTER_MODELS_PATH;
    if (cacheDir) {
      rmSync(cacheDir, { recursive: true, force: true });
      cacheDir = '';
    }
  });

  it('refreshOpenRouterCatalog fetches live catalog containing kimi-k2.6 context length', async () => {
    try {
      const { refreshOpenRouterCatalog } = await loadCatalogModule();
      const catalog = await refreshOpenRouterCatalog('integration-openrouter-catalog');

      if (catalog.size === 0) {
        console.warn(
          '[openrouter-catalog.integration] live fetch returned empty catalog; likely network unavailable/unreachable, skipping hard assertion',
        );
        return;
      }

      const kimi = catalog.get(normalizeSlug('moonshotai/kimi-k2.6'));
      expect(kimi).toBeDefined();
      expect(kimi?.contextLength).toBe(262144);
    } catch (err) {
      if (isLikelyNetworkError(err)) {
        console.warn(
          `[openrouter-catalog.integration] network unavailable, skipping hard failure: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      throw err;
    }
  });
});
