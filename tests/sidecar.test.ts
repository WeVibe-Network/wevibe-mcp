import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { umbralDeriveEpochKeypair, umbralEncrypt, umbralGenerateKfrag } from '../src/sidecar.js';

const REAL_SIDECAR_BIN = '/Users/jerrysmith/Desktop/wevibe-workspace/wevibe-umbral/target/release/wevibe-umbral';
const SIDECAR_BIN_REQUIRED_MESSAGE = 'WEVIBE_UMBRAL_SIDECAR_BIN environment variable is required';
const HEX_LOWERCASE_RE = /^[0-9a-f]+$/;

const sidecarAvailable = existsSync(REAL_SIDECAR_BIN);
const describeSidecar = sidecarAvailable ? describe : describe.skip;

const SEED_ZERO = '00'.repeat(32);
const SEED_ONE = '01'.repeat(32);
const SEED_TWO = '02'.repeat(32);

describeSidecar(
  sidecarAvailable
    ? 'sidecar integration (real umbral binary)'
    : `sidecar integration (skipped: binary not found at ${REAL_SIDECAR_BIN})`,
  () => {
    const previousSidecarBin = process.env.WEVIBE_UMBRAL_SIDECAR_BIN;

    beforeAll(() => {
      process.env.WEVIBE_UMBRAL_SIDECAR_BIN = REAL_SIDECAR_BIN;
    });

    afterAll(() => {
      if (previousSidecarBin === undefined) {
        delete process.env.WEVIBE_UMBRAL_SIDECAR_BIN;
        return;
      }

      process.env.WEVIBE_UMBRAL_SIDECAR_BIN = previousSidecarBin;
    });

    it('rejects with required env message when sidecar bin env var is unset', async () => {
      const previous = process.env.WEVIBE_UMBRAL_SIDECAR_BIN;
      delete process.env.WEVIBE_UMBRAL_SIDECAR_BIN;

      try {
        await expect(umbralDeriveEpochKeypair(SEED_ZERO)).rejects.toThrow(SIDECAR_BIN_REQUIRED_MESSAGE);
      } finally {
        if (previous === undefined) {
          delete process.env.WEVIBE_UMBRAL_SIDECAR_BIN;
        } else {
          process.env.WEVIBE_UMBRAL_SIDECAR_BIN = previous;
        }
      }
    }, 15_000);

    it('derives deterministic keypairs for same seed and distinct keypairs for different seeds', async () => {
      const first = await umbralDeriveEpochKeypair(SEED_ZERO);
      const second = await umbralDeriveEpochKeypair(SEED_ZERO);
      const different = await umbralDeriveEpochKeypair(SEED_ONE);

      expect(first).toEqual(second);
      expect(different).not.toEqual(first);

      expect(first.publicKeyHex).toMatch(HEX_LOWERCASE_RE);
      expect(second.publicKeyHex).toMatch(HEX_LOWERCASE_RE);
      expect(different.publicKeyHex).toMatch(HEX_LOWERCASE_RE);

      expect(first.publicKeyHex).toBe(first.publicKeyHex.toLowerCase());
      expect(second.publicKeyHex).toBe(second.publicKeyHex.toLowerCase());
      expect(different.publicKeyHex).toBe(different.publicKeyHex.toLowerCase());

      expect(first.publicKeyHex.length).toBeGreaterThan(0);
      expect(first.publicKeyHex.length % 2).toBe(0);
      expect(second.publicKeyHex.length).toBe(first.publicKeyHex.length);
      expect(different.publicKeyHex.length).toBe(first.publicKeyHex.length);
    }, 15_000);

    it('rejects invalid seed input for non-hex, odd-length, and wrong-length values', async () => {
      const invalidSeeds = [
        'zz',
        'abc',
        '00'.repeat(31),
      ];

      for (const seed of invalidSeeds) {
        await expect(umbralDeriveEpochKeypair(seed)).rejects.toThrow(/^sidecar derive-epoch-keypair failed:/);
      }
    }, 15_000);

    it('generates non-empty hex kfrag with valid delegating and receiving keys', async () => {
      const delegating = await umbralDeriveEpochKeypair(SEED_ONE);
      const receiving = await umbralDeriveEpochKeypair(SEED_TWO);

      const kfragHex = await umbralGenerateKfrag(delegating.secretKeyHex, receiving.publicKeyHex);

      expect(kfragHex).toMatch(HEX_LOWERCASE_RE);
      expect(kfragHex.length).toBeGreaterThan(0);
      expect(kfragHex.length % 2).toBe(0);
    }, 15_000);

    it('rejects invalid hex inputs for kfrag generation', async () => {
      const delegating = await umbralDeriveEpochKeypair(SEED_ONE);
      const receiving = await umbralDeriveEpochKeypair(SEED_TWO);

      await expect(umbralGenerateKfrag('zz', receiving.publicKeyHex)).rejects.toThrow(/^sidecar generate-kfrags failed:/);
      await expect(umbralGenerateKfrag(delegating.secretKeyHex, 'gg')).rejects.toThrow(/^sidecar generate-kfrags failed:/);
    }, 15_000);

    it('encrypts plaintext hex and returns capsule/ciphertext hex strings', async () => {
      const epoch = await umbralDeriveEpochKeypair(SEED_ZERO);
      const plaintextHex = Buffer.from('wevibe-sidecar-edge-case', 'utf-8').toString('hex');

      const out = await umbralEncrypt(epoch.publicKeyHex, plaintextHex);

      expect(out).toEqual({
        capsule: expect.any(String),
        ciphertext: expect.any(String),
      });
      expect(out.capsule).toMatch(HEX_LOWERCASE_RE);
      expect(out.ciphertext).toMatch(HEX_LOWERCASE_RE);
      expect(out.capsule.length).toBeGreaterThan(0);
      expect(out.ciphertext.length).toBeGreaterThan(0);
      expect(out.capsule.length % 2).toBe(0);
      expect(out.ciphertext.length % 2).toBe(0);
    }, 15_000);

    it('rejects invalid epoch public key hex for encryption', async () => {
      await expect(umbralEncrypt('zz', '68656c6c6f')).rejects.toThrow(/^sidecar encrypt failed:/);
    }, 15_000);
  },
);
