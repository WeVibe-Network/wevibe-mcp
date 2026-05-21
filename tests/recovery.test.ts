import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { initCrypto, generateDek } from '../src/crypto.js';
import { generateRecoveryPhrase, reconstructMasterKey } from '../src/recovery.js';

beforeAll(async () => {
  await initCrypto();
});

describe('generateRecoveryPhrase', () => {
  it('returns a 24-word space-separated string', () => {
    const masterKey = generateDek();
    const phrase = generateRecoveryPhrase(masterKey);
    expect(typeof phrase).toBe('string');
    expect(phrase.split(' ').length).toBe(24);
  });

  it('is deterministic for the same key', () => {
    const masterKey = generateDek();
    const p1 = generateRecoveryPhrase(masterKey);
    const p2 = generateRecoveryPhrase(masterKey);
    expect(p1).toBe(p2);
  });

  it('different keys produce different phrases', () => {
    const k1 = generateDek();
    const k2 = generateDek();
    expect(generateRecoveryPhrase(k1)).not.toBe(generateRecoveryPhrase(k2));
  });
});

describe('reconstructMasterKey', () => {
  it('roundtrip: generateRecoveryPhrase → reconstructMasterKey', () => {
    const masterKey = generateDek();
    const phrase = generateRecoveryPhrase(masterKey);
    const recovered = reconstructMasterKey(phrase);
    expect(Buffer.from(recovered).toString('hex'))
      .toBe(Buffer.from(masterKey).toString('hex'));
  });

  it('rejects garbage input', () => {
    expect(() => reconstructMasterKey('this is not a valid phrase')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => reconstructMasterKey('')).toThrow();
  });
});

describe('cross-language test vectors', () => {
  it('matches mnemonic_roundtrip.json vectors', () => {
    const vectorPath = join(__dirname, '../../wevibe-sdk/protocol/test_vectors/mnemonic_roundtrip.json');
    const vectors = JSON.parse(readFileSync(vectorPath, 'utf-8'));

    for (const v of vectors.vectors) {
      const key = new Uint8Array(Buffer.from(v.master_key_hex, 'hex'));
      const phrase = generateRecoveryPhrase(key);
      expect(phrase).toBe(v.expected_phrase);

      const recovered = reconstructMasterKey(phrase);
      expect(Buffer.from(recovered).toString('hex')).toBe(v.master_key_hex);
    }
  });
});