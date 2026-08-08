import { createHash } from 'node:crypto';
import { getPublicKeyAsync, verifyAsync } from '@noble/ed25519';
import { describe, expect, it } from 'vitest';
import {
  buildCanonicalOutcomeEventBodyBytes,
  computeEventFingerprint,
  deriveOutcomeNonceHex,
  signCanonicalBody,
} from '../src/event-signing.js';

const textDecoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('event signing parity vectors', () => {
  it('matches chain outcome event canonical body golden vector exactly', () => {
    const bodyBytes = buildCanonicalOutcomeEventBodyBytes({
      orgId: 'org-a',
      memoryHash: new Uint8Array(32).fill(0x01),
      epoch: 7,
      signerPubkey: new Uint8Array(32).fill(0x02),
      episodeRef: new Uint8Array([0x10, 0x11]),
      resolution: 'worked',
      source: 'harvested',
      evidenceRef: new Uint8Array([0x12]),
      serveRef: new Uint8Array(32).fill(0x13),
      nonce: new Uint8Array([0x03, 0x04]),
    });

    const body = textDecoder.decode(bodyBytes);
    expect(body).toBe(
      'wevibe-event-v1\noutcome\norg-a\n'
      + '01'.repeat(32)
      + '\n7\n'
      + '02'.repeat(32)
      + '\n1011\n12\n'
      + '13'.repeat(32)
      + '\nresolution=worked\nsource=harvested\n0304',
    );
    expect((body.match(/\n/g) ?? [])).toHaveLength(11);
    expect(body.split('\n')[8]).toBe('13'.repeat(32));
  });

  it('formats each resolution token exactly', () => {
    const base = {
      orgId: 'org-a',
      memoryHash: '01'.repeat(32),
      epoch: 7,
      signerPubkey: '02'.repeat(32),
      episodeRef: '1011',
      source: 'harvested' as const,
      evidenceRef: '12',
      serveRef: '13'.repeat(32),
      nonce: '0304',
    };

    for (const resolution of ['worked', 'didnt_work', 'unobserved'] as const) {
      const body = textDecoder.decode(buildCanonicalOutcomeEventBodyBytes({ ...base, resolution }));
      expect(body.split('\n')[9]).toBe(`resolution=${resolution}`);
      expect(body.split('\n')[10]).toBe('source=harvested');
    }
  });

  it('rejects unknown resolution and source tokens', () => {
    const base = {
      orgId: 'org-a',
      memoryHash: '01'.repeat(32),
      epoch: 7,
      signerPubkey: '02'.repeat(32),
      episodeRef: '1011',
      evidenceRef: '12',
      serveRef: '13'.repeat(32),
      nonce: '0304',
    };

    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...base, resolution: 'failed' as never, source: 'harvested' }))
      .toThrow('resolution must be one of worked, didnt_work, unobserved');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...base, resolution: 'worked', source: 'auto' as never }))
      .toThrow('source must be one of harvested, user');
  });

  it('computes event fingerprint as sha256(raw body)', () => {
    const body = new TextEncoder().encode('event-body');
    const expected = createHash('sha256').update(body).digest('hex');

    expect(bytesToHex(computeEventFingerprint(body))).toBe(expected);
  });

  it('derives deterministic opaque outcome nonces from content-free event identity', () => {
    const orgId = 'org-a';
    const memoryHashHex = '01'.repeat(32);
    const episodeRefHex = '1011';
    const serveRefHex = '13'.repeat(32);
    const preimage = `wevibe-event-nonce-v1\n${orgId}\n${memoryHashHex}\n${episodeRefHex}\nresolution=worked\n${serveRefHex}`;
    const expected = createHash('sha256').update(preimage).digest().subarray(0, 8).toString('hex');

    const nonce = deriveOutcomeNonceHex(orgId, memoryHashHex, episodeRefHex, 'worked', serveRefHex);
    expect(nonce).toBe(expected);
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveOutcomeNonceHex(orgId, memoryHashHex, episodeRefHex, 'worked', serveRefHex)).toBe(nonce);
    expect(deriveOutcomeNonceHex(orgId, memoryHashHex, episodeRefHex, 'didnt_work', serveRefHex)).not.toBe(nonce);
    expect(deriveOutcomeNonceHex(orgId, memoryHashHex, episodeRefHex, 'unobserved', serveRefHex)).not.toBe(nonce);
    expect(deriveOutcomeNonceHex('org-b', memoryHashHex, episodeRefHex, 'worked', serveRefHex)).not.toBe(nonce);
    expect(deriveOutcomeNonceHex(orgId, '02'.repeat(32), episodeRefHex, 'worked', serveRefHex)).not.toBe(nonce);
    expect(deriveOutcomeNonceHex(orgId, memoryHashHex, '1012', 'worked', serveRefHex)).not.toBe(nonce);
    expect(deriveOutcomeNonceHex(orgId, memoryHashHex, episodeRefHex, 'worked', '14'.repeat(32))).not.toBe(nonce);
  });

  it('rejects invalid canonical outcome sizes', () => {
    const valid = {
      orgId: 'org-a',
      memoryHash: '01'.repeat(32),
      epoch: 7,
      signerPubkey: '02'.repeat(32),
      episodeRef: '10',
      resolution: 'worked' as const,
      source: 'harvested' as const,
      evidenceRef: '12',
      serveRef: '13'.repeat(32),
      nonce: '03',
    };

    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, memoryHash: '01'.repeat(31) }))
      .toThrow('memory_hash must be 32 bytes');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, signerPubkey: '02'.repeat(31) }))
      .toThrow('signer_pubkey must be 32 bytes');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, nonce: '' }))
      .toThrow('nonce must be lowercase hex');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, nonce: '03'.repeat(65) }))
      .toThrow('nonce must be between 1 and 64 bytes');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, episodeRef: '' }))
      .toThrow('episode_ref must be lowercase hex');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, episodeRef: '10'.repeat(65) }))
      .toThrow('episode_ref must be between 1 and 64 bytes');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, evidenceRef: '' }))
      .toThrow('evidence_ref must be lowercase hex');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, evidenceRef: '12'.repeat(65) }))
      .toThrow('evidence_ref must be between 1 and 64 bytes');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, serveRef: '' }))
      .toThrow('serve_ref must be lowercase hex');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, serveRef: '13'.repeat(31) }))
      .toThrow('serve_ref must be 32 bytes');
    expect(() => buildCanonicalOutcomeEventBodyBytes({ ...valid, serveRef: '13'.repeat(33) }))
      .toThrow('serve_ref must be 32 bytes');
  });

  it('signs and verifies ed25519 over raw event body bytes', async () => {
    const seed = new Uint8Array(32).fill(0x09);
    const pub = await getPublicKeyAsync(seed);
    const body = buildCanonicalOutcomeEventBodyBytes({
      orgId: 'org-a',
      memoryHash: '01'.repeat(32),
      epoch: 7,
      signerPubkey: Buffer.from(pub).toString('hex'),
      episodeRef: '1011',
      resolution: 'worked',
      source: 'harvested',
      evidenceRef: '12',
      serveRef: '13'.repeat(32),
      nonce: '0304',
    });

    const sigHex = await signCanonicalBody(body, seed);
    expect(await verifyAsync(Buffer.from(sigHex, 'hex'), body, pub)).toBe(true);
  });
});
