process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { clearTestStore, storeIdentitySeed, generateIdentitySeed } from '../../src/key-store.js';
import { handleRequest } from '../../src/http-server.js';
import { HubSignatureError, hubFetchVerified } from '../../src/hub-fetch.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testPath = join(tmpdir(), `wevibe-mcp-serves-confirm-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

vi.mock('../../src/hub-fetch.js', () => {
  class HubSignatureError extends Error {}
  return {
    HubSignatureError,
    hubFetchVerified: vi.fn(),
  };
});

function createMockRequest(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const req = {
    method,
    url,
    headers: normalizedHeaders,
    on() { return req; },
    removeListener() { return req; },
  } as unknown as IncomingMessage;

  return req;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
  let statusCode = 200;
  let responseBody = '';
  const res = {
    writeHead: (status: number) => {
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

const CONFIRM_RESPONSE = {
  serves: [
    {
      id: 'serve-1',
      memory_content_hash: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
      episode_ref: 'a1b2',
      status: 'submitted',
      tx_hash: '0xabc',
      created_at: '2026-08-08T00:00:00Z',
      submitted_at: '2026-08-08T00:00:01Z',
    },
  ],
};

describe('GET /v1/orgs/{org_id}/serves/confirm', () => {
  let validToken: string;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();

    await storeIdentitySeed(generateIdentitySeed());

    vi.clearAllMocks();
    vi.mocked(hubFetchVerified).mockReset();
  });

  afterEach(() => {
    clearTestStore();
  });

  it('forwards the hub confirm response (episode_ref + memory_hash query, GET, WeVibe-Signed auth) → 200', async () => {
    vi.mocked(hubFetchVerified).mockResolvedValueOnce({
      res: { status: 200 } as Response,
      bodyText: JSON.stringify(CONFIRM_RESPONSE),
      json<T>(): T {
        return JSON.parse(JSON.stringify(CONFIRM_RESPONSE)) as T;
      },
    });

    const req = createMockRequest(
      'GET',
      `/v1/orgs/org-123/serves/confirm?episode_ref=a1b2&memory_hash=${CONFIRM_RESPONSE.serves[0].memory_content_hash}`,
      { 'Authorization': `Bearer ${validToken}`, 'X-WeVibe-Trace-Id': 'trace-1' },
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual(CONFIRM_RESPONSE);

    expect(hubFetchVerified).toHaveBeenCalledTimes(1);
    const [orgId, url, init] = vi.mocked(hubFetchVerified).mock.calls[0];
    expect(orgId).toBe('org-123');
    expect(url).toBe(`http://localhost:4440/v1/orgs/org-123/serves/confirm?episode_ref=a1b2&memory_hash=${CONFIRM_RESPONSE.serves[0].memory_content_hash}`);
    expect(init?.method).toBe('GET');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toMatch(/^WeVibe-Signed /);
    expect(headers?.['X-WeVibe-Trace-Id']).toBe('trace-1');
  });

  it('omits memory_hash from the upstream query when absent → 200', async () => {
    vi.mocked(hubFetchVerified).mockResolvedValueOnce({
      res: { status: 200 } as Response,
      bodyText: JSON.stringify(CONFIRM_RESPONSE),
      json<T>(): T {
        return JSON.parse(JSON.stringify(CONFIRM_RESPONSE)) as T;
      },
    });

    const req = createMockRequest(
      'GET',
      `/v1/orgs/org-123/serves/confirm?episode_ref=a1b2`,
      { 'Authorization': `Bearer ${validToken}` },
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(200);
    const url = vi.mocked(hubFetchVerified).mock.calls[0][1];
    expect(url).toBe('http://localhost:4440/v1/orgs/org-123/serves/confirm?episode_ref=a1b2');
  });

  it('returns 400 when episode_ref is missing', async () => {
    const req = createMockRequest(
      'GET',
      `/v1/orgs/org-123/serves/confirm`,
      { 'Authorization': `Bearer ${validToken}` },
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(400);
    expect(parsed.body).toMatchObject({ status: 'error', error: 'episode_ref is required' });
    expect(hubFetchVerified).not.toHaveBeenCalled();
  });

  it('returns 502 on upstream HubSignatureError', async () => {
    vi.mocked(hubFetchVerified).mockRejectedValueOnce(new HubSignatureError('sig mismatch'));

    const req = createMockRequest(
      'GET',
      `/v1/orgs/org-123/serves/confirm?episode_ref=a1b2`,
      { 'Authorization': `Bearer ${validToken}` },
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(502);
    expect(parsed.body).toEqual({ error: 'upstream signature verification failed' });
  });

  it('returns 502 on upstream non-signature error', async () => {
    vi.mocked(hubFetchVerified).mockRejectedValueOnce(new Error('boom'));

    const req = createMockRequest(
      'GET',
      `/v1/orgs/org-123/serves/confirm?episode_ref=a1b2`,
      { 'Authorization': `Bearer ${validToken}` },
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(502);
    expect(parsed.body).toEqual({ error: 'upstream error' });
  });

  it('returns 502 when hub responds 5xx', async () => {
    vi.mocked(hubFetchVerified).mockResolvedValueOnce({
      res: { status: 503 } as Response,
      bodyText: JSON.stringify({ status: 'error' }),
      json<T>(): T {
        return { status: 'error' } as T;
      },
    });

    const req = createMockRequest(
      'GET',
      `/v1/orgs/org-123/serves/confirm?episode_ref=a1b2`,
      { 'Authorization': `Bearer ${validToken}` },
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(502);
    expect(parsed.body).toEqual({ error: 'upstream error' });
  });

  it('returns 401 without a valid token', async () => {
    const req = createMockRequest(
      'GET',
      `/v1/orgs/org-123/serves/confirm?episode_ref=a1b2`,
      {},
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    expect(res.statusCode).toBe(401);
    expect(hubFetchVerified).not.toHaveBeenCalled();
  });

  it('does not match the confirm route on POST', async () => {
    const req = createMockRequest(
      'POST',
      `/v1/orgs/org-123/serves/confirm?episode_ref=a1b2`,
      { 'Authorization': `Bearer ${validToken}` },
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    expect(res.statusCode).toBe(404);
    expect(hubFetchVerified).not.toHaveBeenCalled();
  });
});