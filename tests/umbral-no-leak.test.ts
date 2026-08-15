import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PREVIOUS_LOG_DIR = process.env.WEVIBE_LOG_DIR;
const TEST_LOG_DIR = mkdtempSync(path.join(tmpdir(), 'wevibe-umbral-leak-'));
process.env.WEVIBE_LOG_DIR = TEST_LOG_DIR;

/**
 * Secrets used to cross a process boundary as argv (--seed, --delegating-sk,
 * --receiving-sk), which made them readable via `ps` for the life of the spawn.
 * In-process WASM removes that exposure entirely; this suite holds the
 * remaining line — that nothing secret reaches the log files either.
 */
describe('umbral no-leak regression', () => {
  afterAll(() => {
    if (PREVIOUS_LOG_DIR === undefined) {
      delete process.env.WEVIBE_LOG_DIR;
    } else {
      process.env.WEVIBE_LOG_DIR = PREVIOUS_LOG_DIR;
    }
  });

  it('captures only fingerprint/size summaries and leaks zero secrets', async () => {
    const { umbralDeriveEpochKeypair, umbralEncrypt, umbralGenerateKfrag } =
      await import('../src/umbral.js');

    const seed = '01'.repeat(32);
    const receivingSeed = '02'.repeat(32);
    const plaintextHex = '68656c6c6f';

    const derived = await umbralDeriveEpochKeypair(seed);
    const receiving = await umbralDeriveEpochKeypair(receivingSeed);
    await umbralEncrypt(derived.publicKeyHex, plaintextHex);
    await umbralGenerateKfrag(derived.secretKeyHex, receiving.publicKeyHex);

    const logPath = path.join(TEST_LOG_DIR, 'umbral.log');
    expect(existsSync(logPath)).toBe(true);

    const logContent = readFileSync(logPath, 'utf-8');

    expect(logContent).not.toContain('01010101');
    expect(logContent).not.toContain(plaintextHex);
    expect(logContent).not.toContain(derived.secretKeyHex);
    expect(logContent).not.toContain('secret_key');
    expect(logContent).not.toContain('plaintext');
    expect(logContent).not.toContain('-----');

    expect(logContent).toContain('out_fp=');
    expect(logContent).toContain('out_bytes=');
  });
});
