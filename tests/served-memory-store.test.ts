import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readUsedMemoryTexts } from '../src/served-memory-store.js';

const TEST_DIR = join(tmpdir(), `wevibe-test-served-memory-store-${Date.now()}`);
const TEST_FILE = join(TEST_DIR, 'served-memories.json');

function cleanup(): void {
  try {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    if (existsSync(TEST_DIR)) rmdirSync(TEST_DIR);
  } catch { }
}

describe('served-memory-store', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.WEVIBE_SERVED_MEMORIES_PATH = TEST_FILE;
  });

  afterEach(() => {
    cleanup();
    delete process.env.WEVIBE_SERVED_MEMORIES_PATH;
  });

  it('returns [] when store file does not exist', () => {
    expect(readUsedMemoryTexts('session-1')).toEqual([]);
  });

  it('returns deterministic deduped texts for matching session records', () => {
    writeFileSync(
      TEST_FILE,
      JSON.stringify({
        version: 1,
        memories: {
          'b-cid': {
            cid: 'b-cid',
            text: 'beta memory',
            session_ids: ['session-1'],
            last_used_at: 1000,
          },
          'a-cid': {
            cid: 'a-cid',
            text: 'alpha memory',
            session_ids: ['session-1'],
            last_used_at: 1000,
          },
          'c-cid': {
            cid: 'c-cid',
            text: 'ignored memory',
            session_ids: ['session-2'],
            last_used_at: 2000,
          },
        },
      }),
    );

    expect(readUsedMemoryTexts('session-1')).toEqual(['alpha memory', 'beta memory']);
  });

  it('returns [] for malformed json and never throws', () => {
    writeFileSync(TEST_FILE, '{not-json');
    expect(() => readUsedMemoryTexts('session-1')).not.toThrow();
    expect(readUsedMemoryTexts('session-1')).toEqual([]);
  });

  it('dedupes duplicate text appearing under multiple cids', () => {
    writeFileSync(
      TEST_FILE,
      JSON.stringify({
        version: 1,
        memories: {
          'cid-new': {
            cid: 'cid-new',
            text: 'shared text',
            session_ids: ['session-1'],
            last_used_at: 2000,
          },
          'cid-old': {
            cid: 'cid-old',
            text: 'shared text',
            session_ids: ['session-1'],
            last_used_at: 1000,
          },
        },
      }),
    );

    expect(readUsedMemoryTexts('session-1')).toEqual(['shared text']);
  });

  it('returns [] when sessionId is empty', () => {
    writeFileSync(
      TEST_FILE,
      JSON.stringify({
        version: 1,
        memories: {
          'any-cid': {
            cid: 'any-cid',
            text: 'any text',
            session_ids: ['session-1'],
            last_used_at: 1,
          },
        },
      }),
    );

    expect(readUsedMemoryTexts('')).toEqual([]);
  });
});
