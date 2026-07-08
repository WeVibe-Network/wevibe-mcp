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
    it('passes through remote min-across-providers window for kimi-k2.6', () => {
      expect(resolveContextWindow({ slug: 'moonshotai/kimi-k2.6', isLocal: false, remoteMinWindow: 96000 })).toBe(96000);
    });

    it('throws ContextWindowResolutionError for remote models with missing min window (fail-closed)', () => {
      const slug = 'foo/does-not-exist';
      const resolveUnknown = () => resolveContextWindow({ slug, isLocal: false, remoteMinWindow: undefined });

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

    it('throws for non-positive remote min windows (fail-closed)', () => {
      expect(() => resolveContextWindow({ slug: 'bad/model', isLocal: false, remoteMinWindow: 0 })).toThrow(
        ContextWindowResolutionError,
      );
      expect(() => resolveContextWindow({ slug: 'bad/model', isLocal: false, remoteMinWindow: -1 })).toThrow(
        ContextWindowResolutionError,
      );
    });

    it('keeps local behavior: num_ctx hint when present, safe default otherwise', () => {
      expect(resolveContextWindow({ slug: 'local/whatever', isLocal: true, numCtxHint: 262144 })).toBe(262144);
      expect(resolveContextWindow({ slug: 'x', isLocal: true })).toBe(DEFAULT_CONTEXT_WINDOW);
    });

    it('accepts normalized openrouter-prefixed slugs when remote window is supplied upstream', () => {
      expect(resolveContextWindow({
        slug: 'openrouter/minimax/minimax-m3',
        isLocal: false,
        remoteMinWindow: 524288,
      })).toBe(524288);
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
      expect(chunkRoomChars(525000, 60000, 15000)).toBe(450000);
      expect(chunkRoomChars(1000, 400, 700)).toBeLessThanOrEqual(0);
      expect(chunkRoomChars(1000, 400, 700)).toBe(-100);
    });
  });
});
