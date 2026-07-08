import { describe, expect, it } from 'vitest';
import {
  MC_VERSION,
  Mc1WriteEnvelopeSchema,
  isValidMc1WriteEnvelope,
  validateMc1WriteEnvelope,
} from '../src/mc1/schema.js';
import {
  MAX_KEYWORDS_PER_MEMORY,
  constrainKeywordsToVocab,
} from '../src/mc1/keywords.js';
import { relativizePath, scrubPaths } from '../src/mc1/paths.js';

describe('MC-1 write envelope schema', () => {
  const fullEnvelope = {
    mc_version: MC_VERSION,
    org_id: 'org_123',
    language: ['typescript'],
    deps: ['zod'],
    paths: ['src/mc1/schema.ts'],
    symbols: ['validateMc1WriteEnvelope'],
    keywords: ['memory', 'schema'],
  };

  it('accepts a fully populated valid envelope', () => {
    expect(() => validateMc1WriteEnvelope(fullEnvelope)).not.toThrow();
    expect(isValidMc1WriteEnvelope(fullEnvelope)).toBe(true);
  });

  it('rejects missing org_id', () => {
    const { org_id: _orgId, ...withoutOrgId } = fullEnvelope;
    expect(Mc1WriteEnvelopeSchema.safeParse(withoutOrgId).success).toBe(false);
  });

  it('requires mc_version literal 1', () => {
    expect(Mc1WriteEnvelopeSchema.safeParse({ ...fullEnvelope, mc_version: 2 }).success).toBe(false);
  });

  it('accepts missing optional arrays and empty keywords', () => {
    const minimalEnvelope = {
      mc_version: MC_VERSION,
      org_id: 'org_123',
      keywords: [],
    };

    expect(validateMc1WriteEnvelope(minimalEnvelope)).toEqual(minimalEnvelope);
  });
});

describe('constrainKeywordsToVocab', () => {
  it('drops out-of-vocab terms, lowercases, dedupes, and enforces keyword pattern', () => {
    const constrained = constrainKeywordsToVocab(
      [' GOOD_TERM1 ', 'good_term1', 'Bad-Term', 'another', 'MISSING', 'THIRD_TERM'],
      ['good_term1', 'another', 'third_term'],
    );

    expect(constrained).toEqual(['good_term1', 'another', 'third_term']);
  });

  it('caps output at MAX_KEYWORDS_PER_MEMORY', () => {
    const vocabulary = Array.from({ length: MAX_KEYWORDS_PER_MEMORY + 5 }, (_value, index) => `kw${index}`);
    const candidates = vocabulary.map(term => term.toUpperCase());

    const constrained = constrainKeywordsToVocab(candidates, vocabulary);
    expect(constrained).toEqual(vocabulary.slice(0, MAX_KEYWORDS_PER_MEMORY));
    expect(constrained).toHaveLength(MAX_KEYWORDS_PER_MEMORY);
  });
});

describe('relativizePath and scrubPaths', () => {
  it('relativizes unix paths with root', () => {
    expect(
      relativizePath('/Users/jerry/wevibe/src/foo.ts', {
        root: '/Users/jerry/wevibe',
      }),
    ).toBe('src/foo.ts');
  });

  it('relativizes /Users paths under provided root', () => {
    expect(
      relativizePath('/Users/jerry/proj/src/x.ts', {
        root: '/Users/jerry/proj',
      }),
    ).toBe('src/x.ts');
  });

  it('strips slash-less capital Users prefix without leaking username', () => {
    const result = relativizePath('Users/jerry/proj/src/x.ts');
    expect(result).toBe('proj/src/x.ts');
    expect(result).not.toContain('jerry');
  });

  it('keeps mid-path lowercase users directory unchanged', () => {
    expect(relativizePath('src/users/list.ts')).toBe('src/users/list.ts');
  });

  it('keeps leading lowercase users directory unchanged', () => {
    expect(relativizePath('users/list.ts')).toBe('users/list.ts');
  });

  it('scrubs identity-bearing unix paths without root', () => {
    const result = relativizePath('/Users/jerry/wevibe/src/foo.ts');
    expect(result).toBe('wevibe/src/foo.ts');
    expect(result).not.toContain('/Users/jerry');
    expect(result).not.toMatch(/(^|\/)(Users|home)\/jerry(\/|$)/i);
  });

  it('relativizes windows home paths', () => {
    expect(relativizePath('C:\\Users\\jerry\\proj\\a.ts')).toBe('proj/a.ts');
  });

  it('returns null for unrelativizable identity-bearing leftovers', () => {
    expect(relativizePath('ssh://host/Users/jerry/secrets.txt')).toBeNull();
  });

  it('scrubPaths dedupes and drops null/empty results', () => {
    const scrubbed = scrubPaths(
      [
        '/Users/jerry/wevibe/src/foo.ts',
        '/Users/jerry/wevibe/src/foo.ts',
        'ssh://host/Users/jerry/secrets.txt',
        '',
        'C:\\Users\\jerry\\proj\\a.ts',
        'C:\\Users\\jerry\\proj\\a.ts',
      ],
      { root: '/Users/jerry/wevibe' },
    );

    expect(scrubbed).toEqual(['src/foo.ts', 'proj/a.ts']);
  });
});
