process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect } from 'vitest';
import { getDeviceKey, storeKeyEnvelope, loadKeyEnvelope } from '../src/key-store.js';

describe('key-store', () => {
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
});
