import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initCrypto, generateIdentity, generateDek, encryptSymmetric, decryptSymmetric, sealToPubkey, openEnvelope, deriveEpochKeys, sign } from '../src/crypto.js';
import { decryptPendingItem, denySubmission, approveSubmission } from '../src/moderation.js';
import { denySubmissionMessage } from '../src/canonical.js';
import type { OrgMembership } from '../src/types.js';
import type { PendingQueueItem } from '../src/moderation.js';
import { embedRetrievalCard } from '../src/embed-card.js';
import * as keyStore from '../src/key-store.js';
import * as extraction from '../src/extraction.js';
import * as orgClient from '../src/org-client.js';
import * as sidecar from '../src/sidecar.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/embed-card.js', () => ({
  embedRetrievalCard: vi.fn(),
}));

beforeAll(async () => {
  await initCrypto();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

function buildTestMembership(overrides: Partial<OrgMembership> = {}): OrgMembership {
  return {
    orgId: 'test-org',
    orgName: 'Test',
    role: 'moderator',
    currentEpoch: 0,
    historyAccessFromEpoch: 0,
    egressMode: 'unrestricted',
    allowedProviders: [],
    encKeys: new Map(),
    searchKeys: new Map(),
    modPubkey: null,
    modPrivkey: null,
    ...overrides,
  };
}

describe('moderation crypto pipeline', () => {
  it('decryptPendingItem decrypts a correctly sealed submission', () => {
    const modIdentity = generateIdentity();

    const plaintext = 'This is a test memory contribution with enough chars.';
    const dek = generateDek();
    const ciphertext = encryptSymmetric(new Uint8Array(Buffer.from(plaintext, 'utf-8')), dek);
    const wrappedDekMod = sealToPubkey(dek, modIdentity.xPubkey);

    const item: PendingQueueItem = {
      submission_hash: 'abc123',
      org_id: 'test-org',
      epoch_id: 0,
      contributor_pubkey: 'contributor_hex',
      ciphertext_hex: Buffer.from(ciphertext).toString('hex'),
      wrapped_dek_mod: Buffer.from(wrappedDekMod).toString('hex'),
      stack_hint: ['typescript'],
      memory_type: 'memory',
      created_at: new Date().toISOString(),
      status: 'pending',
    };

    const membership = buildTestMembership({
      modPrivkey: modIdentity.xPrivkey,
    });

    const result = decryptPendingItem(item, membership);

    expect(result.decryptError).toBeUndefined();
    expect(result.plaintext).toBe(plaintext);
    expect(result.submissionHash).toBe('abc123');
  });

  it('decryptPendingItem returns error when no modPrivkey', () => {
    const item: PendingQueueItem = {
      submission_hash: 'abc123',
      org_id: 'test-org',
      epoch_id: 0,
      contributor_pubkey: 'contributor_hex',
      ciphertext_hex: 'deadbeef',
      wrapped_dek_mod: 'deadbeef',
      stack_hint: [],
      memory_type: 'memory',
      created_at: new Date().toISOString(),
      status: 'pending',
    };

    const membership = buildTestMembership({ modPrivkey: null });
    const result = decryptPendingItem(item, membership);

    expect(result.decryptError).toBe('no moderation private key available');
    expect(result.plaintext).toBe('');
  });

  it('decryptPendingItem returns error on wrong mod key', () => {
    const realMod = generateIdentity();
    const wrongMod = generateIdentity();

    const dek = generateDek();
    const ciphertext = encryptSymmetric(new Uint8Array(Buffer.from('test', 'utf-8')), dek);
    const wrappedDekMod = sealToPubkey(dek, realMod.xPubkey);

    const item: PendingQueueItem = {
      submission_hash: 'abc',
      org_id: 'test-org',
      epoch_id: 0,
      contributor_pubkey: 'pub',
      ciphertext_hex: Buffer.from(ciphertext).toString('hex'),
      wrapped_dek_mod: Buffer.from(wrappedDekMod).toString('hex'),
      stack_hint: [],
      memory_type: 'memory',
      created_at: new Date().toISOString(),
      status: 'pending',
    };

    const membership = buildTestMembership({
      modPrivkey: wrongMod.xPrivkey,
    });

    const result = decryptPendingItem(item, membership);
    expect(result.decryptError).toBeDefined();
    expect(result.plaintext).toBe('');
  });

  it('full round-trip: encrypt → seal → unseal → decrypt → re-wrap → unwrap', () => {
    const masterKey = generateDek();
    const epochKeys = deriveEpochKeys(masterKey, 0);
    const modIdentity = generateIdentity();

    const plaintext = 'Important memory about Redis configuration patterns';
    const dek = generateDek();
    const ciphertext = encryptSymmetric(new Uint8Array(Buffer.from(plaintext, 'utf-8')), dek);
    const wrappedDekMod = sealToPubkey(dek, modIdentity.xPubkey);

    const recoveredDek = openEnvelope(wrappedDekMod, modIdentity.xPrivkey);
    expect(Buffer.from(recoveredDek)).toEqual(Buffer.from(dek));

    const recovered = decryptSymmetric(ciphertext, recoveredDek);
    expect(Buffer.from(recovered).toString('utf-8')).toBe(plaintext);

    const wrappedDekEnc = encryptSymmetric(recoveredDek, epochKeys.encKey);

    const memberDek = decryptSymmetric(wrappedDekEnc, epochKeys.encKey);
    expect(Buffer.from(memberDek)).toEqual(Buffer.from(dek));

    const memberDecrypted = decryptSymmetric(ciphertext, memberDek);
    expect(Buffer.from(memberDecrypted).toString('utf-8')).toBe(plaintext);
  });

  it('approveSubmission uses pending item memory_type in approval payload', async () => {
    const modIdentity = generateIdentity();
    vi.mocked(embedRetrievalCard).mockResolvedValueOnce({
      vector: Array.from({ length: 3072 }, (_, i) => i / 3072),
      cardText: 'card',
      embeddingModelId: 'test-embedding-model',
    });

    const plaintext = 'Moderation memory type override test payload';
    const dek = generateDek();
    const ciphertext = encryptSymmetric(new Uint8Array(Buffer.from(plaintext, 'utf-8')), dek);
    const wrappedDekMod = sealToPubkey(dek, modIdentity.xPubkey);

    const item: PendingQueueItem = {
      submission_hash: 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
      org_id: 'test-org',
      epoch_id: 0,
      contributor_pubkey: 'contributor_hex',
      ciphertext_hex: Buffer.from(ciphertext).toString('hex'),
      wrapped_dek_mod: Buffer.from(wrappedDekMod).toString('hex'),
      stack_hint: ['typescript'],
      memory_type: 'memory',
      mc_version: 1,
      created_at: new Date().toISOString(),
      status: 'pending',
    };

    const membership = buildTestMembership({
      modPrivkey: modIdentity.xPrivkey,
    });

    const loadIdentitySpy = vi.spyOn(keyStore, 'loadIdentity').mockResolvedValue(modIdentity);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'approved' }),
    } as Response);

    const result = await approveSubmission(
      'http://localhost:4440',
      'test-org',
      item,
      membership,
    );

    expect(result.status).toBe('approved');
    const approveCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes('/moderation/') && String(url).includes('/approve'));
    expect(approveCall).toBeDefined();
    const body = JSON.parse(String((approveCall?.[1] as { body?: string })?.body));
    expect(body.memory_type).toBe('memory');
    expect(body.mc_version).toBe(item.mc_version);
    expect(body.epoch_id).toBe(0);
    expect(body.signed_by).toBeDefined();
    expect(body.moderator_sig).toBeDefined();

    loadIdentitySpy.mockRestore();
  });
});

describe('denySubmission', () => {
  const hubUrl = 'http://localhost:4440';
  const orgId = 'test-org';
  const submissionHash = 'abc123';
  const reason = 'Inappropriate content';

  it('denies a submission and returns status denied on success', async () => {
    const identity = generateIdentity();

    vi.spyOn(await import('../src/key-store.js'), 'loadIdentity').mockResolvedValue(identity);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await denySubmission(hubUrl, orgId, submissionHash, reason);

    expect(result.status).toBe('denied');
    expect(fetch).toHaveBeenCalledWith(
      `${hubUrl}/v1/orgs/${orgId}/moderation/${submissionHash}/deny`,
      expect.objectContaining({ method: 'POST' })
    );

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(call[1].body);
    expect(body.reason).toBe(reason);
    expect(body.signed_by).toBe(Buffer.from(identity.edPubkey).toString('hex'));
    expect(body.signature).toBeDefined();
    expect(body.signature.length).toBeGreaterThan(0);
  });

  it('returns error when HTTP response is not ok', async () => {
    const identity = generateIdentity();

    vi.spyOn(await import('../src/key-store.js'), 'loadIdentity').mockResolvedValue(identity);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' }),
    } as Response);

    const result = await denySubmission(hubUrl, orgId, submissionHash, reason);

    expect(result.status).toBe('error');
    expect(result.error).toBe('forbidden');
  });

  it('returns error when no identity is in keychain', async () => {
    vi.spyOn(await import('../src/key-store.js'), 'loadIdentity').mockResolvedValue(null);

    const result = await denySubmission(hubUrl, orgId, submissionHash, reason);

    expect(result.status).toBe('error');
    expect(result.error).toBe('no identity in keychain');
  });
});
