process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { clearTestStore, storeIdentitySeed, generateIdentitySeed } from '../../src/key-store.js';
import { handleRequest } from '../../src/http-server.js';
import { buildCanonicalServeBodyBytes, deriveOrgServeKey } from '../../src/serve-signing.js';
import { buildCanonicalOutcomeEventBodyBytes } from '../../src/event-signing.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { verifyAsync } from '@noble/ed25519';

const testPath = join(tmpdir(), `wevibe-mcp-serves-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);
const MEMORY_HASH_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const EPISODE_REF_HEX = 'a1b2';
const EVIDENCE_REF_HEX = 'c3';
const CURRENT_EPOCH = 7;

vi.stubGlobal('fetch', vi.fn());

vi.mock('../../src/hub-fetch.js', () => {
  class HubSignatureError extends Error {}
  return {
    HubSignatureError,
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

function createMockRequest(method: string, url: string, headers: Record<string, string> = {}, body?: string): IncomingMessage {
  const listeners: Record<string, Array<(arg?: string) => void>> = {};
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const req = {
    method,
    url,
    headers: normalizedHeaders,
    on(event: string, callback: (arg?: string) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      return req;
    },
    removeListener() { return req; },
  } as unknown as IncomingMessage;

  if (body) {
    setImmediate(() => {
      for (let i = 0; i < body.length; i += 1024) {
        const chunk = body.slice(i, i + 1024);
        listeners['data']?.forEach(cb => cb(chunk));
      }
      listeners['end']?.forEach(cb => cb());
    });
  } else {
    setImmediate(() => {
      listeners['end']?.forEach(cb => cb());
    });
  }

  return req;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
  let statusCode = 200;
  let responseBody = '';
  const res = {
    writeHead: (status: number, _headers?: Record<string, unknown>) => {
      statusCode = status;
    },
    end: (body?: string) => {
      if (body) responseBody = body;
    },
    get statusCode() { return statusCode; },
    get body() { return responseBody; },
  } as unknown as ServerResponse & { statusCode: number; body: string };
  return res;
}

function parseResponse(res: ServerResponse & { body: string }): { status: number; body: unknown } {
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function mockCurrentEpochFetch(epochId = CURRENT_EPOCH): void {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ org_id: 'org-123', epoch_id: epochId, umbral_pk: 'abcd' }),
  } as Response);
}

describe('POST /v1/serves', () => {
  let validToken: string;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();

    await storeIdentitySeed(generateIdentitySeed());

    vi.clearAllMocks();
    vi.mocked(fetch).mockReset();
  });

  afterEach(() => {
    clearTestStore();
  });

  it('POST /v1/serves with valid token + valid body → hub returns 200 → 200', async () => {
    const mockHubResponse = {
      status: 'recorded',
      serve_fingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    mockCurrentEpochFetch();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(mockHubResponse),
    } as Response);

    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      model_id: 'test-model',
      turn_count: 5,
      matched_keywords: ['some-kw'],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual(mockHubResponse);
    expect(fetch).toHaveBeenCalled();

    const epochFetchCall = vi.mocked(fetch).mock.calls[0];
    expect(epochFetchCall?.[0]).toContain('/v1/orgs/org-123/epoch/current/manifest');

    const fetchCall = vi.mocked(fetch).mock.calls[1];
    expect(fetchCall).toBeTruthy();
    const init = fetchCall![1] as RequestInit;
    const postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(postedBody).toMatchObject({
      org_id: 'org-123',
      epoch_id: CURRENT_EPOCH,
      memory_content_hash: MEMORY_HASH_HEX,
      model_id: 'test-model',
      turn_count: 5,
      matched_keywords: ['some-kw'],
    });
    expect(postedBody).toHaveProperty('serve_key_pubkey');
    expect(postedBody).toHaveProperty('serve_sig');
    expect(postedBody).toHaveProperty('nonce');
    expect(postedBody).toHaveProperty('contributor_id');
    expect(postedBody).not.toHaveProperty('serve_key');
    expect(postedBody).not.toHaveProperty('nullifier');
    expect(postedBody.serve_key_pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(postedBody.serve_sig).toMatch(/^[0-9a-f]{128}$/);
    expect(postedBody.nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  it('POST /v1/serves with no Authorization header → 401', async () => {
    const req = createMockRequest('POST', '/v1/serves', {
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      matched_keywords: ['some-kw'],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(401);
    expect(parsed.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('POST /v1/serves with wrong token → 401', async () => {
    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${'a'.repeat(64)}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      matched_keywords: ['some-kw'],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(401);
    expect(parsed.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('POST /v1/serves with invalid body (missing org_id) → 400', async () => {
    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      memory_hash: MEMORY_HASH_HEX,
      matched_keywords: ['some-kw'],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(400);
    expect((parsed.body as { error: string }).error).toContain('org_id');
  });

  it('POST /v1/serves when hub returns 5xx → 502', async () => {
    mockCurrentEpochFetch();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response);

    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      matched_keywords: ['some-kw'],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(502);
  });

  it('accepts absent matched_keywords and signs serve v2 without keyword metadata', async () => {
    mockCurrentEpochFetch();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'recorded' }),
    } as Response);

    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(200);

    const init = vi.mocked(fetch).mock.calls[1]![1] as RequestInit;
    const postedBody = JSON.parse(String(init.body)) as Record<string, string | number | string[]>;
    expect(postedBody.matched_keywords).toEqual([]);

    const canonicalBody = buildCanonicalServeBodyBytes({
      orgId: 'org-123',
      memoryContentHashHex: MEMORY_HASH_HEX,
      epoch: CURRENT_EPOCH,
      serveKeyPubkeyHex: String(postedBody.serve_key_pubkey),
      nonceHex: String(postedBody.nonce),
    });
    expect(await verifyAsync(
      Buffer.from(String(postedBody.serve_sig), 'hex'),
      canonicalBody,
      Buffer.from(String(postedBody.serve_key_pubkey), 'hex'),
    )).toBe(true);
  });

  it('POST /v1/serves fails loudly when current epoch manifest fetch fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'manifest unavailable',
    } as Response);

    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(502);
    expect(parsed.body).toMatchObject({ status: 'error', error: 'failed to resolve current epoch' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('/v1/orgs/org-123/epoch/current/manifest');
  });
});

describe('POST /v1/orgs/{org_id}/outcome-events', () => {
  let validToken: string;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();

    await storeIdentitySeed(generateIdentitySeed());

    vi.clearAllMocks();
    vi.mocked(fetch).mockReset();
  });

  afterEach(() => {
    clearTestStore();
  });

  it('emits a signed content-free outcome event to the hub', async () => {
    mockCurrentEpochFetch();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'recorded' }),
    } as Response);
    mockCurrentEpochFetch();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'recorded' }),
    } as Response);

    const req = createMockRequest('POST', '/v1/orgs/org-123/outcome-events', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
      'X-WeVibe-Trace-Id': 'trace-outcome-1',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      episode_ref: EPISODE_REF_HEX,
      worked: true,
      evidence_ref: EVIDENCE_REF_HEX,
      session_id: 'session-1',
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toMatchObject({ status: 'ok', fingerprint_first8: expect.stringMatching(/^[0-9a-f]{8}$/) });

    const epochFetchCall = vi.mocked(fetch).mock.calls[0];
    expect(epochFetchCall?.[0]).toContain('/v1/orgs/org-123/epoch/current/manifest');

    const fetchCall = vi.mocked(fetch).mock.calls[1];
    expect(fetchCall?.[0]).toContain('/v1/orgs/org-123/events');
    const init = fetchCall![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-WeVibe-Trace-Id']).toBe('trace-outcome-1');
    const postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(postedBody).toMatchObject({
      org_id: 'org-123',
      epoch: CURRENT_EPOCH,
      event_type: 'outcome',
      memory_hash: MEMORY_HASH_HEX,
      episode_ref: EPISODE_REF_HEX,
      worked: true,
      evidence_ref: EVIDENCE_REF_HEX,
      session_id: 'session-1',
    });
    expect(postedBody.signer_pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(postedBody.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(postedBody.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(postedBody.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const canonicalBody = buildCanonicalOutcomeEventBodyBytes({
      orgId: 'org-123',
      memoryHash: MEMORY_HASH_HEX,
      epoch: CURRENT_EPOCH,
      signerPubkey: String(postedBody.signer_pubkey),
      nonce: String(postedBody.nonce),
      episodeRef: EPISODE_REF_HEX,
      worked: true,
      evidenceRef: EVIDENCE_REF_HEX,
    });
    expect(await verifyAsync(
      Buffer.from(String(postedBody.signature), 'hex'),
      canonicalBody,
      Buffer.from(String(postedBody.signer_pubkey), 'hex'),
    )).toBe(true);

    const expectedKey = await deriveOrgServeKey('org-123');
    expect(postedBody.signer_pubkey).toBe(expectedKey.pubHex);
    expect(String(postedBody.fingerprint).slice(0, 8)).toBe((parsed.body as { fingerprint_first8: string }).fingerprint_first8);

    const retryReq = createMockRequest('POST', '/v1/orgs/org-123/outcome-events', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
      'X-WeVibe-Trace-Id': 'trace-outcome-2',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      episode_ref: EPISODE_REF_HEX,
      worked: true,
      evidence_ref: EVIDENCE_REF_HEX,
      session_id: 'session-1',
    }));

    const retryRes = createMockResponse();
    await handleRequest(retryReq, retryRes);

    const retryParsed = parseResponse(retryRes);
    expect(retryParsed.status).toBe(200);
    expect((retryParsed.body as { fingerprint_first8: string }).fingerprint_first8)
      .toBe((parsed.body as { fingerprint_first8: string }).fingerprint_first8);

    const retryInit = vi.mocked(fetch).mock.calls[3]![1] as RequestInit;
    const retryPostedBody = JSON.parse(String(retryInit.body)) as Record<string, unknown>;
    expect(retryPostedBody.nonce).toBe(postedBody.nonce);
    expect(retryPostedBody.fingerprint).toBe(postedBody.fingerprint);
  });

  it.each([
    ['bad memory_hash', { memory_hash: 'zz' }, 'memory_hash'],
    ['oversize episode_ref', { episode_ref: 'aa'.repeat(65) }, 'episode_ref'],
    ['missing worked', { worked: undefined }, 'worked'],
    ['plaintext forbidden', { plaintext: 'nope' }, 'plaintext'],
  ])('rejects invalid outcome body: %s', async (_name, override, expectedError) => {
    const body: Record<string, unknown> = {
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      episode_ref: EPISODE_REF_HEX,
      worked: true,
      evidence_ref: EVIDENCE_REF_HEX,
      ...override,
    };
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) delete body[key];
    }

    const req = createMockRequest('POST', '/v1/orgs/org-123/outcome-events', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify(body));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(400);
    expect((parsed.body as { error: string }).error).toContain(expectedError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
