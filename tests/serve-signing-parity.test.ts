import { describe, expect, it } from 'vitest';
import { getPublicKeyAsync, verifyAsync } from '@noble/ed25519';
import {
  buildCanonicalDenialBody,
  buildCanonicalServeBody,
  computeServeFingerprint,
  computeServeFingerprintHex,
  ed25519KeypairFromSeed,
  signCanonicalBody,
} from '../src/serve-signing.js';

const MEMORY_HASH_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const VECTOR_PUBKEY_HEX = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
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
      nonceHex: 'deadbeef',
    });

    expect(canonicalServeBody).toBe(
      'wevibe-serve-v2\n'
      + 'org-test\n'
      + '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20\n'
      + '7\n'
      + '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c\n'
      + 'deadbeef',
    );

    const serveBodyBytes = new TextEncoder().encode(canonicalServeBody);
    const serveSigHex = await signCanonicalBody(serveBodyBytes, keypair.priv);
    expect(await verifyAsync(Buffer.from(serveSigHex, 'hex'), serveBodyBytes, keypair.pub)).toBe(true);

    const serveFingerprintHex = computeServeFingerprintHex(MEMORY_HASH_HEX, keypair.pubHex, 7);
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

  it('matches chain serve v2 canonical body golden vector exactly', async () => {
    const orgId = 'org-a';
    const memoryHashHex = '01'.repeat(32);
    const serveKeyPubkeyHex = '02'.repeat(32);
    const nonceHex = '0304';

    const body = buildCanonicalServeBody({
      orgId,
      memoryContentHashHex: memoryHashHex,
      epoch: 7,
      serveKeyPubkeyHex,
      nonceHex,
    });

    expect(body).toBe(
      'wevibe-serve-v2\norg-a\n'
      + '01'.repeat(32)
      + '\n7\n'
      + '02'.repeat(32)
      + '\n0304',
    );
    expect((body.match(/\n/g) ?? [])).toHaveLength(5);
  });

  it('signs and verifies the chain serve v2 golden body over raw bytes', async () => {
    const seed = new Uint8Array(32).fill(0x09);
    const pub = await getPublicKeyAsync(seed);
    const bodyBytes = new TextEncoder().encode(
      'wevibe-serve-v2\norg-a\n'
      + '01'.repeat(32)
      + '\n7\n'
      + '02'.repeat(32)
      + '\n0304',
    );

    const sigHex = await signCanonicalBody(bodyBytes, seed);
    expect(await verifyAsync(Buffer.from(sigHex, 'hex'), bodyBytes, pub)).toBe(true);
  });

  it('matches chain ComputeServeFingerprint golden vector exactly', () => {
    const memoryHashHex = '11'.repeat(32);
    const servePubkeyHex = '22'.repeat(32);
    const epoch = 9n;
    const expectedHex = '0110cf7a038bf89511ceb003349200a874b15394005a28da66d03e0c1c7e7df9';

    expect(Buffer.from(computeServeFingerprint(memoryHashHex, servePubkeyHex, epoch)).toString('hex'))
      .toBe(expectedHex);
    expect(computeServeFingerprintHex(memoryHashHex, servePubkeyHex, epoch)).toBe(expectedHex);
  });

  it('binds serve fingerprints to the serve pubkey', () => {
    const memoryHashHex = '11'.repeat(32);
    const epoch = 9;

    expect(computeServeFingerprintHex(memoryHashHex, '22'.repeat(32), epoch))
      .not.toBe(computeServeFingerprintHex(memoryHashHex, '23'.repeat(32), epoch));
  });
});
