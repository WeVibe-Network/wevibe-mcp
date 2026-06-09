import { describe, expect, it } from 'vitest';
import { buildNeedCard } from '../src/retrieval-card.js';
import { buildQueryHarvest } from '../src/retrieve-cli.js';

describe('buildQueryHarvest', () => {
  it('builds a sparse harvest from query-only input', () => {
    const harvest = buildQueryHarvest({ query: 'How do I fix redis timeout retries?' });

    expect(harvest).toEqual({
      task: 'How do I fix redis timeout retries?',
    });

    const needCard = buildNeedCard(harvest);
    expect(needCard).toContain('Intent: unknown');
    expect(needCard).toContain('Task: How do I fix redis timeout retries?');
  });

  it('maps available query signals into NeedHarvest fields', () => {
    const harvest = buildQueryHarvest({
      query: 'fallback query text',
      intent: 'Stabilize CI cache integration',
      task: 'Fix redis reconnect backoff',
      language: 'TypeScript',
      stack: ['Node.js'],
      technologies: ['Redis', 'TypeScript'],
      frameworks: ['Vitest'],
      deps: ['ioredis'],
      errorStrings: ['ECONNREFUSED'],
      recentActivity: ['socket timeout'],
      files: ['src/cache.ts', 'tests/cache.test.ts'],
    });

    expect(harvest).toEqual({
      intent: 'Stabilize CI cache integration',
      task: 'Fix redis reconnect backoff',
      language: 'TypeScript',
      stack: ['Node.js', 'Redis', 'TypeScript'],
      frameworks: ['Vitest'],
      deps: ['ioredis'],
      errorStrings: ['ECONNREFUSED', 'socket timeout'],
      files: ['src/cache.ts', 'tests/cache.test.ts'],
    });

    const needCard = buildNeedCard(harvest);
    expect(needCard).toContain('Task: Fix redis reconnect backoff');
    expect(needCard).toContain('Stack: Node.js, Redis, TypeScript');
    expect(needCard).toContain('Errors: ECONNREFUSED, socket timeout');
  });

  it('uses description as task when dedicated task is absent', () => {
    const harvest = buildQueryHarvest({
      query: 'fallback query text',
      description: 'Investigate flaky reconnect tests',
    });

    expect(harvest).toEqual({
      task: 'Investigate flaky reconnect tests',
    });
  });
});
