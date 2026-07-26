import { describe, expect, it } from 'vitest';
import { buildNeedCard, buildPromptDigest } from '../src/retrieval-card.js';
import { buildKeywordDescription, buildQueryHarvest } from '../src/retrieve-cli.js';
import type { RetrieveInput } from '../src/retrieve-types.js';

describe('buildKeywordDescription', () => {
  it('matches pre-change behavior when task is absent', () => {
    const input: RetrieveInput = {
      query: 'fix cache timeout',
      description: 'Investigate redis reconnect strategy',
    };

    expect(buildKeywordDescription(input, ['Node.js', 'Redis'])).toBe(
      'fix cache timeout Investigate redis reconnect strategy Node.js Redis',
    );
  });

  it('includes task when present and distinct', () => {
    const input: RetrieveInput = {
      query: 'fix cache timeout',
      description: 'Investigate redis reconnect strategy',
      task: 'Patch retry jitter bug in reconnect loop',
    };

    expect(buildKeywordDescription(input, ['Node.js', 'Redis'])).toBe(
      'fix cache timeout Investigate redis reconnect strategy Patch retry jitter bug in reconnect loop Node.js Redis',
    );
  });

  it('does not double-count task when it matches query after trim', () => {
    const input: RetrieveInput = {
      query: 'fix cache timeout',
      task: '  fix cache timeout  ',
    };

    expect(buildKeywordDescription(input, [])).toBe('fix cache timeout');
  });

  it('does not double-count task when it matches description after trim', () => {
    const input: RetrieveInput = {
      query: 'fix cache timeout',
      description: 'Investigate redis reconnect strategy',
      task: '  Investigate redis reconnect strategy  ',
    };

    expect(buildKeywordDescription(input, [])).toBe('fix cache timeout Investigate redis reconnect strategy');
  });

  it('skips empty or whitespace-only task values', () => {
    const input: RetrieveInput = {
      query: 'fix cache timeout',
      description: 'Investigate redis reconnect strategy',
      task: '   ',
    };

    expect(buildKeywordDescription(input, ['Node.js'])).toBe(
      'fix cache timeout Investigate redis reconnect strategy Node.js',
    );
  });

  it('includes task when query and description are absent', () => {
    const input: RetrieveInput = {
      query: '   ',
      description: '   ',
      task: 'Patch retry jitter bug in reconnect loop',
    };

    expect(buildKeywordDescription(input, [])).toBe('Patch retry jitter bug in reconnect loop');
  });
});

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
      buildFailing: true,
      testFailing: false,
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
      buildFailing: true,
      testFailing: false,
      files: ['src/cache.ts', 'tests/cache.test.ts'],
    });

    const needCard = buildNeedCard(harvest);
    expect(needCard).toContain('Task: Fix redis reconnect backoff');
    expect(needCard).toContain('Stack: Node.js, Redis, TypeScript');
    expect(needCard).toContain('Errors: ECONNREFUSED, socket timeout');
    expect(needCard).toContain('Build: failing');
    expect(needCard).toContain('Tests: ok');
  });

  it('drops non-boolean build/test failing values to undefined', () => {
    const harvest = buildQueryHarvest({
      query: 'fallback query text',
      buildFailing: 'yes',
      testFailing: 1,
    } as unknown as RetrieveInput);

    expect(harvest.buildFailing).toBeUndefined();
    expect(harvest.testFailing).toBeUndefined();
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
