process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect } from 'vitest';
import { splitMasterKey, reconstructFromShares } from '../src/recovery.js';
import { initCrypto, generateDek } from '../src/crypto.js';

describe('threshold recovery', () => {
  it('splitMasterKey produces 3 shares', async () => {
    await initCrypto();
    const key = generateDek();
    const { shares, threshold, totalShares } = splitMasterKey(key);
    expect(shares.length).toBe(3);
    expect(threshold).toBe(2);
    expect(totalShares).toBe(3);
  });

  it('reconstructFromShares with shares 0,1 recovers original', async () => {
    await initCrypto();
    const key = generateDek();
    const { shares } = splitMasterKey(key);
    const recovered = reconstructFromShares([shares[0], shares[1]]);
    expect(Buffer.from(recovered).toString('hex')).toBe(Buffer.from(key).toString('hex'));
  });

  it('reconstructFromShares with shares 1,2 recovers original', async () => {
    await initCrypto();
    const key = generateDek();
    const { shares } = splitMasterKey(key);
    const recovered = reconstructFromShares([shares[1], shares[2]]);
    expect(Buffer.from(recovered).toString('hex')).toBe(Buffer.from(key).toString('hex'));
  });

  it('reconstructFromShares with shares 0,2 recovers original', async () => {
    await initCrypto();
    const key = generateDek();
    const { shares } = splitMasterKey(key);
    const recovered = reconstructFromShares([shares[0], shares[2]]);
    expect(Buffer.from(recovered).toString('hex')).toBe(Buffer.from(key).toString('hex'));
  });

  it('reconstructFromShares with 1 share throws', async () => {
    await initCrypto();
    const key = generateDek();
    const { shares } = splitMasterKey(key);
    expect(() => reconstructFromShares([shares[0]])).toThrow();
  });

  it('splitMasterKey rejects non-32-byte input', async () => {
    await initCrypto();
    expect(() => splitMasterKey(new Uint8Array(16))).toThrow();
  });
});