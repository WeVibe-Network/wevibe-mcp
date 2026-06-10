import { describe, expect, it } from 'vitest';
import {
  buildCanonicalDenialBody,
  buildCanonicalServeBody,
  computeServeFingerprintHex,
  ed25519KeypairFromSeed,
  signCanonicalBody,
} from '../src/serve-signing.js';

const MEMORY_HASH_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const VECTOR_PUBKEY_HEX = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const VECTOR_SERVE_SIG_HEX = '2a643b43c92e0771fa4a33e4c0ec62f3c1e2ef8be79738c77f7b5f6ba6fe98e5e80daf947daeb0cef8e46caa19cf133d550388acdbde2a287ddb80ba7990f30b';
const VECTOR_SERVE_FINGERPRINT_HEX = '8263a2b548d3b39a40520711b89a21290d377782b9771f627a58f6ad2dccc666';
const VECTOR_DENIAL_SIG_HEX = '19759827da0021606efba37de04a8e1272fac36cab55157f77890ac3d0151000ff799271af1394aab01a8151b9e55ee0694338219e6ffd81068628a78d94a00b';

describe('serve signing parity vectors', () => {
  it('matches chain canonical body + ed25519 signatures', async () => {
    const seed = new Uint8Array(32).fill(0x01);
    const keypair = await ed25519KeypairFromSeed(seed);
    expect(keypair.pubHex).toBe(VECTOR_PUBKEY_HEX);

    const canonicalServeBody = buildCanonicalServeBody({
      orgId: 'org-test',
      memoryContentHashHex: MEMORY_HASH_HEX,
      epoch: 7,
      serveKeyPubkeyHex: keypair.pubHex,
      matchedKeywords: ['beta', 'alpha'],
      nonceHex: 'deadbeef',
    });

    expect(canonicalServeBody).toBe(
      'wevibe-serve-v1\n'
      + 'org-test\n'
      + '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20\n'
      + '7\n'
      + '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c\n'
      + 'alpha,beta\n'
      + 'deadbeef',
    );

    const serveSigHex = await signCanonicalBody(new TextEncoder().encode(canonicalServeBody), keypair.priv);
    expect(serveSigHex).toBe(VECTOR_SERVE_SIG_HEX);

    const serveFingerprintHex = computeServeFingerprintHex({
      memoryContentHashHex: MEMORY_HASH_HEX,
      serveKeyPubkeyHex: keypair.pubHex,
      epoch: 7,
    });
    expect(serveFingerprintHex).toBe(VECTOR_SERVE_FINGERPRINT_HEX);

    const canonicalDenialBody = buildCanonicalDenialBody({
      orgId: 'org-test',
      memoryHashHex: MEMORY_HASH_HEX,
      epoch: 7,
      serveKeyPubkeyHex: keypair.pubHex,
      serveFingerprintHex,
      nonceHex: 'cafebabe',
    });
    const denialSigHex = await signCanonicalBody(new TextEncoder().encode(canonicalDenialBody), keypair.priv);
    expect(denialSigHex).toBe(VECTOR_DENIAL_SIG_HEX);
  });
});
