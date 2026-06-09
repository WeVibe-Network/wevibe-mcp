import { describe, it, expect, vi } from 'vitest';
import {
  serializeMemoryText,
  parseMemoryText,
  buildRetrievalCard,
  buildNeedCard,
  buildAnticipatedNeed,
  type StructuredMemory,
} from '../src/retrieval-card.js';

describe('retrieval-card formatting', () => {
  it('serializes and parses memory text with implement/context/dnd', () => {
    const memory = {
      implement: 'Use explicit allowlists.',
      context: 'When handling partner webhooks.',
      dnd: 'Trust wildcard origins.',
    };

    const serialized = serializeMemoryText(memory);
    expect(serialized).toBe("Use explicit allowlists.\n\nContext: When handling partner webhooks.\n\nDon't: Trust wildcard origins.");

    expect(parseMemoryText(serialized)).toEqual({
      implement: 'Use explicit allowlists.',
      context: 'When handling partner webhooks.',
      dnd: 'Trust wildcard origins.',
    });
  });

  it('serializes and parses memory text with implement/context only', () => {
    const serialized = serializeMemoryText({
      implement: 'Pin exact API versions.',
      context: 'When integrating vendor SDKs.',
    });

    expect(serialized).toBe('Pin exact API versions.\n\nContext: When integrating vendor SDKs.');
    expect(parseMemoryText(serialized)).toEqual({
      implement: 'Pin exact API versions.',
      context: 'When integrating vendor SDKs.',
      dnd: null,
    });
  });

  it('serializes and parses memory text with implement only', () => {
    const serialized = serializeMemoryText({ implement: 'Run schema migrations before deploy.' });

    expect(serialized).toBe('Run schema migrations before deploy.');
    expect(parseMemoryText(serialized)).toEqual({
      implement: 'Run schema migrations before deploy.',
      context: '',
      dnd: null,
    });
  });

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
      'Files: src/upload.ts, tests/upload.test.ts',
    ].join('\n'));
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
      'Files: unknown',
    ].join('\n'));
  });

  it('builds anticipated need from first non-empty chat line', async () => {
    const fakeChat = vi.fn(async () => '  The situation.\nextra\n');
    const memory: StructuredMemory = {
      implement: 'Use optimistic locking.',
      context: 'Concurrent writes to profile rows.',
      dnd: 'Blind last-write-wins updates.',
      stack: ['PostgreSQL'],
    };

    const anticipated = await buildAnticipatedNeed(memory, fakeChat);
    expect(anticipated).toBe('The situation.');
  });
});
