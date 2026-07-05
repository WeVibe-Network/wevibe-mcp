import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFetch,
  getOrgHubStateMock,
  setOrgHubStateMock,
  loadEmbeddingConfigMock,
} = vi.hoisted(() => {
  const mockFetch = vi.fn();
  const getOrgHubStateMock = vi.fn();
  const setOrgHubStateMock = vi.fn();
  const loadEmbeddingConfigMock = vi.fn();
  return {
    mockFetch,
    getOrgHubStateMock,
    setOrgHubStateMock,
    loadEmbeddingConfigMock,
  };
});

vi.stubGlobal('fetch', mockFetch);

vi.mock('../src/identity-sidecar.js', () => ({
  getOrgHubState: getOrgHubStateMock,
  setOrgHubState: setOrgHubStateMock,
}));

import { initCrypto, generateIdentity, sign } from '../src/crypto.js';
import { HubSignatureError, hubFetchVerified } from '../src/hub-fetch.js';

function signHubBody(edPrivkey: Uint8Array, bodyText: string): string {
  const bodyBytes = new TextEncoder().encode(bodyText);
  const digest = new Uint8Array(createHash('sha256').update(bodyBytes).digest());
  const signature = sign(edPrivkey, digest);
  return Buffer.from(signature).toString('hex');
}

function orgStateWithPubkey(pubkeyHex: string): {
  hubEndpoints: string[];
  activeHubEndpoint: string | null;
  hubServingAddress: string | null;
  hubResponsePubkey: string | null;
  updatedAt: string | null;
} {
  return {
    hubEndpoints: [],
    activeHubEndpoint: null,
    hubServingAddress: null,
    hubResponsePubkey: pubkeyHex,
    updatedAt: null,
  };
}

describe('hubFetchVerified', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('accepts valid hub signature and returns parsed JSON', async () => {
    const identity = generateIdentity();
    const pubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
    const bodyText = JSON.stringify({ ok: true, result: ['a', 'b'] });
    const signatureHex = signHubBody(identity.edPrivkey, bodyText);

    getOrgHubStateMock.mockReturnValue(orgStateWithPubkey(pubkeyHex));
    mockFetch.mockResolvedValueOnce(
      new Response(bodyText, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature': signatureHex,
        },
      }),
    );

    const verified = await hubFetchVerified('org-valid-signature', 'https://hub.example/v1/orgs/org-valid-signature/query');

    expect(verified.res.status).toBe(200);
    expect(verified.bodyText).toBe(bodyText);
    expect(verified.json<{ ok: boolean; result: string[] }>()).toEqual({ ok: true, result: ['a', 'b'] });
  });

  it('throws HubSignatureError when published pubkey is present but signature is missing or bad', async () => {
    const identity = generateIdentity();
    const pubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
    const bodyText = JSON.stringify({ status: 'ok' });

    getOrgHubStateMock.mockReturnValue(orgStateWithPubkey(pubkeyHex));

    mockFetch.mockResolvedValueOnce(
      new Response(bodyText, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      hubFetchVerified('org-missing-signature', 'https://hub.example/v1/orgs/org-missing-signature/query'),
    ).rejects.toBeInstanceOf(HubSignatureError);

    mockFetch.mockResolvedValueOnce(
      new Response(bodyText, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature': '00'.repeat(64),
        },
      }),
    );

    await expect(
      hubFetchVerified('org-bad-signature', 'https://hub.example/v1/orgs/org-bad-signature/query'),
    ).rejects.toBeInstanceOf(HubSignatureError);
  });

  it('fails open when no hub_response_pubkey is published and warns once per org', async () => {
    const orgId = 'org-no-pubkey-rollout';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getOrgHubStateMock.mockReturnValue({
      hubEndpoints: [],
      activeHubEndpoint: null,
      hubServingAddress: null,
      hubResponsePubkey: null,
      updatedAt: null,
    });

    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ pass: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const first = await hubFetchVerified(orgId, `https://hub.example/v1/orgs/${orgId}/query`);
    const second = await hubFetchVerified(orgId, `https://hub.example/v1/orgs/${orgId}/query`);

    expect(first.json<{ pass: boolean }>().pass).toBe(true);
    expect(second.json<{ pass: boolean }>().pass).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(`hub response signature not verified for ${orgId}: no hub_response_pubkey published yet`);

    warnSpy.mockRestore();
  });
});

describe('retrieve failover on hub signature mismatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('marks the current endpoint bad and retries once on next endpoint', async () => {
    const queryOrgMemoriesMock = vi.fn()
      .mockRejectedValueOnce(new HubSignatureError('signature mismatch'))
      .mockResolvedValueOnce({ results: [] });
    const dissectToKeywordsMock = vi.fn().mockReturnValue([
      { term: 'redis', weight: 1.0 },
    ]);
    const computeLocalEmbeddingMock = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

    const pickActiveEndpointMock = vi.fn().mockResolvedValue('https://hub-b.example');
    const getActiveHubUrlForOrgMock = vi.fn().mockReturnValue('https://hub-a.example');

    getOrgHubStateMock.mockImplementation((orgId: string) => {
      if (orgId !== 'org-1') {
        return null;
      }
      return {
        hubEndpoints: ['https://hub-a.example', 'https://hub-b.example'],
        activeHubEndpoint: 'https://hub-a.example',
        hubServingAddress: null,
        hubResponsePubkey: null,
        updatedAt: null,
      };
    });

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
      queryOrgMemories: queryOrgMemoriesMock,
      decryptMemoryBlob: vi.fn(),
    }));

    vi.doMock('../src/session.js', () => ({
      dissect_to_keywords: dissectToKeywordsMock,
    }));

    vi.doMock('../src/embedding.js', () => ({
      computeLocalEmbedding: computeLocalEmbeddingMock,
    }));

    vi.doMock('../src/embedding-config.js', () => ({
      loadEmbeddingConfig: loadEmbeddingConfigMock,
    }));

    vi.doMock('../src/deserialize.js', () => ({
      deserializeMemoryResult: vi.fn(),
    }));

    vi.doMock('../src/artifact-extract.js', () => ({
      extractArtifacts: vi.fn().mockReturnValue({
        artifacts: [],
        summary: {
          url: 0,
          domain: 0,
          ip_address: 0,
          shell_command: 0,
          package_install: 0,
          config_directive: 0,
          credential_like: 0,
        },
      }),
    }));

    vi.doMock('../src/artifact-policy.js', () => ({
      checkArtifactPolicy: vi.fn().mockReturnValue([]),
    }));

    vi.doMock('../src/artifact-transform.js', () => ({
      transformMemoryContent: vi.fn().mockImplementation((text: string) => ({
        text,
        annotations: [],
        redactedCount: 0,
        annotatedCount: 0,
      })),
    }));

    vi.doMock('../src/trust-panel.js', () => ({
      formatTrustPanel: vi.fn(),
    }));

    vi.doMock('../src/blacklist.js', () => ({
      is_blacklisted: vi.fn().mockReturnValue(false),
    }));

    vi.doMock('../src/auth.js', () => ({
      buildWeVibeSignedAuth: vi.fn().mockResolvedValue({ headers: {} }),
    }));

    vi.doMock('../src/config.js', () => ({
      HUB_URL: 'https://hub-default.example',
      EMBEDDING_MODEL: 'test-embedding-model',
    }));

    vi.doMock('../src/hub-resolver.js', () => ({
      getActiveHubUrlForOrg: getActiveHubUrlForOrgMock,
      pickActiveEndpoint: pickActiveEndpointMock,
    }));

    loadEmbeddingConfigMock.mockReturnValue({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      model: 'test-embedding-model',
      usePrefix: false,
    });

    const { retrieve } = await import('../src/retrieve-cli.js');
    const result = await retrieve({
      query: 'redis config',
      org_id: 'org-1',
      technologies: ['redis', 'typescript'],
      recentActivity: ['ECONNREFUSED'],
    });

    expect(result).toEqual({
      status: 'ok',
      memories: [],
      org_allowed_providers: ['openai'],
    });

    expect(dissectToKeywordsMock).toHaveBeenCalledTimes(1);
    const keywordContext = dissectToKeywordsMock.mock.calls[0][0] as {
      description: string;
      technologies: string[];
      recentActivity: string[];
    };
    expect(keywordContext.description).toContain('redis config');
    expect(keywordContext.description).toContain('redis');
    expect(keywordContext.description).toContain('typescript');
    expect(keywordContext.technologies).toEqual(['redis', 'typescript']);
    expect(keywordContext.recentActivity).toEqual(['ECONNREFUSED']);

    expect(computeLocalEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(computeLocalEmbeddingMock).toHaveBeenCalledWith(
      expect.stringMatching(/^Intent:/),
      { role: 'query', prefix: true },
      expect.objectContaining({
        model: 'test-embedding-model',
      }),
    );
    const embeddedText = computeLocalEmbeddingMock.mock.calls[0][0] as string;
    expect(embeddedText).toContain('Task: redis config');

    expect(queryOrgMemoriesMock).toHaveBeenCalledTimes(2);
    expect(queryOrgMemoriesMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ hubUrl: 'https://hub-a.example' }));
    expect(queryOrgMemoriesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ hubUrl: 'https://hub-b.example' }));

    expect(pickActiveEndpointMock).toHaveBeenCalledTimes(1);
    expect(pickActiveEndpointMock).toHaveBeenCalledWith(
      ['https://hub-a.example', 'https://hub-b.example'],
      expect.objectContaining({ skipEndpoint: expect.any(Function) }),
    );

    const pickOpts = pickActiveEndpointMock.mock.calls[0][1] as { skipEndpoint(endpoint: string): boolean };
    expect(pickOpts.skipEndpoint('https://hub-a.example')).toBe(true);
    expect(pickOpts.skipEndpoint('https://hub-b.example')).toBe(false);

    expect(setOrgHubStateMock).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ activeHubEndpoint: 'https://hub-b.example' }),
    );
  });
});

describe('retrieve no-membership lifecycle handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  function mockRetrieveDeps(loadMembershipsMock: ReturnType<typeof vi.fn>): void {
    vi.doMock('../src/key-store.js', () => ({
      loadIdentity: vi.fn().mockResolvedValue({
        edPubkey: new Uint8Array(32).fill(1),
      }),
    }));

    vi.doMock('../src/org-client.js', () => ({
      loadMemberships: loadMembershipsMock,
      queryOrgMemories: vi.fn(),
      decryptMemoryBlob: vi.fn(),
    }));

    vi.doMock('../src/auth.js', () => ({
      buildWeVibeSignedAuth: vi.fn().mockResolvedValue({ headers: {} }),
    }));

    vi.doMock('../src/config.js', () => ({
      HUB_URL: 'https://hub-default.example',
      EMBEDDING_MODEL: 'test-embedding-model',
    }));
  }

  it('returns graceful empty no_membership when identity has zero org memberships', async () => {
    const loadMembershipsMock = vi.fn().mockResolvedValue([]);
    mockRetrieveDeps(loadMembershipsMock);

    const { retrieve } = await import('../src/retrieve-cli.js');
    const result = await retrieve({
      query: 'redis config',
      org_id: 'org-1',
      technologies: ['redis', 'typescript'],
      recentActivity: ['ECONNREFUSED'],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected retrieve to return status=ok');
    }

    expect(result.reason_code).toBe('no_membership');
    expect(result).toMatchObject({
      status: 'ok',
      memories: [],
      org_allowed_providers: [],
      reason_code: 'no_membership',
      reason: 'identity has no org membership yet (not onboarded to any org)',
    });
  });

  it('keeps loadMemberships transport failures loud as status=error', async () => {
    const loadMembershipsMock = vi.fn().mockRejectedValue(new Error('hub unreachable'));
    mockRetrieveDeps(loadMembershipsMock);

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

    expect(result.error).toContain('failed to load org memberships');
  });
});
