import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getProviderPolicy, setProviderPolicy } from '../src/risk-appetite.js';

const TEST_DIR = join(homedir(), '.wevibe-test-co242');
const TEST_CONFIG = join(TEST_DIR, 'plugin-config.json');

const ORIG_CONFIG = join(homedir(), '.wevibe', 'plugin-config.json');

describe('provider-policy', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_CONFIG)) unlinkSync(TEST_CONFIG);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns unrestricted when file does not exist', () => {
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      expect(getProviderPolicy()).toBe('unrestricted');
    } finally {
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('returns unrestricted when file has unrelated content', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ unrelated: true }));
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      writeFileSync(ORIG_CONFIG, JSON.stringify({ unrelated: true }));
      expect(getProviderPolicy()).toBe('unrestricted');
    } finally {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('returns local_only when explicitly set', () => {
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      setProviderPolicy('local_only');
      expect(getProviderPolicy()).toBe('local_only');
    } finally {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('returns allowlist when explicitly set', () => {
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      setProviderPolicy('allowlist');
      expect(getProviderPolicy()).toBe('allowlist');
    } finally {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('rejects invalid value', () => {
    expect(() => (setProviderPolicy as (v: string) => void)('invalid')).toThrow();
    expect(() => (setProviderPolicy as (v: string) => void)('')).toThrow();
  });
});
