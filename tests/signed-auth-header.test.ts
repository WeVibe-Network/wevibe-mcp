process.env.WEVIBE_KEYSTORE_TEST = '1';

import { beforeEach, describe, expect, it } from 'vitest';
import { initCrypto, verify } from '../src/crypto.js';
import { clearTestStore, storeIdentitySeed, loadIdentity } from '../src/key-store.js';
import { buildWeVibeSignedAuth } from '../src/auth.js';

const SIGNED_AUTH_RE = /^WeVibe-Signed pubkey=[0-9a-f]{64},timestamp=[^,]+,signature=[0-9a-f]{128}$/;
const PARSE_RE = /^WeVibe-Signed pubkey=([0-9a-f]{64}),timestamp=([^,]+),signature=([0-9a-f]{128})$/;

const SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) {
  SEED[i] = i;
}

describe('buildWeVibeSignedAuth header contract (real crypto)', () => {
  beforeEach(async () => {
    await initCrypto();
    clearTestStore();
  });

  it('produces a hub-verifiable WeVibe-Signed header over the timestamp, fresh', async () => {
    await storeIdentitySeed(SEED);

    const { headers, pubkeyHex } = await buildWeVibeSignedAuth();
    const auth = headers.Authorization;
    expect(auth).toMatch(SIGNED_AUTH_RE);

    const identity = await loadIdentity();
    expect(identity).not.toBeNull();
    expect(pubkeyHex).toBe(Buffer.from(identity!.edPubkey).toString('hex'));

    const parsed = auth.match(PARSE_RE);
    expect(parsed).not.toBeNull();
    const [, pk, ts, sig] = parsed!;
    expect(pk).toBe(pubkeyHex);

    expect(
      verify(identity!.edPubkey, Buffer.from(sig, 'hex'), new TextEncoder().encode(ts)),
    ).toBe(true);

    const ms = Date.parse(ts);
    expect(Number.isNaN(ms)).toBe(false);
    expect(Math.abs(Date.now() - ms)).toBeLessThanOrEqual(60_000);
  });

  it('fails closed with no identity present', async () => {
    clearTestStore();
    await expect(buildWeVibeSignedAuth()).rejects.toThrow();
  });
});
