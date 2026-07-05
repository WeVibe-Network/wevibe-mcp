import { describe, it, expect } from 'vitest';

import {
  CHARS_PER_TOKEN,
  ContextWindowResolutionError,
  DEFAULT_CONTEXT_WINDOW,
  EXTRACTION_BUDGET_FRACTION,
  budgetChars,
  chunkRoomChars,
  fitsSinglePass,
  normalizeSlug,
  resolveMaxOutputTokens,
  resolveContextWindow,
} from '../src/model-context.js';

describe('model-context', () => {
  describe('normalizeSlug', () => {
    it('strips openrouter prefix and normalizes case/whitespace', () => {
      expect(normalizeSlug('  OpenRouter/Anthropic/Claude-Opus-4.8  ')).toBe('anthropic/claude-opus-4.8');
    });

    it('leaves non-openrouter provider/model shape intact after normalization', () => {
      expect(normalizeSlug(' OpenAI/GPT-5.3-CODEX ')).toBe('openai/gpt-5.3-codex');
    });
  });

  describe('resolveContextWindow', () => {
    const catalog = new Map([
      [
        'moonshotai/kimi-k2.6',
        {
          id: 'moonshotai/kimi-k2.6',
          contextLength: 262144,
          topProviderContextLength: 262144,
          maxCompletionTokens: 262144,
        },
      ],
      [
        'minimax/minimax-m3',
        {
          id: 'minimax/minimax-m3',
          contextLength: 1048576,
          topProviderContextLength: 524288,
          maxCompletionTokens: 524288,
        },
      ],
    ]);

    it('resolves remote kimi-k2.6 from catalog', () => {
      expect(resolveContextWindow({ slug: 'moonshotai/kimi-k2.6', isLocal: false, catalog })).toBe(262144);
    });

    it('resolves remote minimax-m3 to the smaller effective window and normalizes openrouter prefix', () => {
      expect(resolveContextWindow({ slug: 'minimax/minimax-m3', isLocal: false, catalog })).toBe(524288);
      expect(resolveContextWindow({ slug: 'openrouter/minimax/minimax-m3', isLocal: false, catalog })).toBe(524288);
    });

    it('throws ContextWindowResolutionError for unknown remote models (fail-closed)', () => {
      const slug = 'foo/does-not-exist';
      const resolveUnknown = () => resolveContextWindow({ slug, isLocal: false, catalog });

      expect(resolveUnknown).toThrow(ContextWindowResolutionError);

      let thrown: unknown;
      let resolved: number | undefined;
      try {
        resolved = resolveUnknown();
      } catch (error) {
        thrown = error;
      }

      expect(resolved).toBeUndefined();
      expect(resolved).not.toBe(DEFAULT_CONTEXT_WINDOW);
      expect(thrown).toBeInstanceOf(ContextWindowResolutionError);
      const err = thrown as ContextWindowResolutionError;
      expect(err.code).toBe('unknown_model_context');
      expect(err.message).toContain(slug);
    });

    it('keeps local behavior: num_ctx hint when present, safe default otherwise', () => {
      expect(resolveContextWindow({ slug: 'local/whatever', isLocal: true, numCtxHint: 262144 })).toBe(262144);
      expect(resolveContextWindow({ slug: 'x', isLocal: true })).toBe(DEFAULT_CONTEXT_WINDOW);
    });

    it('guards remote entries with missing/invalid windows', () => {
      const invalidCatalog = new Map([
        ['bad/model', { id: 'bad/model', contextLength: 0, topProviderContextLength: 0 }],
      ]);
      expect(() => resolveContextWindow({ slug: 'bad/model', isLocal: false, catalog: invalidCatalog })).toThrow(
        ContextWindowResolutionError,
      );

      const topOnlyCatalog = new Map([
        ['top/only', { id: 'top/only', topProviderContextLength: 123456 }],
      ]);
      expect(resolveContextWindow({ slug: 'top/only', isLocal: false, catalog: topOnlyCatalog })).toBe(123456);
    });
  });

  describe('resolveMaxOutputTokens', () => {
    const catalog = new Map([
      [
        'moonshotai/kimi-k2.6',
        {
          id: 'moonshotai/kimi-k2.6',
          contextLength: 262144,
          topProviderContextLength: 262144,
          maxCompletionTokens: 262144,
        },
      ],
      [
        'minimax/minimax-m3',
        {
          id: 'minimax/minimax-m3',
          contextLength: 1048576,
          topProviderContextLength: 524288,
          maxCompletionTokens: 524288,
        },
      ],
    ]);

    it('returns desired reserve when provider cap is higher', () => {
      expect(resolveMaxOutputTokens(4096, catalog.get('minimax/minimax-m3'))).toBe(4096);
    });

    it('caps to provider maxCompletionTokens when lower than desired reserve', () => {
      expect(resolveMaxOutputTokens(4096, { id: 'tiny/output', maxCompletionTokens: 1000 })).toBe(1000);
    });

    it('returns desired reserve when catalog entry is absent', () => {
      expect(resolveMaxOutputTokens(4096, undefined)).toBe(4096);
    });
  });

  describe('budget helpers', () => {
    it('computes character budget from token window', () => {
      expect(budgetChars(200000)).toBe(Math.floor(EXTRACTION_BUDGET_FRACTION * 200000 * CHARS_PER_TOKEN));
      expect(budgetChars(200000)).toBe(525000);
    });

    it('checks single-pass fit with inclusive boundary', () => {
      expect(fitsSinglePass(300000, 20000, 5000, 325000)).toBe(true);
      expect(fitsSinglePass(300001, 20000, 5000, 325000)).toBe(false);
    });

    it('computes chunk room, including exhausted/negative room', () => {
      expect(chunkRoomChars(525000, 60000, 100000, 15000)).toBe(350000);
      expect(chunkRoomChars(1000, 400, 500, 200)).toBeLessThanOrEqual(0);
      expect(chunkRoomChars(1000, 400, 500, 200)).toBe(-100);
    });
  });
});
