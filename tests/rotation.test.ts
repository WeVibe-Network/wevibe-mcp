process.env.WEVIBE_KEYSTORE_TEST = '1';
process.env.WEVIBE_VAULT_PATH = '/tmp/test-rotation-vault.enc';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/crypto.js', () => ({
  initCrypto: vi.fn().mockResolvedValue(undefined),
  generateIdentity: vi.fn().mockReturnValue({
    edPrivkey: new Uint8Array(32),
    edPubkey: new Uint8Array(32),
    xPrivkey: new Uint8Array(32),
    xPubkey: new Uint8Array(32),
  }),
  deriveEpochKeys: vi.fn().mockReturnValue({
    encKey: new Uint8Array(32),
    searchKey: new Uint8Array(32),
  }),
  sealToPubkey: vi.fn().mockReturnValue(new Uint8Array(100)),
  sign: vi.fn().mockReturnValue(new Uint8Array(64)),
}));

const mockKeyStore = new Map<string, Uint8Array>();

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
  storeKeyEnvelope: vi.fn().mockImplementation(async (orgId: string, type: string, blob: Uint8Array) => {
    mockKeyStore.set(`${orgId}-${type}`, blob);
  }),
  loadKeyEnvelope: vi.fn().mockImplementation(async (orgId: string, type: string) => {
    return mockKeyStore.get(`${orgId}-${type}`) ?? null;
  }),
}));

vi.mock('../src/vault.js', () => ({
  isVaultUnlocked: vi.fn().mockReturnValue(false),
  updateVaultEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/canonical.js', () => ({
  createOrgMessage: vi.fn().mockReturnValue(new Uint8Array(100)),
  inviteMemberMessage: vi.fn().mockReturnValue(new Uint8Array(100)),
  rotateEpochMessage: vi.fn().mockReturnValue(new Uint8Array(100)),
}));

describe('rotateEpoch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockKeyStore.clear();
  });

  it('returns error when no identity exists', async () => {
    const { loadIdentity } = await import('../src/key-store.js');
    vi.mocked(loadIdentity).mockResolvedValueOnce(null);

    const { rotateEpoch } = await import('../src/org-client.js');

    const result = await rotateEpoch({
      orgId: 'test-org',
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('no identity in keychain');
  });

  it('returns error when no master key exists', async () => {
    const { loadIdentity } = await import('../src/key-store.js');
    const { loadKeyEnvelope } = await import('../src/key-store.js');
    vi.mocked(loadIdentity).mockResolvedValue({
      edPrivkey: new Uint8Array(32),
      edPubkey: new Uint8Array(32),
      xPrivkey: new Uint8Array(32),
      xPubkey: new Uint8Array(32),
    });
    vi.mocked(loadKeyEnvelope).mockResolvedValueOnce(null);

    const { rotateEpoch } = await import('../src/org-client.js');

    const result = await rotateEpoch({
      orgId: 'test-org',
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('no master key found for this org — only the org leader can rotate');
  });

  it('constructs correct envelope count for active members', async () => {
    mockKeyStore.set('test-org-master', new Uint8Array(32));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ current_epoch: 0 }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { pubkey: 'pk1', x25519_pubkey: 'x25519_pk1'.repeat(4), role: 'leader', active: true },
        { pubkey: 'pk2', x25519_pubkey: 'x25519_pk2'.repeat(4), role: 'moderator', active: true },
        { pubkey: 'pk3', x25519_pubkey: 'x25519_pk3'.repeat(4), role: 'member', active: true },
      ]),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ buffered_moved: 0 }),
    });

    const { rotateEpoch } = await import('../src/org-client.js');

    const result = await rotateEpoch({
      orgId: 'test-org',
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('rotated');
    expect(result.membersRekeyed).toBe(3);
  });

  it('generates new mod keypair distinct from previous', async () => {
    mockKeyStore.set('test-org-master', new Uint8Array(32));

    let callCount = 0;
    const { generateIdentity } = await import('../src/crypto.js');
    vi.mocked(generateIdentity).mockImplementation(() => {
      callCount++;
      return {
        edPrivkey: new Uint8Array(32),
        edPubkey: new Uint8Array(32),
        xPrivkey: new Uint8Array(32).map((_, i) => callCount * 10 + i),
        xPubkey: new Uint8Array(32).map((_, i) => callCount * 10 + i),
      };
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ current_epoch: 0 }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { pubkey: 'pk1', x25519_pubkey: 'x25519_pk1'.repeat(4), role: 'leader', active: true },
      ]),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ buffered_moved: 0 }),
    });

    const { rotateEpoch } = await import('../src/org-client.js');

    const result = await rotateEpoch({
      orgId: 'test-org',
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('rotated');
    expect(generateIdentity).toHaveBeenCalled();
  });

  it('updates vault after successful rotation', async () => {
    mockKeyStore.set('test-org-master', new Uint8Array(32));

    const { isVaultUnlocked, updateVaultEntry } = await import('../src/vault.js');
    vi.mocked(isVaultUnlocked).mockReturnValue(true);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ current_epoch: 0 }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { pubkey: 'pk1', x25519_pubkey: 'x25519_pk1'.repeat(4), role: 'leader', active: true },
      ]),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ buffered_moved: 0 }),
    });

    const { rotateEpoch } = await import('../src/org-client.js');

    const result = await rotateEpoch({
      orgId: 'test-org',
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('rotated');
    expect(result.newEpoch).toBe(1);
    expect(mockKeyStore.has('test-org-mod-privkey')).toBe(true);
    expect(updateVaultEntry).toHaveBeenCalledWith('test-org', expect.objectContaining({
      sk_mod_hex: expect.any(String),
      current_epoch: 1,
    }));
  });
});
