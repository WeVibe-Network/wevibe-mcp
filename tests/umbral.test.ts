import { describe, expect, it } from 'vitest';
import { umbralDeriveEpochKeypair, umbralEncrypt, umbralGenerateKfrag } from '../src/umbral.js';

/**
 * These tests deliberately set NO environment variable and reference NO binary
 * path. The Umbral capability ships inside the package, so if these can run at
 * all, a user's install can too. The predecessor suite skipped itself whenever
 * a hardcoded absolute binary path was missing — which meant it stayed green on
 * exactly the machines where crypto was broken.
 */

const HEX_LOWERCASE_RE = /^[0-9a-f]+$/;

const SEED_ZERO = '00'.repeat(32);
const SEED_ONE = '01'.repeat(32);
const SEED_TWO = '02'.repeat(32);

describe('umbral in-process crypto (WASM)', () => {
  it('works with no WEVIBE_UMBRAL_SIDECAR_BIN set', async () => {
    expect(process.env.WEVIBE_UMBRAL_SIDECAR_BIN).toBeUndefined();

    const derived = await umbralDeriveEpochKeypair(SEED_ONE);
    expect(derived.publicKeyHex).toMatch(HEX_LOWERCASE_RE);
  });

  it('derives deterministic keypairs for same seed and distinct keypairs for different seeds', async () => {
    const first = await umbralDeriveEpochKeypair(SEED_ONE);
    const second = await umbralDeriveEpochKeypair(SEED_ONE);
    const different = await umbralDeriveEpochKeypair(SEED_TWO);

    expect(first).toEqual(second);
    expect(different).not.toEqual(first);

    expect(first.publicKeyHex).toMatch(HEX_LOWERCASE_RE);
    expect(first.publicKeyHex).toBe(first.publicKeyHex.toLowerCase());
    expect(first.publicKeyHex.length % 2).toBe(0);
    expect(second.publicKeyHex.length).toBe(first.publicKeyHex.length);
    expect(different.publicKeyHex.length).toBe(first.publicKeyHex.length);
  });

  it('pins the derived public key for a known seed (wire-format regression guard)', async () => {
    // Byte-for-byte identical to `wevibe-umbral derive-epoch-keypair --seed aa..aa`.
    // If this changes, the WASM build has diverged from the native crypto and
    // every previously-issued epoch key is at risk. Do not "update" this value
    // without understanding why it moved.
    const derived = await umbralDeriveEpochKeypair('aa'.repeat(32));
    expect(derived.publicKeyHex).toBe(
      '026a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3',
    );
  });

  it('rejects all-zero seed because canonical scalar derivation requires a valid secp256k1 secret key', async () => {
    await expect(umbralDeriveEpochKeypair(SEED_ZERO)).rejects.toThrow(
      /^umbral derive-epoch-keypair failed:/,
    );
  });

  it('rejects invalid seed input for non-hex, odd-length, and wrong-length values', async () => {
    for (const seed of ['zz', 'abc', '00'.repeat(31)]) {
      await expect(umbralDeriveEpochKeypair(seed)).rejects.toThrow(
        /^umbral derive-epoch-keypair failed:/,
      );
    }
  });

  it('generates non-empty hex kfrag with valid delegating and receiving keys', async () => {
    const delegating = await umbralDeriveEpochKeypair(SEED_ONE);
    const receiving = await umbralDeriveEpochKeypair(SEED_TWO);

    const kfragHex = await umbralGenerateKfrag(delegating.secretKeyHex, receiving.publicKeyHex);

    expect(kfragHex).toMatch(HEX_LOWERCASE_RE);
    expect(kfragHex.length).toBeGreaterThan(0);
    expect(kfragHex.length % 2).toBe(0);
  });

  it('rejects invalid hex inputs for kfrag generation', async () => {
    const delegating = await umbralDeriveEpochKeypair(SEED_ONE);
    const receiving = await umbralDeriveEpochKeypair(SEED_TWO);

    await expect(umbralGenerateKfrag('zz', receiving.publicKeyHex)).rejects.toThrow(
      /^umbral generate-kfrags failed:/,
    );
    await expect(umbralGenerateKfrag(delegating.secretKeyHex, 'gg')).rejects.toThrow(
      /^umbral generate-kfrags failed:/,
    );
  });

  it('encrypts plaintext hex and returns capsule/ciphertext hex strings', async () => {
    const epoch = await umbralDeriveEpochKeypair(SEED_ONE);
    const plaintextHex = Buffer.from('wevibe-umbral-edge-case', 'utf-8').toString('hex');

    const out = await umbralEncrypt(epoch.publicKeyHex, plaintextHex);

    expect(out).toEqual({ capsule: expect.any(String), ciphertext: expect.any(String) });
    expect(out.capsule).toMatch(HEX_LOWERCASE_RE);
    expect(out.ciphertext).toMatch(HEX_LOWERCASE_RE);
    expect(out.capsule.length % 2).toBe(0);
    expect(out.ciphertext.length % 2).toBe(0);
  });

  it('draws live entropy — two encryptions of the same plaintext differ', async () => {
    // Guards the getrandom "js" backend. If the WASM RNG were ever stubbed to
    // zeroes, this is the only test that would notice, and the consequence
    // would be catastrophic rather than cosmetic.
    const epoch = await umbralDeriveEpochKeypair(SEED_ONE);
    const plaintextHex = '68656c6c6f';

    const a = await umbralEncrypt(epoch.publicKeyHex, plaintextHex);
    const b = await umbralEncrypt(epoch.publicKeyHex, plaintextHex);

    expect(a.capsule).not.toBe(b.capsule);
  });

  it('rejects invalid epoch public key hex for encryption', async () => {
    await expect(umbralEncrypt('zz', '68656c6c6f')).rejects.toThrow(/^umbral encrypt failed:/);
  });
});
