import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'wevibe-test-blacklist-' + Date.now());
const TEST_FILE = join(TEST_DIR, 'blacklist.json');

import { is_blacklisted, add_to_blacklist, filter_blacklisted, get_blacklist } from '../src/blacklist.js';

function cleanup() {
  try {
    if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE);
    if (existsSync(TEST_DIR)) rmdirSync(TEST_DIR);
  } catch { }
}

describe('blacklist', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.WEVIBE_BLACKLIST_PATH = TEST_FILE;
  });

  afterEach(() => {
    cleanup();
    delete process.env.WEVIBE_BLACKLIST_PATH;
  });

  it('is_blacklisted returns false for non-existent entry', () => {
    const result = is_blacklisted('abc-123');
    expect(result).toBe(false);
  });

  it('add_to_blacklist returns true for new entry', () => {
    const result = add_to_blacklist('abc-123');
    expect(result).toBe(true);
  });

  it('is_blacklisted returns true after adding', () => {
    add_to_blacklist('abc-123');
    expect(is_blacklisted('abc-123')).toBe(true);
  });

  it('add_to_blacklist returns false for duplicate', () => {
    add_to_blacklist('abc-123');
    const result = add_to_blacklist('abc-123');
    expect(result).toBe(false);
  });

  it('filter_blacklisted removes blacklisted entries', () => {
    add_to_blacklist('bad-1');
    const memories = [
      { pack_id: 'good-1', task: 'ok' },
      { pack_id: 'bad-1', task: 'nope' },
      { pack_id: 'good-2', task: 'ok' },
    ];
    const filtered = filter_blacklisted(memories);
    expect(filtered.length).toBe(2);
    expect(filtered.every((m) => m.pack_id !== 'bad-1')).toBe(true);
  });

  it('filter_blacklisted returns all when none blacklisted', () => {
    const memories = [{ pack_id: 'a' }, { pack_id: 'b' }];
    const filtered = filter_blacklisted(memories);
    expect(filtered.length).toBe(2);
  });

  it('get_blacklist returns all entries', () => {
    add_to_blacklist('entry-1');
    add_to_blacklist('entry-2');
    const list = get_blacklist();
    expect(list).toContain('entry-1');
    expect(list).toContain('entry-2');
  });
});
