import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getRiskAppetite, setRiskAppetite, type RiskAppetite } from '../src/risk-appetite.js';

const TEST_DIR = join(homedir(), '.wevibe-test-co242');
const TEST_CONFIG = join(TEST_DIR, 'plugin-config.json');

const ORIG_CONFIG = join(homedir(), '.wevibe', 'plugin-config.json');

describe('risk-appetite', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_CONFIG)) unlinkSync(TEST_CONFIG);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns neutral when file does not exist', () => {
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      expect(getRiskAppetite()).toBe('neutral');
    } finally {
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('returns neutral when file has unrelated content', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ unrelated: true }));
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      writeFileSync(ORIG_CONFIG, JSON.stringify({ unrelated: true }));
      expect(getRiskAppetite()).toBe('neutral');
    } finally {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('returns lowest when explicitly set', () => {
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      setRiskAppetite('lowest');
      expect(getRiskAppetite()).toBe('lowest');
    } finally {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('returns neutral when explicitly set', () => {
    const backup = existsSync(ORIG_CONFIG) ? readFileSync(ORIG_CONFIG, 'utf-8') : null;
    try {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      setRiskAppetite('neutral');
      expect(getRiskAppetite()).toBe('neutral');
    } finally {
      if (existsSync(ORIG_CONFIG)) unlinkSync(ORIG_CONFIG);
      if (backup !== null) writeFileSync(ORIG_CONFIG, backup);
    }
  });

  it('rejects invalid value', () => {
    expect(() => (setRiskAppetite as (v: string) => void)('invalid')).toThrow();
    expect(() => (setRiskAppetite as (v: string) => void)('')).toThrow();
  });
});
