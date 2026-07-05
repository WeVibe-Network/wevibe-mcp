import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PREVIOUS_LOG_DIR = process.env.WEVIBE_LOG_DIR;
const TEST_LOG_DIR = mkdtempSync(path.join(tmpdir(), 'wevibe-sidecar-leak-'));
process.env.WEVIBE_LOG_DIR = TEST_LOG_DIR;

const REAL_SIDECAR_BIN = '/Users/jerrysmith/Desktop/wevibe-workspace/wevibe-umbral/target/release/wevibe-umbral';
const sidecarAvailable = existsSync(REAL_SIDECAR_BIN);
const describeSidecar = sidecarAvailable ? describe : describe.skip;

describeSidecar(
  sidecarAvailable
    ? 'sidecar no-leak regression (real umbral binary)'
    : `sidecar no-leak regression (skipped: binary not found at ${REAL_SIDECAR_BIN})`,
  () => {
    const previousSidecarBin = process.env.WEVIBE_UMBRAL_SIDECAR_BIN;
    const previousLogDir = PREVIOUS_LOG_DIR;

    beforeAll(() => {
      process.env.WEVIBE_UMBRAL_SIDECAR_BIN = REAL_SIDECAR_BIN;
      process.env.WEVIBE_LOG_DIR = TEST_LOG_DIR;
    });

    afterAll(() => {
      if (previousSidecarBin === undefined) {
        delete process.env.WEVIBE_UMBRAL_SIDECAR_BIN;
      } else {
        process.env.WEVIBE_UMBRAL_SIDECAR_BIN = previousSidecarBin;
      }

      if (previousLogDir === undefined) {
        delete process.env.WEVIBE_LOG_DIR;
      } else {
        process.env.WEVIBE_LOG_DIR = previousLogDir;
      }
    });

    it('captures only fingerprint/size summaries and leaks zero secrets', async () => {
      const { umbralDeriveEpochKeypair, umbralEncrypt } = await import('../src/sidecar.js');

      const seed = '01'.repeat(32);
      const plaintextHex = '68656c6c6f';

      const derived = await umbralDeriveEpochKeypair(seed);
      await umbralEncrypt(derived.publicKeyHex, plaintextHex);

      const logPath = path.join(TEST_LOG_DIR, 'umbral-sidecar.log');
      expect(existsSync(logPath)).toBe(true);

      const logContent = readFileSync(logPath, 'utf-8');

      expect(logContent).not.toContain('01010101');
      expect(logContent).not.toContain(plaintextHex);
      expect(logContent).not.toContain(derived.secretKeyHex);
      expect(logContent).not.toContain('secret_key');
      expect(logContent).not.toContain('plaintext');
      expect(logContent).not.toContain('-----');

      expect(logContent).toContain('stdout_fp=');
      expect(logContent).toContain('stdout_bytes=');
      expect(logContent).toContain('stderr_fp=');
      expect(logContent).toContain('stderr_bytes=');
    }, 15_000);
  },
);
