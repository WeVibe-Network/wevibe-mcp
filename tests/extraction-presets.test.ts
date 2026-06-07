import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACTION_PROMPT } from '../src/extraction.js';
import {
  EXTRACTION_PRESETS,
  RECOMMENDED_PRESET_ID,
  getRecommendedPreset,
} from '../src/extraction-presets.js';

describe('extraction presets', () => {
  it('exports the expected preset ids and a single recommended preset', () => {
    expect(EXTRACTION_PRESETS).toHaveLength(3);
    expect(EXTRACTION_PRESETS.map(p => p.id)).toEqual([
      'factual-strict',
      'guardrail-max',
      'balanced-reliable',
    ]);

    const recommendedPresets = EXTRACTION_PRESETS.filter(p => p.recommended);
    expect(recommendedPresets).toHaveLength(1);
    expect(recommendedPresets[0].id).toBe(RECOMMENDED_PRESET_ID);
  });

  it('ensures each preset prompt is bounded and uses converged provenance-first structure', () => {
    for (const preset of EXTRACTION_PRESETS) {
      expect(preset.system_prompt.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(preset.system_prompt, 'utf8')).toBeLessThan(12000);
      expect(preset.system_prompt).toContain('PROVENANCE');
      expect(preset.system_prompt).toContain('because');
      expect(preset.system_prompt).toContain('memory_type');
      expect(preset.system_prompt).toContain('preference_confidence');
      expect(preset.system_prompt).toContain('EXACTLY one of 0.0, 0.2, 0.5, 0.8');

      expect(preset.system_prompt.startsWith('You are')).toBe(true);

      const gatesIndex = preset.system_prompt.indexOf('HOW TO SELECT MEMORIES.');
      const exemplarIndex = preset.system_prompt.indexOf('EXAMPLE. Transcript:');
      const contractIndex = preset.system_prompt.indexOf('Output ONLY a JSON array.');

      expect(gatesIndex).toBeGreaterThan(0);
      expect(exemplarIndex).toBeGreaterThan(gatesIndex);
      expect(contractIndex).toBeGreaterThan(exemplarIndex);
    }
  });

  it('keeps the default extraction prompt pinned to the recommended preset', () => {
    expect(DEFAULT_EXTRACTION_PROMPT).toBe(getRecommendedPreset().system_prompt);
  });
});
