import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'wevibe-test-blacklist-' + Date.now());
const TEST_FILE = join(TEST_DIR, 'blacklist.json');

import { is_blacklisted, add_to_blacklist } from '../src/blacklist.js';

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

});
