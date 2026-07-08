import { describe, expect, it } from 'vitest';
import { boostKeywordsByVocab } from '../src/mc1/keywords.js';

const EPSILON = 1e-12;

function sumWeights(keywords: readonly { term: string; weight: number }[]): number {
  return keywords.reduce((sum, keyword) => sum + keyword.weight, 0);
}

describe('boostKeywordsByVocab', () => {
  it('gives in-vocab terms relatively more weight than out-of-vocab terms', () => {
    const input = [
      { term: 'typescript', weight: 0.4 },
      { term: 'graphql', weight: 0.4 },
      { term: 'cache', weight: 0.2 },
    ];

    const boosted = boostKeywordsByVocab(input, ['TypeScript']);
    const typescript = boosted.find(keyword => keyword.term === 'typescript');
    const graphql = boosted.find(keyword => keyword.term === 'graphql');

    expect(typescript?.weight).toBeGreaterThan(graphql?.weight ?? Number.NEGATIVE_INFINITY);
    expect(boosted).toHaveLength(input.length);
  });

  it('keeps out-of-vocab terms (boost-not-gate)', () => {
    const input = [
      { term: 'node_js', weight: 0.5 },
      { term: 'redis', weight: 0.3 },
      { term: 'grpc', weight: 0.2 },
    ];

    const boosted = boostKeywordsByVocab(input, ['node_js']);

    expect(boosted).toHaveLength(input.length);
    expect(boosted.map(keyword => keyword.term)).toEqual(input.map(keyword => keyword.term));
  });

  it('renormalizes output weights to sum to approximately 1', () => {
    const boosted = boostKeywordsByVocab(
      [
        { term: 'typescript', weight: 0.4 },
        { term: 'graphql', weight: 0.4 },
        { term: 'cache', weight: 0.2 },
      ],
      ['typescript', 'cache'],
    );

    expect(Math.abs(sumWeights(boosted) - 1)).toBeLessThan(EPSILON);
  });

  it('returns unchanged weights when vocabulary is empty', () => {
    const input = [
      { term: 'typescript', weight: 0.6 },
      { term: 'graphql', weight: 0.4 },
    ];

    const boosted = boostKeywordsByVocab(input, []);

    expect(boosted).toEqual(input);
    expect(Math.abs(sumWeights(boosted) - 1)).toBeLessThan(EPSILON);
  });

  it('matches vocab terms after normalization (case-insensitive)', () => {
    const boosted = boostKeywordsByVocab(
      [
        { term: 'Node_JS', weight: 0.5 },
        { term: 'postgres', weight: 0.5 },
      ],
      [' node_js '],
    );

    const node = boosted.find(keyword => keyword.term === 'Node_JS');
    const postgres = boosted.find(keyword => keyword.term === 'postgres');

    expect(node?.weight).toBeGreaterThan(postgres?.weight ?? Number.NEGATIVE_INFINITY);
  });
});
