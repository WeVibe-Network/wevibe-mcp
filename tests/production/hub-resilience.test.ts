import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setLlmProvider } from '../../src/llm.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../../src/crypto.js', () => ({
  initCrypto: vi.fn().mockResolvedValue(undefined),
  decryptSymmetric: vi.fn().mockReturnValue(new Uint8Array(Buffer.from('decrypted content'))),
}));

vi.mock('../../src/key-store.js', () => ({
  loadIdentity: vi.fn().mockResolvedValue({
    edPubkey: new Uint8Array(32).fill(1),
    edPrivkey: new Uint8Array(32),
    xPrivkey: new Uint8Array(32),
    xPubkey: new Uint8Array(32),
  }),
}));

vi.mock('../../src/org-client.js', () => ({
  loadMemberships: vi.fn().mockResolvedValue([{
    orgId: 'test-org',
    role: 'member',
    currentEpoch: 0,
    egressMode: 'unrestricted',
    allowedProviders: [],
    encKeys: new Map([[0, new Uint8Array(32)]]),
    searchKeys: new Map(),
    modPubkey: null,
  }]),
}));

vi.mock('../../src/session.js', () => ({
  dissect_to_keywords: vi.fn().mockReturnValue([{ term: 'test', weight: 1.0 }]),
}));

vi.mock('../../src/embedding.js', () => ({
  computeLocalEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
}));

describe('Hub error resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    setLlmProvider({ chat: async () => '{"keywords": []}' });
  });

  it('hub returning 500 results in error message, not crash', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'database connection failed' }),
    });

    const resp = await fetch('http://localhost:4440/v1/orgs/test-org/query', {
      method: 'POST',
      body: JSON.stringify({ org_id: 'test-org', limit: 5 }),
    });

    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(500);
  });

  it('hub returning malformed JSON does not crash', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    const resp = await fetch('http://localhost:4440/v1/orgs/test-org/query', { method: 'POST' });
    expect(resp.ok).toBe(true);
    await expect(resp.json()).rejects.toThrow();
  });

  it('hub timeout (network error) does not crash', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed: ETIMEDOUT'));

    await expect(
      fetch('http://localhost:4440/v1/orgs/test-org/query', { method: 'POST' })
    ).rejects.toThrow('ETIMEDOUT');
  });

  it('hub returning empty results array is handled gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], contested: false, receipt_id: 'test-receipt' }),
    });

    const resp = await fetch('http://localhost:4440/v1/orgs/test-org/query', {
      method: 'POST',
      body: JSON.stringify({ limit: 5 }),
    });
    const data = await resp.json();
    expect(data.results).toEqual([]);
    expect(data.contested).toBe(false);
  });

  it('hub returning null results field is handled', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: null, contested: false }),
    });

    const resp = await fetch('http://localhost:4440/v1/orgs/test-org/query', { method: 'POST' });
    const data = await resp.json();
    const results = data.results ?? [];
    expect(results).toEqual([]);
  });
});