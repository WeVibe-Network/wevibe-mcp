import { describe, it, expect } from 'vitest';

import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW,
  EXTRACTION_BUDGET_FRACTION,
  MODEL_CONTEXT_WINDOWS,
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
    it('resolves known hosted slug from registry', () => {
      expect(resolveContextWindow('anthropic/claude-opus-4.8')).toBe(MODEL_CONTEXT_WINDOWS['anthropic/claude-opus']);
    });

    it('uses longest-prefix matching for versioned variants', () => {
      expect(resolveContextWindow('openrouter/minimax/minimax-m3-latest')).toBe(
        MODEL_CONTEXT_WINDOWS['minimax/minimax-m3'],
      );
    });

    it('returns hint for unknown models when hint is positive finite', () => {
      expect(resolveContextWindow('local/lm-studio-model', 262144)).toBe(262144);
    });

    it('returns default for unknown models without usable hint', () => {
      expect(resolveContextWindow('unknown/provider-model')).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(resolveContextWindow('unknown/provider-model', 0)).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(resolveContextWindow('unknown/provider-model', Number.POSITIVE_INFINITY)).toBe(DEFAULT_CONTEXT_WINDOW);
    });

    it('ignores hint when slug is in registry', () => {
      expect(resolveContextWindow('openai/gpt-5.3-codex', 8192)).toBe(MODEL_CONTEXT_WINDOWS['openai/gpt-5']);
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
