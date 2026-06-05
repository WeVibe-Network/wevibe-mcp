/**
 * WASM crypto smoke tests — verifies wevibe-sdk-wasm Node.js bindings
 *
 * Uses the nodejs-target wasm-pack build (pkg-nodejs/) for vitest compatibility.
 * The bundler-target (pkg/) is used for browser/IDE distribution.
 *
 * IMPORTANT: All paths are relative to the wevibe-mcp directory where vitest runs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const wasmModule = await import('../../wevibe-sdk/pkg-nodejs/wevibe_sdk_wasm.js');

type EpochVector = {
  epoch: number;
  expected_audit_key_hex: string;
  expected_enc_key_hex: string;
  expected_search_key_hex: string;
  master_key_hex: string;
};

describe('epoch key derivation vectors', () => {
  it('matches all three Python CO-001 test vectors', () => {
    const vectorPath = join(__dirname, '../../wevibe-sdk/protocol/test_vectors/epoch_key_derivation.json');
    const { readFileSync } = require('node:fs');
    const vectors = JSON.parse(readFileSync(vectorPath, 'utf-8')) as EpochVector[];

    for (const v of vectors) {
      const masterKey = hexToUint8Array(v.master_key_hex);
      const result = wasmModule.derive_epoch_keys(masterKey, v.epoch);

      const encKey = uint8ArrayToHex(result[0]);
      const searchKey = uint8ArrayToHex(result[1]);
      const auditKey = uint8ArrayToHex(result[2]);

      expect(encKey).toBe(v.expected_enc_key_hex);
      expect(searchKey).toBe(v.expected_search_key_hex);
      expect(auditKey).toBe(v.expected_audit_key_hex);
    }
  });
});

describe('generate_identity', () => {
  it('returns 4 x 32-byte keys', () => {
    const result = wasmModule.generate_identity();
    expect(result.length).toBe(4);
    for (let i = 0; i < 4; i++) {
    expect(new Uint8Array(result[i]).length).toBe(32);
    }
  });

  it('each call produces different keys', () => {
    const a = wasmModule.generate_identity();
    const b = wasmModule.generate_identity();
    const aBytes = uint8ArrayToHex(a[0]);
    const bBytes = uint8ArrayToHex(b[0]);
    expect(aBytes).not.toBe(bBytes);
  });
});

describe('sign and verify', () => {
  it('roundtrip: sign then verify returns true', () => {
    const identity = wasmModule.generate_identity();
    const privkey = identity[0];
    const pubkey = identity[1];
    const data = new TextEncoder().encode('test message for wevibe-mcp');

    const sig = new Uint8Array(wasmModule.sign(privkey, data));
    expect(sig.length).toBe(64);
    expect(wasmModule.verify(pubkey, sig, data)).toBe(true);
  });

  it('verify fails with wrong key', () => {
    const a = wasmModule.generate_identity();
    const b = wasmModule.generate_identity();
    const sig = new Uint8Array(wasmModule.sign(a[0], new TextEncoder().encode('data')));
    expect(wasmModule.verify(b[1], sig, new TextEncoder().encode('data'))).toBe(false);
  });

  it('verify fails with tampered data', () => {
    const identity = wasmModule.generate_identity();
    const sig = new Uint8Array(wasmModule.sign(identity[0], new TextEncoder().encode('original')));
    expect(wasmModule.verify(identity[1], sig, new TextEncoder().encode('tampered'))).toBe(false);
  });
});

describe('seal_to_pubkey and open_envelope', () => {
  it('roundtrip returns original plaintext', () => {
    const identity = wasmModule.generate_identity();
    const xPrivkey = identity[2];
    const xPubkey = identity[3];
    const plaintext = new TextEncoder().encode('secret process memory content');

    const blob = new Uint8Array(wasmModule.seal_to_pubkey(plaintext, xPubkey));
    expect(blob.length).toBeGreaterThan(60);

    const recovered = new Uint8Array(wasmModule.open_envelope(blob, xPrivkey));
    expect(uint8ArrayToHex(recovered)).toBe(uint8ArrayToHex(plaintext));
  });

  it('nondeterministic: same input produces different ciphertext', () => {
    const identity = wasmModule.generate_identity();
    const xPubkey = identity[3];
    const plaintext = new TextEncoder().encode('same');
    const a = uint8ArrayToHex(new Uint8Array(wasmModule.seal_to_pubkey(plaintext, xPubkey)));
    const b = uint8ArrayToHex(new Uint8Array(wasmModule.seal_to_pubkey(plaintext, xPubkey)));
    expect(a).not.toBe(b);
  });

  it('wrong key throws', () => {
    const a = wasmModule.generate_identity();
    const b = wasmModule.generate_identity();
    const blob = wasmModule.seal_to_pubkey(new TextEncoder().encode('secret'), a[3]);
    expect(() => wasmModule.open_envelope(new Uint8Array(blob), b[2])).toThrow();
  });
});

describe('encrypt_symmetric and decrypt_symmetric', () => {
  it('roundtrip', () => {
    const key = new Uint8Array(wasmModule.generate_dek());
    const plaintext = new TextEncoder().encode('hello world');
    const blob = new Uint8Array(wasmModule.encrypt_symmetric(plaintext, key));
    const recovered = new Uint8Array(wasmModule.decrypt_symmetric(blob, key));
    expect(uint8ArrayToHex(recovered)).toBe(uint8ArrayToHex(plaintext));
  });

  it('nondeterministic', () => {
    const key = new Uint8Array(wasmModule.generate_dek());
    const pt = new TextEncoder().encode('same');
    const a = uint8ArrayToHex(new Uint8Array(wasmModule.encrypt_symmetric(pt, key)));
    const b = uint8ArrayToHex(new Uint8Array(wasmModule.encrypt_symmetric(pt, key)));
    expect(a).not.toBe(b);
  });

  it('wrong key throws', () => {
    const k1 = new Uint8Array(wasmModule.generate_dek());
    const k2 = new Uint8Array(wasmModule.generate_dek());
    const blob = new Uint8Array(wasmModule.encrypt_symmetric(new TextEncoder().encode('data'), k1));
    expect(() => wasmModule.decrypt_symmetric(blob, k2)).toThrow();
  });
});

describe('compute_blind_token', () => {
  it('returns 64-char lowercase hex', () => {
    const key = new Uint8Array(wasmModule.generate_dek());
    const token = wasmModule.compute_blind_token('redis', key);
    expect(typeof token).toBe('string');
    expect(token.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it('deterministic', () => {
    const key = new Uint8Array(wasmModule.generate_dek());
    expect(wasmModule.compute_blind_token('redis', key))
      .toBe(wasmModule.compute_blind_token('redis', key));
  });

  it('different keywords produce different tokens', () => {
    const key = new Uint8Array(wasmModule.generate_dek());
    expect(wasmModule.compute_blind_token('redis', key))
      .not.toBe(wasmModule.compute_blind_token('postgres', key));
  });
});

describe('master_key_to_mnemonic and mnemonic_to_master_key', () => {
  it('roundtrip: key → phrase → key', () => {
    const key = new Uint8Array(wasmModule.generate_dek());
    const phrase = wasmModule.master_key_to_mnemonic(key);
    expect(typeof phrase).toBe('string');
    const words = phrase.split(' ');
    expect(words.length).toBe(24);

    const recovered = new Uint8Array(wasmModule.mnemonic_to_master_key(phrase));
    expect(uint8ArrayToHex(recovered)).toBe(uint8ArrayToHex(key));
  });

  it('matches cross-language test vectors', () => {
    const vectorPath = join(__dirname, '../../wevibe-sdk/protocol/test_vectors/mnemonic_roundtrip.json');
    const { readFileSync } = require('node:fs');
    const vectors = JSON.parse(readFileSync(vectorPath, 'utf-8'));

    for (const v of vectors.vectors) {
      const key = hexToUint8Array(v.master_key_hex);
      const phrase = wasmModule.master_key_to_mnemonic(key);
      expect(phrase).toBe(v.expected_phrase);

      const recovered = new Uint8Array(wasmModule.mnemonic_to_master_key(phrase));
      expect(uint8ArrayToHex(recovered)).toBe(v.master_key_hex);
    }
  });

  it('rejects invalid phrase', () => {
    expect(() => wasmModule.mnemonic_to_master_key('not a valid mnemonic phrase')).toThrow();
  });

  it('rejects 12-word phrase (wrong entropy size)', () => {
    expect(() => wasmModule.mnemonic_to_master_key(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    )).toThrow();
  });

  it('rejects wrong key size', () => {
    expect(() => wasmModule.master_key_to_mnemonic(new Uint8Array(16))).toThrow();
  });

  it('each key produces a unique phrase', () => {
    const k1 = new Uint8Array(wasmModule.generate_dek());
    const k2 = new Uint8Array(wasmModule.generate_dek());
    expect(wasmModule.master_key_to_mnemonic(k1))
      .not.toBe(wasmModule.master_key_to_mnemonic(k2));
  });
});

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
