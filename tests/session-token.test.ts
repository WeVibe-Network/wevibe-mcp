import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTokenStore } from '../src/session-token.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testPath = join(tmpdir(), `wevibe-mcp-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

describe('session-token', () => {
  beforeEach(() => {
    testStore._reset();
  });

  it('init writes a 64-char hex token to the token path', async () => {
    await testStore.init();
    const written = await readFile(testPath, 'utf-8');
    expect(written).toMatch(/^[a-f0-9]{64}$/);
  });

  it('init writes file with mode 0600', async () => {
    await testStore.init();
    const s = await stat(testPath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('init reuses the persisted token on re-init (stable across instances)', async () => {
    await testStore.init();
    const first = await readFile(testPath, 'utf-8');
    await testStore.init();
    const second = await readFile(testPath, 'utf-8');

    expect(second).toBe(first);

    const secondStore = new SessionTokenStore(testPath);
    await secondStore.init();
    expect(secondStore.getToken()).toBe(first);
  });

  it('verify returns true for the current token', async () => {
    await testStore.init();
    const written = await readFile(testPath, 'utf-8');
    expect(testStore.verify(written)).toBe(true);
  });

  it('verify returns false for a wrong token of equal length', async () => {
    await testStore.init();
    const fake = 'a'.repeat(64);
    expect(testStore.verify(fake)).toBe(false);
  });

  it('verify returns false for undefined input', () => {
    expect(testStore.verify(undefined)).toBe(false);
  });

  it('verify returns false when no token has been initialized', () => {
    testStore._reset();
    expect(testStore.verify('a'.repeat(64))).toBe(false);
  });
});
