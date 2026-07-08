import { describe, expect, it } from 'vitest';
import { buildNeedCard, buildPromptDigest } from '../src/retrieval-card.js';
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

  it('buildPromptDigest keeps intent/task prose and excludes identifier soup', () => {
    const harvest = buildQueryHarvest({
      query: 'fallback query text',
      intent: 'Stabilize inbound webhook retries',
      task: 'Investigate queue race causing duplicate retry scheduling',
      stack: ['react'],
      frameworks: ['nextjs'],
      deps: ['lodash-uniquedep'],
      files: ['/Users/x/proj/secret-file.ts'],
      errorStrings: ['TypeError-uniquetok'],
    });

    const digest = buildPromptDigest(harvest);

    expect(digest).toContain('Stabilize inbound webhook retries');
    expect(digest).toContain('Investigate queue race causing duplicate retry scheduling');
    expect(digest).not.toContain('lodash-uniquedep');
    expect(digest).not.toContain('secret-file.ts');
    expect(digest).not.toContain('nextjs');
    expect(digest).not.toContain('TypeError-uniquetok');
    expect(digest).not.toContain('react');
  });
});
