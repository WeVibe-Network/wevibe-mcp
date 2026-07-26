import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadEmbeddingConfigMock, logOpMock } = vi.hoisted(() => {
  const loadEmbeddingConfigMock = vi.fn();
  const logOpMock = vi.fn();
  return {
    loadEmbeddingConfigMock,
    logOpMock,
  };
});

vi.mock('../src/logger.js', async () => ({
  ...(await vi.importActual('../src/logger.js')),
  logOp: logOpMock,
}));

describe('retrieve embedding dimension guard', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  function mockRetrieveDeps(params: {
    computeLocalEmbeddingMock: ReturnType<typeof vi.fn>;
    queryOrgMemoriesMock: ReturnType<typeof vi.fn>;
  }): void {
    vi.doMock('../src/key-store.js', () => ({
      loadIdentity: vi.fn().mockResolvedValue({
        edPubkey: new Uint8Array(32).fill(1),
      }),
    }));

    vi.doMock('../src/org-client.js', () => ({
      loadMemberships: vi.fn().mockResolvedValue([
        {
          orgId: 'org-1',
          allowedProviders: ['openai'],
          egressMode: 'unrestricted',
        },
      ]),
      queryOrgMemories: params.queryOrgMemoriesMock,
      decryptMemoryBlob: vi.fn(),
      getOrgKeywords: vi.fn().mockResolvedValue(['redis']),
    }));

    vi.doMock('../src/session.js', () => ({
      dissect_to_keywords: vi.fn().mockReturnValue([
        { term: 'redis', weight: 1.0 },
      ]),
    }));

    vi.doMock('../src/embedding.js', async () => ({
      ...(await vi.importActual('../src/embedding.js')),
      computeLocalEmbedding: params.computeLocalEmbeddingMock,
    }));

    vi.doMock('../src/embedding-config.js', () => ({
      loadEmbeddingConfig: loadEmbeddingConfigMock,
    }));

    vi.doMock('../src/auth.js', () => ({
      buildWeVibeSignedAuth: vi.fn().mockResolvedValue({ headers: {} }),
    }));

    vi.doMock('../src/config.js', () => ({
      HUB_URL: 'https://hub-default.example',
      EMBEDDING_MODEL: 'test-embedding-model',
    }));

    vi.doMock('../src/hub-resolver.js', () => ({
      getActiveHubUrlForOrg: vi.fn().mockReturnValue('https://hub-default.example'),
      pickActiveEndpoint: vi.fn(),
    }));

    loadEmbeddingConfigMock.mockReturnValue({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      model: 'test-embedding-model',
      usePrefix: false,
    });
  }

  it('returns error and avoids hub call when query embedding dimension mismatches expected 768', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const computeLocalEmbeddingMock = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const queryOrgMemoriesMock = vi.fn();
    mockRetrieveDeps({ computeLocalEmbeddingMock, queryOrgMemoriesMock });

    const { retrieve } = await import('../src/retrieve-cli.js');
    const result = await retrieve({
      query: 'redis config',
      org_id: 'org-1',
      technologies: ['redis', 'typescript'],
      recentActivity: ['ECONNREFUSED'],
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') {
      throw new Error('expected retrieve to return status=error');
    }
    expect(result.error).toContain('dimension mismatch');
    expect(result.error).toContain('768');
    expect(queryOrgMemoriesMock).not.toHaveBeenCalled();

    const mismatchCalls = errorSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[recall] embedding dimension mismatch'),
    );
    expect(mismatchCalls.length).toBeGreaterThan(0);
    const [format, expectedDim, actualDim] = mismatchCalls[0] as [string, number, number, ...unknown[]];
    expect(format).toContain('expected_dim=%d actual_dim=%d');
    expect(expectedDim).toBe(768);
    expect(actualDim).toBe(3);

    errorSpy.mockRestore();
  });

  it('logs expected_dim and proceeds to hub query when embedding dimension is 768', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const computeLocalEmbeddingMock = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const queryOrgMemoriesMock = vi.fn().mockResolvedValue({ results: [] });
    mockRetrieveDeps({ computeLocalEmbeddingMock, queryOrgMemoriesMock });

    const { retrieve } = await import('../src/retrieve-cli.js');
    const result = await retrieve({
      query: 'redis config',
      org_id: 'org-1',
      technologies: ['redis', 'typescript'],
      recentActivity: ['ECONNREFUSED'],
    });

    expect(result).toMatchObject({
      status: 'ok',
      memories: [],
      org_allowed_providers: ['openai'],
    });
    expect(queryOrgMemoriesMock).toHaveBeenCalledTimes(1);

    const embeddingComputedCalls = errorSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[recall] embedding computed'),
    );
    expect(embeddingComputedCalls.length).toBeGreaterThan(0);
    const [format, vectorDim, expectedDim] = embeddingComputedCalls[0] as [string, number, number, ...unknown[]];
    expect(format).toContain('vector_dim=%d expected_dim=%d');
    expect(vectorDim).toBe(768);
    expect(expectedDim).toBe(768);

    errorSpy.mockRestore();
  });
});
