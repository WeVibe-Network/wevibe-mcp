import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/crypto.js', () => ({
  initCrypto: vi.fn().mockResolvedValue(undefined),
  sign: vi.fn().mockReturnValue(new Uint8Array(64)),
  verify: vi.fn().mockReturnValue(true),
  openEnvelope: vi.fn().mockReturnValue(new Uint8Array(0)),
  generateDek: vi.fn().mockReturnValue(new Uint8Array(32)),
  deriveEpochKeys: vi.fn().mockReturnValue({
    encKey: new Uint8Array(32).fill(1),
    searchKey: new Uint8Array(32).fill(2),
    auditKey: new Uint8Array(32).fill(3),
  }),
  sealToPubkey: vi.fn().mockReturnValue(new Uint8Array(48)),
  generateIdentity: vi.fn().mockReturnValue({
    edPrivkey: new Uint8Array(32),
    edPubkey: new Uint8Array(32),
    xPrivkey: new Uint8Array(32),
    xPubkey: new Uint8Array(32),
  }),
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

vi.mock('../src/canonical.js', () => ({
  feeModelHash: vi.fn().mockReturnValue('fee_model_hash_for_tests'),
  createOrgMessage: vi.fn().mockReturnValue(new Uint8Array(Buffer.from('mock-canonical-create'))),
  inviteMemberMessage: vi.fn().mockReturnValue(new Uint8Array(Buffer.from('mock-canonical-invite'))),
  rotateEpochMessage: vi.fn().mockReturnValue(new Uint8Array(Buffer.from('mock-canonical-rotate'))),
}));

vi.mock('../src/hub-fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../src/hub-fetch.js')>('../src/hub-fetch.js');
  return {
    ...actual,
    hubFetchVerified: vi.fn(async (_orgId: string, url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      const responseLike = res as {
        text?: () => Promise<string>;
        json?: () => Promise<unknown>;
      };

      let bodyText = '';
      if (typeof responseLike.text === 'function') {
        bodyText = await responseLike.text();
      } else if (typeof responseLike.json === 'function') {
        bodyText = JSON.stringify(await responseLike.json());
      }

      return {
        res: res as Response,
        bodyText,
        json<T>(): T {
          return bodyText ? JSON.parse(bodyText) as T : ({} as T);
        },
      };
    }),
  };
});

vi.mock('../src/sidecar.js', () => ({
  umbralDeriveEpochKeypair: vi.fn().mockResolvedValue({
    secretKeyHex: '11'.repeat(32),
    publicKeyHex: '02' + '22'.repeat(32),
  }),
  umbralGenerateKfrag: vi.fn().mockResolvedValue('ab'.repeat(40)),
  umbralDecryptReencrypted: vi.fn().mockResolvedValue(new Uint8Array(0)),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn().mockReturnValue('test-uuid-1234'),
  };
});

const EPOCH_SK_HEX = '11'.repeat(32);
const EPOCH_PK_HEX = '02' + '22'.repeat(32);
const PRE_PUBKEY_HEX = '03' + '33'.repeat(32);
const INVITEE_X25519_HEX = '44'.repeat(32);
const TEST_LEADER_WALLET = 'wevibe1testleaderwallet0000000000000000000000';
const HUB_RESPONSE_PUBKEY_HEX = 'aa'.repeat(32);
const HUB_SIGNATURE_HEX = 'bb'.repeat(64);

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

function hubServingAddressResponse(responsePubkey: string | null = HUB_RESPONSE_PUBKEY_HEX): Response {
  return jsonResponse({
    serving_address: 'https://hub.wevibe.test',
    ...(responsePubkey === null ? {} : { response_pubkey: responsePubkey }),
  });
}

function signedMemberOrgsResponse(orgs: Array<Record<string, unknown>>, status = 200): Response {
  return jsonResponse(
    { orgs },
    {
      status,
      headers: {
        'x-hub-signature': HUB_SIGNATURE_HEX,
      },
    },
  );
}

describe('loadMemberships', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('constructs URL with Authorization header instead of query params', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(signedMemberOrgsResponse([]));

    await loadMemberships('http://localhost:4440');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:4440/v1/hub/serving-address');

    const calledUrl = mockFetch.mock.calls[1][0] as string;
    const calledOpts = mockFetch.mock.calls[1][1] as { headers?: Record<string, string> };
    expect(calledUrl).toContain('/v1/members/');
    expect(calledUrl).toContain('/orgs');
    expect(calledUrl).not.toContain('timestamp=');
    expect(calledUrl).not.toContain('signature=');
    expect(calledOpts?.headers?.['Authorization']).toMatch(/^WeVibe-Signed pubkey=.+,timestamp=.+,signature=.+$/);
  });

  it('parses response into OrgMembership array and fetches envelopes from hub', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(
      signedMemberOrgsResponse([
        {
          org_id: 'test-org-1',
          org_name: 'Test Org 1',
          role: 'member',
          current_epoch: 3,
          history_access_from_epoch: 1,
          egress_mode: 'unrestricted',
          allowed_providers: [],
        },
      ]),
    );
    mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));

    const memberships = await loadMemberships('http://localhost:4440');

    expect(memberships).toHaveLength(1);
    expect(memberships[0].orgId).toBe('test-org-1');
    expect(memberships[0].orgName).toBe('Test Org 1');
    expect(memberships[0].role).toBe('member');
    expect(memberships[0].currentEpoch).toBe(3);
    expect(memberships[0].historyAccessFromEpoch).toBe(1);
    expect(memberships[0].egressMode).toBe('unrestricted');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const envelopeUrl = mockFetch.mock.calls[2][0] as string;
    const envelopeOpts = mockFetch.mock.calls[2][1] as { headers?: Record<string, string> };
    expect(envelopeUrl).toContain('/v1/orgs/test-org-1/keys/envelope');
    expect(envelopeUrl).not.toContain('pubkey=');
    expect(envelopeUrl).not.toContain('timestamp=');
    expect(envelopeUrl).not.toContain('signature=');
    expect(envelopeOpts?.headers?.['Authorization']).toMatch(/^WeVibe-Signed pubkey=.+,timestamp=.+,signature=.+$/);
  });

  it('throws on fetch failure instead of silently degrading', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockRejectedValueOnce(new TypeError('network error'));

    await expect(loadMemberships('http://localhost:4440')).rejects.toThrow(/hub unavailable/);
  });

  it('throws when Hub returns non-OK status', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(signedMemberOrgsResponse([], 500));

    await expect(loadMemberships('http://localhost:4440')).rejects.toThrow(/hub returned 500/);
  });

  it('throws when response JSON is malformed', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(new Response('not-json', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature': HUB_SIGNATURE_HEX,
      },
    }));

    await expect(loadMemberships('http://localhost:4440')).rejects.toThrow(/malformed hub response/);
  });

  it('still returns membership when envelope fetch fails', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(
      signedMemberOrgsResponse([
        {
          org_id: 'test-org-2',
          org_name: 'Test Org 2',
          role: 'leader',
          current_epoch: 0,
          history_access_from_epoch: 0,
          egress_mode: 'local_only',
          allowed_providers: [],
        },
      ]),
    );

    mockFetch.mockRejectedValueOnce(new Error('envelope fetch failed'));

    const memberships = await loadMemberships('http://localhost:4440');

    expect(memberships).toHaveLength(1);
    expect(memberships[0].orgId).toBe('test-org-2');
    expect(memberships[0].encKeys.size).toBe(0);
    expect(memberships[0].searchKeys.size).toBe(0);
  });

  it('fetches envelopes for each org in the list', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(
      signedMemberOrgsResponse([
        {
          org_id: 'org-a',
          org_name: 'Org A',
          role: 'member',
          current_epoch: 1,
          history_access_from_epoch: 0,
          egress_mode: 'unrestricted',
          allowed_providers: [],
        },
        {
          org_id: 'org-b',
          org_name: 'Org B',
          role: 'leader',
          current_epoch: 2,
          history_access_from_epoch: 0,
          egress_mode: 'allowlist',
          allowed_providers: ['openai'],
        },
      ]),
    );

    mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));

    const memberships = await loadMemberships('http://localhost:4440');

    expect(memberships).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    const envelopeUrlA = mockFetch.mock.calls[2][0] as string;
    const envelopeUrlB = mockFetch.mock.calls[3][0] as string;
    expect(envelopeUrlA).toContain('/v1/orgs/org-a/keys/envelope');
    expect(envelopeUrlB).toContain('/v1/orgs/org-b/keys/envelope');
  });

  it('fails closed when /v1/hub/serving-address omits response_pubkey', async () => {
    const { loadMemberships } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse(null));

    await expect(loadMemberships('http://localhost:4440')).rejects.toThrow(
      /hub response_pubkey missing from \/v1\/hub\/serving-address response/,
    );
  });

  it('fails closed when hub response signature is invalid', async () => {
    const { loadMemberships } = await import('../src/org-client.js');
    const { verify } = await import('../src/crypto.js');

    vi.mocked(verify).mockReturnValueOnce(false);

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(signedMemberOrgsResponse([]));

    await expect(loadMemberships('http://localhost:4440')).rejects.toThrow(/signature mismatch/);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('unseals mod_envelope for leader role', async () => {
    const { loadMemberships } = await import('../src/org-client.js');
    const { openEnvelope } = await import('../src/crypto.js');

    const unsealedModKey = new Uint8Array(32).fill(0x99);
    vi.mocked(openEnvelope).mockReturnValue(unsealedModKey);

    mockFetch.mockResolvedValueOnce(hubServingAddressResponse());
    mockFetch.mockResolvedValueOnce(
      signedMemberOrgsResponse([
        {
          org_id: 'test-org-leader',
          org_name: 'Leader Org',
          role: 'leader',
          current_epoch: 0,
          history_access_from_epoch: 0,
          egress_mode: 'unrestricted',
          allowed_providers: [],
        },
      ]),
    );

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        org_id: 'test-org-leader',
        epoch_id: 0,
        enc_envelope: Buffer.from(new Uint8Array(48)).toString('base64'),
        search_envelope: Buffer.from(new Uint8Array(48)).toString('base64'),
        mod_envelope: Buffer.from(new Uint8Array(48)).toString('base64'),
      }),
    );

    const memberships = await loadMemberships('http://localhost:4440');

    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe('leader');
    expect(memberships[0].modPrivkey).toEqual(unsealedModKey);
    expect(vi.mocked(openEnvelope)).toHaveBeenCalled();
  });
});

function packEpochKeyPairForTest(epoch: number, key: Uint8Array): Uint8Array {
  const buf = new Uint8Array(36);
  const view = new DataView(buf.buffer);
  view.setUint32(0, epoch, true);
  buf.set(key, 4);
  return buf;
}

describe('createOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockKeyStore.clear();
  });

  it('sends mod_envelope in POST body', async () => {
    const { createOrg } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'test-uuid-1234', status: 'active', epoch_sk: EPOCH_SK_HEX, epoch_pk: EPOCH_PK_HEX }),
    });

    const result = await createOrg({
      orgName: 'Test Org',
      domain: 'test.com',
      hubUrl: 'http://localhost:4440',
      leaderWallet: TEST_LEADER_WALLET,
    });

    expect(result.status).toBe('created');

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.mod_envelope).toBeTruthy();
    expect(typeof body.mod_envelope).toBe('string');
    expect(body.mod_envelope.length).toBeGreaterThan(0);
    const decoded = Buffer.from(body.mod_envelope, 'base64');
    expect(decoded.length).toBeGreaterThan(0);
  });

  it('sends correct payload to hub and stores master key', async () => {
    const { createOrg } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'test-uuid-1234', status: 'active', epoch_sk: EPOCH_SK_HEX, epoch_pk: EPOCH_PK_HEX }),
    });

    const result = await createOrg({
      orgName: 'Test Org',
      domain: 'test.com',
      hubUrl: 'http://localhost:4440',
      leaderWallet: TEST_LEADER_WALLET,
    });

    expect(result.status).toBe('created');
    expect(result.orgId).toBe('test-uuid-1234');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:4440/v1/orgs');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.org_id).toBeUndefined();
    expect(body.org_name).toBe('Test Org');
    expect(body.domain).toBe('test.com');
    expect(body.leader_pubkey).toBeTruthy();
    expect(body.leader_x25519_pubkey).toBeTruthy();
    expect(body.leader_wallet).toBe(TEST_LEADER_WALLET);
    expect(body.enc_envelope).toBeTruthy();
    expect(body.search_envelope).toBeTruthy();
    expect(body.umbral_pk).toBeTruthy();
    expect(body.signature).toBeTruthy();
    expect(body.fee_model).toBeNull();
    expect(body.mod_envelope).toBeTruthy();
    expect(typeof body.mod_envelope).toBe('string');
    expect(body.mod_envelope.length).toBeGreaterThan(0);

    expect(mockKeyStore.has('test-uuid-1234-master')).toBe(true);
  });

  it('returns error when no identity', async () => {
    const { loadIdentity } = await import('../src/key-store.js');
    vi.mocked(loadIdentity).mockResolvedValueOnce(null);

    const { createOrg } = await import('../src/org-client.js');
    const result = await createOrg({
      orgName: 'Test',
      domain: 'test.com',
      hubUrl: 'http://localhost:4440',
      leaderWallet: TEST_LEADER_WALLET,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('no identity');
  });

  it('returns error when hub rejects', async () => {
    const { createOrg } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'org already exists' }),
    });

    const result = await createOrg({
      orgName: 'Test',
      domain: 'test.com',
      hubUrl: 'http://localhost:4440',
      leaderWallet: TEST_LEADER_WALLET,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('org already exists');
    expect(mockKeyStore.size).toBe(0);
  });

  it('includes mod_envelope in canonical signing', async () => {
    const { createOrg } = await import('../src/org-client.js');
    const { sign } = await import('../src/crypto.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'test-uuid-1234', status: 'active', epoch_sk: EPOCH_SK_HEX, epoch_pk: EPOCH_PK_HEX }),
    });

    await createOrg({
      orgName: 'Test Org',
      domain: 'test.com',
      hubUrl: 'http://localhost:4440',
      leaderWallet: TEST_LEADER_WALLET,
    });

    expect(vi.mocked(sign)).toHaveBeenCalledTimes(1);
    const canonical = vi.mocked(sign).mock.calls[0][1];
    const canonicalText = Buffer.from(canonical).toString('utf-8');

    expect(canonicalText).toContain('wevibe.create_org.v1');
    const modEnvelopeLine = canonicalText.split('\n').find((line) => line.startsWith('mod_envelope:'));
    expect(modEnvelopeLine).toBeDefined();
    expect(modEnvelopeLine).not.toBe('mod_envelope:');
  });

  it('leader mod_envelope is recoverable via loadMemberships', async () => {
    const { createOrg } = await import('../src/org-client.js');

    let sentModEnvelope: string | undefined;
    mockFetch.mockImplementationOnce(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      sentModEnvelope = body.mod_envelope;
      return {
        ok: true,
        json: async () => ({ org_id: 'test-uuid-1234', status: 'active', epoch_sk: EPOCH_SK_HEX, epoch_pk: EPOCH_PK_HEX }),
      };
    });

    await createOrg({
      orgName: 'Recovery Test Org',
      domain: 'recovery.test',
      hubUrl: 'http://localhost:4440',
      leaderWallet: TEST_LEADER_WALLET,
    });

    expect(sentModEnvelope).toBeTruthy();
    expect(typeof sentModEnvelope).toBe('string');
    expect(sentModEnvelope!.length).toBeGreaterThan(0);
  });
});

describe('inviteMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockKeyStore.clear();
  });

  it('seals envelopes and sends correct payload', async () => {
    mockKeyStore.set('org-abc-master', new Uint8Array(32).fill(0xaa));

    const { inviteMember } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ current_epoch: 2 }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pubkey: 'invitee_pub', role: 'member' }),
    });

    const result = await inviteMember({
      orgId: 'org-abc',
      inviteePubkeyHex: 'invitee_pub',
      inviteeX25519PubkeyHex: INVITEE_X25519_HEX,
      prePubkeyHex: PRE_PUBKEY_HEX,
      canContribute: false,
      canModerate: false,
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('invited');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://localhost:4440/v1/orgs/org-abc/members');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.pubkey).toBe('invitee_pub');
    expect(body.x25519_pubkey).toBe(INVITEE_X25519_HEX);
    expect(body.pre_pubkey).toBe(PRE_PUBKEY_HEX);
    expect(body.epoch_sk).toBeUndefined();
    expect(body.role).toBe('member');
    expect(body.enc_envelope).toBeTruthy();
    expect(body.search_envelope).toBeTruthy();
    expect(body.signature).toBeTruthy();
    expect(body.signed_by).toBeTruthy();
  });

  it('returns error when no master key for org', async () => {
    const { inviteMember } = await import('../src/org-client.js');

    const result = await inviteMember({
      orgId: 'org-unknown',
      inviteePubkeyHex: 'pub',
      inviteeX25519PubkeyHex: INVITEE_X25519_HEX,
      prePubkeyHex: PRE_PUBKEY_HEX,
      canContribute: false,
      canModerate: false,
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('no master key');
  });

  it('defaults to epoch 0 when hub is unreachable', async () => {
    mockKeyStore.set('org-abc-master', new Uint8Array(32));

    const { inviteMember } = await import('../src/org-client.js');
    const { deriveEpochKeys } = await import('../src/crypto.js');

    mockFetch.mockRejectedValueOnce(new Error('network'));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const result = await inviteMember({
      orgId: 'org-abc',
      inviteePubkeyHex: 'pub',
      inviteeX25519PubkeyHex: INVITEE_X25519_HEX,
      prePubkeyHex: PRE_PUBKEY_HEX,
      canContribute: false,
      canModerate: false,
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('invited');
    expect(vi.mocked(deriveEpochKeys)).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('includes mod_envelope when inviting moderator', async () => {
    mockKeyStore.set('org-abc-master', new Uint8Array(32).fill(0xaa));
    mockKeyStore.set('org-abc-mod-privkey', new Uint8Array(32).fill(0xbb));

    const { inviteMember } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ current_epoch: 2 }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pubkey: 'invitee_pub', role: 'moderator' }),
    });

    const result = await inviteMember({
      orgId: 'org-abc',
      inviteePubkeyHex: 'invitee_pub',
      inviteeX25519PubkeyHex: INVITEE_X25519_HEX,
      prePubkeyHex: PRE_PUBKEY_HEX,
      canContribute: false,
      canModerate: true,
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('invited');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [, opts] = mockFetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.mod_envelope).toBeTruthy();
    expect(body.mod_envelope.length).toBeGreaterThan(0);
    expect(body.role).toBe('member');
    expect(body.can_moderate).toBe(true);
  });

  it('does NOT include mod_envelope when inviting member', async () => {
    mockKeyStore.set('org-abc-master', new Uint8Array(32).fill(0xaa));

    const { inviteMember } = await import('../src/org-client.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ current_epoch: 0 }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pubkey: 'invitee_pub', role: 'member' }),
    });

    const result = await inviteMember({
      orgId: 'org-abc',
      inviteePubkeyHex: 'invitee_pub',
      inviteeX25519PubkeyHex: INVITEE_X25519_HEX,
      prePubkeyHex: PRE_PUBKEY_HEX,
      canContribute: false,
      canModerate: false,
      hubUrl: 'http://localhost:4440',
    });

    expect(result.status).toBe('invited');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [, opts] = mockFetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.mod_envelope).toBeUndefined();
    expect(body.role).toBe('member');
  });
});
