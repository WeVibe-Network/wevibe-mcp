import { describe, expect, it } from 'vitest';
import { decryptPairedIdentitySeed } from '../src/pair-crypto.js';

describe('pair crypto parity', () => {
  it('decrypts Node-side payload encrypted via WebCrypto subtle.encrypt', async () => {
    const seed = Uint8Array.from([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
      0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
      0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    ]);
    const secret = Uint8Array.from([
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
      0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
    ]);

    const hkdfSalt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const info = new TextEncoder().encode('wevibe-pair-v1');

    const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: hkdfSalt,
        info,
      },
      hkdfKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['encrypt'],
    );

    const ciphertextWithTag = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, seed),
    );

    const recovered = decryptPairedIdentitySeed(secret, hkdfSalt, iv, ciphertextWithTag);
    expect(recovered).toEqual(Buffer.from(seed));
  });
});
