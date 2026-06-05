process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearTestStore,
  getDeviceKey,
  storeKeyEnvelope,
  loadKeyEnvelope,
  generateIdentitySeed,
  storeIdentitySeed,
  loadIdentitySeed,
  loadIdentity,
} from '../src/key-store.js';
import { generateIdentityFromSeed, seedToMnemonic, mnemonicToSeed } from '../src/crypto.js';

describe('key-store', () => {
  beforeEach(() => {
    clearTestStore();
  });

  it('test_get_device_key_idempotent', async () => {
    const key1 = await getDeviceKey();
    const key2 = await getDeviceKey();
    expect(key1).toEqual(key2);
    expect(key1.length).toBe(32);
  });

  it('test_store_load_envelope_roundtrip', async () => {
    const blob = new Uint8Array(64);
    crypto.getRandomValues(blob);

    await storeKeyEnvelope('org-test', 'enc_keys', blob);
    const loaded = await loadKeyEnvelope('org-test', 'enc_keys');

    expect(loaded).not.toBeNull();
    expect(Buffer.from(loaded!).toString('base64')).toBe(Buffer.from(blob).toString('base64'));
  });

  it('test_load_nonexistent_returns_null', async () => {
    const loaded = await loadKeyEnvelope('nonexistent-org-' + Date.now(), 'enc_keys');
    expect(loaded).toBeNull();
  });

  it('test_generate_identity_seed_32_bytes', () => {
    const seed = generateIdentitySeed();
    expect(seed.length).toBe(32);
  });

  it('test_store_load_identity_seed_deterministic', async () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < seed.length; i++) {
      seed[i] = i;
    }

    await storeIdentitySeed(seed);

    const first = await loadIdentity();
    const second = await loadIdentity();
    const derived = generateIdentityFromSeed(seed);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.edPrivkey.length).toBe(32);
    expect(first!.edPubkey.length).toBe(32);
    expect(first!.xPrivkey.length).toBe(32);
    expect(first!.xPubkey.length).toBe(32);

    expect(first).toEqual(second);
    expect(first).toEqual(derived);
    expect(first!.edPrivkey).toEqual(seed);
  });

  it('test_store_identity_seed_requires_32_bytes', async () => {
    await expect(storeIdentitySeed(new Uint8Array(31))).rejects.toThrow('identity seed must be 32 bytes');
  });

  it('test_seed_mnemonic_roundtrip', () => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < seed.length; i++) {
      seed[i] = i;
    }

    const phrase = seedToMnemonic(seed);
    const restored = mnemonicToSeed(phrase);

    expect(restored).toEqual(seed);
  });

  it('test_export_import_identity_roundtrip', async () => {
    clearTestStore();

    const seed = generateIdentitySeed();
    await storeIdentitySeed(seed);

    const originalIdentity = await loadIdentity();
    expect(originalIdentity).not.toBeNull();

    const exportedSeed = await loadIdentitySeed();
    expect(exportedSeed).not.toBeNull();
    const phrase = seedToMnemonic(exportedSeed!);

    clearTestStore();

    await storeIdentitySeed(mnemonicToSeed(phrase));
    const restoredIdentity = await loadIdentity();
    expect(restoredIdentity).not.toBeNull();

    expect(restoredIdentity!.edPubkey).toEqual(originalIdentity!.edPubkey);
    expect(restoredIdentity!.xPubkey).toEqual(originalIdentity!.xPubkey);
    expect(restoredIdentity!.edPrivkey).toEqual(originalIdentity!.edPrivkey);
    expect(restoredIdentity!.xPrivkey).toEqual(originalIdentity!.xPrivkey);
  });

  it('test_load_identity_seed_returns_null_when_missing', async () => {
    clearTestStore();
    const seed = await loadIdentitySeed();
    expect(seed).toBeNull();
  });
});
