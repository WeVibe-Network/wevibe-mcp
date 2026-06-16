import { describe, it, expect, vi, beforeEach } from 'vitest';
import { approveSubmission } from '../src/moderation.js';
import { computeLocalEmbedding } from '../src/embedding.js';
import { loadEmbeddingConfig } from '../src/embedding-config.js';
import { getLlmProvider } from '../src/llm.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockChat = vi.fn();

const mockEmbeddingConfig = {
  baseUrl: 'http://test.local/v1',
  apiKey: 'test',
  model: 'test-embedding-model',
  usePrefix: false,
};

let mockEmbeddingVector: number[] = [];

vi.mock('../src/embedding.js', () => ({
  computeLocalEmbedding: vi.fn(),
}));

vi.mock('../src/embedding-config.js', () => ({
  loadEmbeddingConfig: vi.fn(),
}));

vi.mock('../src/llm.js', () => ({
  getLlmProvider: vi.fn(),
}));

vi.mock('../src/crypto.js', () => ({
  initCrypto: vi.fn().mockResolvedValue(undefined),
  openEnvelope: vi.fn().mockReturnValue(new Uint8Array(32)),
  decryptSymmetric: vi.fn().mockReturnValue(new Uint8Array(Buffer.from('decrypted text content for embedding test'))),
  encryptSymmetric: vi.fn().mockReturnValue(new Uint8Array(64)),
  sign: vi.fn().mockReturnValue(new Uint8Array(64)),
}));

vi.mock('../src/key-store.js', () => ({
  loadIdentity: vi.fn().mockResolvedValue({
    edPrivkey: new Uint8Array(32),
    edPubkey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]),
    xPrivkey: new Uint8Array(32),
    xPubkey: new Uint8Array(32),
  }),
}));

vi.mock('../src/auth.js', () => ({
  buildWeVibeSignedAuth: vi.fn().mockResolvedValue({ headers: {} }),
}));

const mockMembership = {
  orgId: 'test-org',
  orgName: 'Test Org',
  role: 'moderator' as const,
  currentEpoch: 1,
  historyAccessFromEpoch: 1,
  egressMode: 'unrestricted' as const,
  allowedProviders: [],
  encKeys: new Map([[1, new Uint8Array(32)]]),
  searchKeys: new Map([[1, new Uint8Array(32)]]),
  modPrivkey: new Uint8Array(32),
  modPubkey: new Uint8Array(32),
};

const mockPendingItem = {
  submission_hash: 'abc123hash',
  org_id: 'test-org',
  epoch_id: 1,
  contributor_pubkey: 'contributor_pubkey_hex',
  ciphertext_hex: 'ciphertext_hex_value',
  wrapped_dek_mod: 'wrapped_dek_mod_hex',
  stack_hint: ['typescript', 'nodejs'],
  memory_type: 'memory' as const,
  created_at: new Date().toISOString(),
  status: 'pending',
};

function queueManifestAndApproveResponses() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
}

function buildMockVector(dim = 3072): number[] {
  return Array.from({ length: dim }, (_, i) => i / dim);
}

function findApproveCallBody(): Record<string, unknown> {
  const approveCall = mockFetch.mock.calls.find(([url]) =>
    String(url).includes('/moderation/') && String(url).includes('/approve'));

  if (!approveCall) {
    throw new Error('approve endpoint was not called');
  }

  return JSON.parse(String((approveCall[1] as { body?: string } | undefined)?.body));
}

describe('moderation approval flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockChat.mockReset();
    mockChat.mockResolvedValue('When this memory is needed during moderation review.');
    vi.mocked(getLlmProvider).mockReturnValue({ chat: mockChat } as ReturnType<typeof getLlmProvider>);
    mockEmbeddingVector = buildMockVector(19);
    vi.mocked(computeLocalEmbedding).mockResolvedValue(mockEmbeddingVector);
    vi.mocked(loadEmbeddingConfig).mockReturnValue(mockEmbeddingConfig);
  });

  it('sends epoch_id, memory_type, signed_by, and moderator_sig to hub', async () => {
    queueManifestAndApproveResponses();

    await approveSubmission('http://localhost:4440', 'test-org', mockPendingItem, mockMembership);

    expect(mockFetch).toHaveBeenCalled();
    const body = findApproveCallBody();

    expect(body.epoch_id).toBe(1);
    expect(body.memory_type).toBe('memory');
    expect(body.signed_by).toBeDefined();
    expect(body.moderator_sig).toBeDefined();
  });

  it('returns approved status with empty similarMemories array', async () => {
    queueManifestAndApproveResponses();

    const result = await approveSubmission('http://localhost:4440', 'test-org', mockPendingItem, mockMembership);

    expect(result.status).toBe('approved');
    expect(result.similarMemories).toEqual([]);
  });

  it('uses pending item memory_type and ignores legacy override argument', async () => {
    queueManifestAndApproveResponses();

    await approveSubmission('http://localhost:4440', 'test-org', mockPendingItem, mockMembership, 'negative_signal');

    const body = findApproveCallBody();
    expect(body.memory_type).toBe('memory');
  });

  it('includes retrieval-card embedding fields when embedding succeeds', async () => {
    queueManifestAndApproveResponses();

    await approveSubmission('http://localhost:4440', 'test-org', mockPendingItem, mockMembership);

    const body = findApproveCallBody();

    expect(Array.isArray(body.vector)).toBe(true);
    expect((body.vector as number[])).toHaveLength(mockEmbeddingVector.length);
    expect(body.embedding_model_id).toBe(mockEmbeddingConfig.model);
    expect(body.embedding_schema_version).toBe('retrieval-card-v1');
    expect(body.vector_dim).toBe(mockEmbeddingVector.length);

    expect(body.keywords).toBeUndefined();
    expect(body.keyword_weights).toBeUndefined();
    expect(body.approved_cid).toBeUndefined();
    expect(body.umbral_capsule).toBeUndefined();
    expect(body.umbral_ciphertext).toBeUndefined();
    expect(body.content_flags).toBeUndefined();
  });

  it('still approves when embedding fails and omits vector fields', async () => {
    queueManifestAndApproveResponses();
    vi.mocked(computeLocalEmbedding).mockRejectedValueOnce(new Error('embedding offline'));

    const result = await approveSubmission('http://localhost:4440', 'test-org', mockPendingItem, mockMembership);

    expect(result.status).toBe('approved');

    const body = findApproveCallBody();
    expect(body.vector).toBeUndefined();
    expect(body.embedding_model_id).toBeUndefined();
    expect(body.embedding_schema_version).toBeUndefined();
    expect(body.vector_dim).toBeUndefined();
  });

  it('still approves when embedding config load fails and omits vector fields', async () => {
    queueManifestAndApproveResponses();
    vi.mocked(loadEmbeddingConfig).mockImplementationOnce(() => {
      throw new Error('OpenRouter API key missing or masked in dashboard.json; paste a real key');
    });

    const result = await approveSubmission('http://localhost:4440', 'test-org', mockPendingItem, mockMembership);

    expect(result.status).toBe('approved');

    const body = findApproveCallBody();
    expect(body.vector).toBeUndefined();
    expect(body.embedding_model_id).toBeUndefined();
    expect(body.embedding_schema_version).toBeUndefined();
    expect(body.vector_dim).toBeUndefined();
  });
});
