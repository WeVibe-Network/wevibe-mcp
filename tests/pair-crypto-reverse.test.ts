import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, encryptIdentitySeedForPairing } from '../src/pair-crypto.js';

describe('pair crypto reverse parity', () => {
  it('decrypts Node-encrypted payload via WebCrypto subtle.decrypt', async () => {
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

    const { hkdfSalt, iv, ciphertextWithTag } = encryptIdentitySeedForPairing(seed, secret);

    const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: hkdfSalt,
        info: new TextEncoder().encode('wevibe-pair-v1'),
      },
      hkdfKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['decrypt'],
    );

    const recovered = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertextWithTag),
    );

    expect(recovered).toEqual(seed);
  });

  it('round-trips base32 encode/decode for pairing secret', () => {
    const secret = Uint8Array.from([
      0xde, 0xad, 0xbe, 0xef, 0xfa, 0xce, 0xb0, 0x0c,
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);

    const encoded = base32Encode(secret);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(encoded.includes('=')).toBe(false);
    expect(base32Decode(encoded)).toEqual(Buffer.from(secret));
  });
});
