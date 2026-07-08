import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  it('getModelMinContextWindow fetches live min context length for kimi-k2.6', async () => {
    try {
      const { getModelMinContextWindow } = await loadCatalogModule();
      const result = await getModelMinContextWindow('moonshotai/kimi-k2.6', 'integration-openrouter-endpoints');

      if (!result) {
        console.warn(
          '[openrouter-catalog.integration] live fetch unavailable (or model temporarily inaccessible), skipping hard assertion',
        );
        return;
      }

      expect(result.slug).toBe('moonshotai/kimi-k2.6');
      expect(result.minContextLength).toBeGreaterThan(0);
      expect(result.minContextLength).toBeLessThanOrEqual(262144);
      expect(result.providerCount).toBeGreaterThanOrEqual(1);
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
