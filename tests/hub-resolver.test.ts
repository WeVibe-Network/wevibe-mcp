import { beforeEach, describe, expect, it, vi } from 'vitest';

type OrgHubState = {
  hubEndpoints: string[];
  activeHubEndpoint: string | null;
  hubServingAddress: string | null;
  hubResponsePubkey: string | null;
  updatedAt: string | null;
};

const {
  mockFetch,
  sidecarState,
  readIdentitySidecarMock,
  getOrgHubStateMock,
  setOrgHubStateMock,
  loadMembershipsMock,
} = vi.hoisted(() => {
  const mockFetch = vi.fn();
  const sidecarState: { orgs: Record<string, OrgHubState> } = {
    orgs: {},
  };
  const readIdentitySidecarMock = vi.fn(() => ({ orgs: sidecarState.orgs }));
  const getOrgHubStateMock = vi.fn((orgId: string) => sidecarState.orgs[orgId] ?? null);
  const setOrgHubStateMock = vi.fn((orgId: string, patch: Partial<OrgHubState>) => {
    const existing = sidecarState.orgs[orgId] ?? {
      hubEndpoints: [],
      activeHubEndpoint: null,
      hubServingAddress: null,
      hubResponsePubkey: null,
      updatedAt: null,
    };
    sidecarState.orgs[orgId] = {
      ...existing,
      ...patch,
      hubEndpoints: patch.hubEndpoints ?? existing.hubEndpoints,
    };
    return { orgs: sidecarState.orgs };
  });
  const loadMembershipsMock = vi.fn();
  return {
    mockFetch,
    sidecarState,
    readIdentitySidecarMock,
    getOrgHubStateMock,
    setOrgHubStateMock,
    loadMembershipsMock,
  };
});

vi.stubGlobal('fetch', mockFetch);

vi.mock('../src/identity-sidecar.js', () => ({
  readIdentitySidecar: readIdentitySidecarMock,
  getOrgHubState: getOrgHubStateMock,
  setOrgHubState: setOrgHubStateMock,
}));

vi.mock('../src/org-client.js', () => ({
  loadMemberships: loadMembershipsMock,
}));

import { CHAIN_REST_URL } from '../src/config.js';
import { pickActiveEndpoint, queryOrgFromChain, resolveAllOrgsOnce } from '../src/hub-resolver.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

describe('hub-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    sidecarState.orgs = {};
    loadMembershipsMock.mockResolvedValue([]);
  });

  it('queryOrgFromChain parses chain snake_case fields', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {
      hub_serving_address: 'http://hub-serving.local',
      hub_endpoints: ['http://hub-primary.local', 'http://hub-backup.local'],
      hub_response_pubkey: 'aabbccdd',
    }));

    const result = await queryOrgFromChain('org-alpha');

    expect(mockFetch).toHaveBeenCalledWith(`${CHAIN_REST_URL}/wevibe/org/v1/org/org-alpha`);
    expect(result).toEqual({
      hubServingAddress: 'http://hub-serving.local',
      hubEndpoints: ['http://hub-primary.local', 'http://hub-backup.local'],
      hubResponsePubkey: 'aabbccdd',
    });
  });

  it('pickActiveEndpoint uses ordered failover and non-2xx fallback', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(503, {}));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    const firstHealthy = await pickActiveEndpoint(['http://hub-one.local', 'http://hub-two.local']);
    expect(firstHealthy).toBe('http://hub-two.local');
    expect(mockFetch.mock.calls[0][0]).toBe('http://hub-one.local/health');
    expect(mockFetch.mock.calls[1][0]).toBe('http://hub-two.local/health');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(jsonResponse(503, {}));
    mockFetch.mockResolvedValueOnce(jsonResponse(500, {}));

    const fallback = await pickActiveEndpoint(['http://hub-one.local', 'http://hub-two.local']);
    expect(fallback).toBe('http://hub-one.local');
  });

  it('resolveAllOrgsOnce writes changed endpoints and no-ops when unchanged', async () => {
    sidecarState.orgs['org-1'] = {
      hubEndpoints: ['http://old-hub.local'],
      activeHubEndpoint: 'http://old-hub.local',
      hubServingAddress: 'http://old-serving.local',
      hubResponsePubkey: 'old-pubkey',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    loadMembershipsMock.mockResolvedValue([{ orgId: 'org-1' }]);

    mockFetch.mockImplementation(async (url: string) => {
      if (url === `${CHAIN_REST_URL}/wevibe/org/v1/org/org-1`) {
        return jsonResponse(200, {
          hub_serving_address: 'http://serving-hub.local',
          hub_endpoints: ['http://new-primary.local', 'http://new-backup.local'],
          hub_response_pubkey: 'new-pubkey',
        });
      }
      if (url === 'http://new-primary.local/health') {
        return jsonResponse(200, {});
      }
      return jsonResponse(404, {});
    });

    const first = await resolveAllOrgsOnce();

    expect(first.changed).toEqual([
      {
        orgId: 'org-1',
        from: ['http://old-hub.local'],
        to: ['http://new-primary.local', 'http://new-backup.local'],
      },
    ]);
    expect(setOrgHubStateMock).toHaveBeenCalledTimes(1);
    expect(sidecarState.orgs['org-1'].activeHubEndpoint).toBe('http://new-primary.local');

    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) => {
      if (url === `${CHAIN_REST_URL}/wevibe/org/v1/org/org-1`) {
        return jsonResponse(200, {
          hub_serving_address: 'http://serving-hub.local',
          hub_endpoints: ['http://new-primary.local', 'http://new-backup.local'],
          hub_response_pubkey: 'new-pubkey',
        });
      }
      if (url === 'http://new-primary.local/health') {
        return jsonResponse(200, {});
      }
      return jsonResponse(404, {});
    });

    const second = await resolveAllOrgsOnce();
    expect(second.changed).toEqual([]);
    expect(setOrgHubStateMock).toHaveBeenCalledTimes(1);
  });
});
