import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, chmodSync } from 'node:fs';
import { submitMemory } from '../src/contribution.js';
import { submitMemoryMessage } from '../src/canonical.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/crypto.js', () => ({
  initCrypto: vi.fn().mockResolvedValue(undefined),
  generateDek: vi.fn().mockReturnValue(new Uint8Array(32)),
  encryptSymmetric: vi.fn().mockReturnValue(new Uint8Array(64)),
  sealToPubkey: vi.fn().mockReturnValue(new Uint8Array(64)),
  sign: vi.fn().mockReturnValue(new Uint8Array(64)),
}));

vi.mock('../src/key-store.js', () => ({
  loadIdentity: vi.fn().mockResolvedValue({
    edPrivkey: new Uint8Array(32),
    edPubkey: new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ]),
    xPrivkey: new Uint8Array(32),
    xPubkey: new Uint8Array(32),
  }),
}));

vi.mock('../src/pending-vault.js', () => ({
  storePendingDek: vi.fn().mockResolvedValue(undefined),
}));

function createMockGuard(response: object): string {
  const scriptPath = `/tmp/mock-wevibe-guard-${Math.random().toString(36).slice(2)}.sh`;
  writeFileSync(scriptPath, `#!/bin/sh\necho '${JSON.stringify(response)}'`);
  chmodSync(scriptPath, '755');
  return scriptPath;
}

describe('wevibe-guard integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, WEVIBE_KEYSTORE_TEST: '1' };
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('warns but proceeds when scanner detects credential', async () => {
    const mockGuard = createMockGuard({ passed: false, detections: [{ scanner: 'credentials', rule: 'aws_access_key', matched: 'AKIA...' }], flags: null });
    process.env.WEVIBE_GUARD_BIN = mockGuard;

    const result = await submitMemory(
      'AKIAIOSFODNN7EXAMPLE in the redis config',
      'test-org',
      'http://localhost:4440',
      { orgId: 'test-org', orgName: 'Test', role: 'member', currentEpoch: 1, historyAccessFromEpoch: 1, egressMode: 'unrestricted', allowedProviders: [], encKeys: new Map(), searchKeys: new Map(), modPubkey: new Uint8Array(32) },
      'negative_signal'
    );
    expect(result.status).toBe('pending');
    expect(result.submissionHash).toBeDefined();
  });

  it('proceeds when scanner passes', async () => {
    const mockGuard = createMockGuard({ passed: true, detections: [], flags: [] });
    process.env.WEVIBE_GUARD_BIN = mockGuard;

    const result = await submitMemory(
      'redis connection timeout after 30s, fixed by increasing timeout to 60s',
      'test-org',
      'http://localhost:4440',
      { orgId: 'test-org', orgName: 'Test', role: 'member', currentEpoch: 1, historyAccessFromEpoch: 1, egressMode: 'unrestricted', allowedProviders: [], encKeys: new Map(), searchKeys: new Map(), modPubkey: null },
      'correct_implementation'
    );
    expect(result.status).not.toBe('rejected_local');
  });

  it('scanner receives stack hint', async () => {
    let receivedInput = '';
    const mockGuard = createMockGuard({ passed: true, detections: [], flags: [] });
    process.env.WEVIBE_GUARD_BIN = mockGuard;

    const customGuard = `/tmp/mock-wevibe-guard-input-${Math.random().toString(36).slice(2)}.sh`;
    writeFileSync(customGuard, `#!/bin/sh
cat > /tmp/guard_input.json
echo '{"passed":true,"detections":[],"flags":[]}'`);
    chmodSync(customGuard, '755');
    process.env.WEVIBE_GUARD_BIN = customGuard;

    await submitMemory(
      'test memory with stack hint',
      'test-org',
      'http://localhost:4440',
      { orgId: 'test-org', orgName: 'Test', role: 'member', currentEpoch: 1, historyAccessFromEpoch: 1, egressMode: 'unrestricted', allowedProviders: [], encKeys: new Map(), searchKeys: new Map(), modPubkey: null },
      'correct_implementation',
      ['typescript', 'node']
    );
  });
});

describe('submitMemory payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    process.env = { ...process.env, WEVIBE_KEYSTORE_TEST: '1' };
  });

  it('includes contributor_pubkey and epoch_id in payload', async () => {
    const mockGuard = createMockGuard({ passed: true, detections: [], flags: [] });
    process.env.WEVIBE_GUARD_BIN = mockGuard;

    const membership = {
      orgId: 'test-org',
      orgName: 'Test',
      role: 'member' as const,
      currentEpoch: 5,
      historyAccessFromEpoch: 1,
      egressMode: 'unrestricted' as const,
      allowedProviders: [],
      encKeys: new Map(),
      searchKeys: new Map(),
      modPubkey: new Uint8Array(32),
    };

    await submitMemory(
      'valid memory content that is long enough to pass the 50 char check',
      'test-org',
      'http://localhost:4440',
      membership,
      'correct_implementation',
      ['typescript']
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledWith = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse((calledWith[1] as RequestInit).body as string);

    expect(body).toHaveProperty('contributor_pubkey');
    expect(body.contributor_pubkey).toBeTruthy();
    expect(body.contributor_pubkey.length).toBe(64);

    expect(body).toHaveProperty('epoch_id');
    expect(body.epoch_id).toBe(5);
    expect(body).toHaveProperty('memory_type');
    expect(body.memory_type).toBe('correct_implementation');
  });

  it('returns explicit error when memory_type is missing', async () => {
    const mockGuard = createMockGuard({ passed: true, detections: [], flags: [] });
    process.env.WEVIBE_GUARD_BIN = mockGuard;

    const membership = {
      orgId: 'test-org',
      orgName: 'Test',
      role: 'member' as const,
      currentEpoch: 5,
      historyAccessFromEpoch: 1,
      egressMode: 'unrestricted' as const,
      allowedProviders: [],
      encKeys: new Map(),
      searchKeys: new Map(),
      modPubkey: new Uint8Array(32),
    };

    const result = await submitMemory(
      'valid memory content that is long enough to pass the 50 char check',
      'test-org',
      'http://localhost:4440',
      membership,
      undefined as unknown as 'correct_implementation',
      ['typescript']
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('memory_type is required, did Pass 1 extraction run?');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('signs canonical submit message that includes memory_type', async () => {
    const mockGuard = createMockGuard({ passed: true, detections: [], flags: [] });
    process.env.WEVIBE_GUARD_BIN = mockGuard;

    const membership = {
      orgId: 'test-org',
      orgName: 'Test',
      role: 'member' as const,
      currentEpoch: 5,
      historyAccessFromEpoch: 1,
      egressMode: 'unrestricted' as const,
      allowedProviders: [],
      encKeys: new Map(),
      searchKeys: new Map(),
      modPubkey: new Uint8Array(32),
    };

    const result = await submitMemory(
      'valid memory content that is long enough to pass the 50 char check',
      'test-org',
      'http://localhost:4440',
      membership,
      'negative_signal',
      ['typescript']
    );

    expect(result.status).toBe('pending');
    expect(result.submissionHash).toBeTruthy();

    const cryptoMod = await import('../src/crypto.js');
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse((opts.body as string) ?? '{}') as {
      submission_hash: string;
      contributor_pubkey: string;
      memory_type: string;
      ciphertext_hash: string;
      plaintext_hash: string;
      salt: string;
      wrapped_dek_hash: string;
    };

    const expectedCanonical = submitMemoryMessage(
      'test-org',
      membership.currentEpoch,
      body.submission_hash,
      body.contributor_pubkey,
      body.memory_type as any,
      body.ciphertext_hash,
      body.plaintext_hash,
      body.salt,
      body.wrapped_dek_hash,
    );

    expect(cryptoMod.sign).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expectedCanonical,
    );
  });
});
