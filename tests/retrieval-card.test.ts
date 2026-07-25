import { describe, it, expect } from 'vitest';
import {
  parseMemoryText,
  buildRetrievalCard,
  buildNeedCard,
  type StructuredMemory,
} from '../src/retrieval-card.js';

describe('retrieval-card formatting', () => {
  it('parses a plain string with no markers', () => {
    expect(parseMemoryText('  wevibe_author_memory  ')).toEqual({
      implement: 'wevibe_author_memory',
      context: '',
      dnd: null,
    });
  });

  it('builds retrieval card with dnd', () => {
    const memory: StructuredMemory = {
      implement: '  Use signed URLs for uploads.  ',
      context: '  user-generated file intake  ',
      dnd: '  Store raw blobs in public buckets.  ',
      stack: ['TypeScript', '', 'S3'],
    };

    expect(buildRetrievalCard(memory)).toBe([
      'Applies when: user-generated file intake',
      'Stack: TypeScript, S3',
      'Implement: Use signed URLs for uploads.',
      'Avoid: Store raw blobs in public buckets.',
    ].join('\n'));
  });

  it('builds retrieval card without dnd and unknown fallbacks', () => {
    const memory: StructuredMemory = {
      implement: '  Keep retry logic idempotent. ',
      context: '   ',
      dnd: null,
      stack: ['', '   '],
    };

    expect(buildRetrievalCard(memory)).toBe([
      'Applies when: unspecified',
      'Stack: unknown',
      'Implement: Keep retry logic idempotent.',
    ].join('\n'));
  });

  it('builds need card from full harvest', () => {
    const card = buildNeedCard({
      intent: 'Ship a safe upload path',
      task: 'Harden multipart ingest',
      language: 'TypeScript',
      stack: ['Node.js', 'Express'],
      frameworks: ['Vitest'],
      deps: ['busboy', 'zod'],
      errorStrings: ['LIMIT_FILE_SIZE'],
      buildFailing: true,
      testFailing: true,
      files: ['src/upload.ts', 'tests/upload.test.ts'],
    });

    expect(card).toBe([
      'Intent: Ship a safe upload path',
      'Task: Harden multipart ingest',
      'Language: TypeScript',
      'Stack: Node.js, Express',
      'Frameworks: Vitest',
      'Dependencies: busboy, zod',
      'Errors: LIMIT_FILE_SIZE',
      'Build: failing',
      'Tests: failing',
      'Files: src/upload.ts, tests/upload.test.ts',
    ].join('\n'));
  });

  it('renders build/test status as ok for false and unknown when absent', () => {
    const passingCard = buildNeedCard({
      task: 'Stabilize cache retries',
      buildFailing: false,
      testFailing: false,
    });

    const unknownCard = buildNeedCard({
      task: 'Stabilize cache retries',
    });

    expect(passingCard).toContain('Build: ok');
    expect(passingCard).toContain('Tests: ok');
    expect(unknownCard).toContain('Build: unknown');
    expect(unknownCard).toContain('Tests: unknown');
    expect(passingCard).not.toBe(unknownCard);
  });

  it('builds need card with unknown defaults for empty harvest', () => {
    expect(buildNeedCard({})).toBe([
      'Intent: unknown',
      'Task: unknown',
      'Language: unknown',
      'Stack: unknown',
      'Frameworks: unknown',
      'Dependencies: unknown',
      'Errors: unknown',
      'Build: unknown',
      'Tests: unknown',
      'Files: unknown',
    ].join('\n'));
  });

  it('changes deterministic need-card text when failure signals are present', () => {
    const withoutSignals = buildNeedCard({
      intent: 'Stabilize CI',
      task: 'Fix reconnect race',
      errorStrings: ['timeout after 30s'],
    });

    const withSignals = buildNeedCard({
      intent: 'Stabilize CI',
      task: 'Fix reconnect race',
      errorStrings: ['timeout after 30s'],
      buildFailing: true,
      testFailing: true,
    });

    expect(withoutSignals).not.toBe(withSignals);
    expect(withSignals).toContain('Build: failing');
    expect(withSignals).toContain('Tests: failing');
  });
});
