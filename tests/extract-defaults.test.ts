import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTRACTION_NUM_CTX,
  DEFAULT_EXTRACTION_PROMPT,
  getExtractionPrompt,
} from '../src/extraction.js';

describe('extraction defaults', () => {
  it('returns the default prompt when WEVIBE_EXTRACTION_PROMPT is unset', () => {
    const previous = process.env.WEVIBE_EXTRACTION_PROMPT;
    delete process.env.WEVIBE_EXTRACTION_PROMPT;

    try {
      const prompt = getExtractionPrompt();
      expect(prompt).toBeTypeOf('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toBe(DEFAULT_EXTRACTION_PROMPT);
    } finally {
      if (previous === undefined) {
        delete process.env.WEVIBE_EXTRACTION_PROMPT;
      } else {
        process.env.WEVIBE_EXTRACTION_PROMPT = previous;
      }
    }
  });

  it('exports the canonical default num_ctx', () => {
    expect(DEFAULT_EXTRACTION_NUM_CTX).toBe(32768);
  });
});
