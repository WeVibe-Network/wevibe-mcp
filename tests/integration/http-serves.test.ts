process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { clearTestStore, storeIdentitySeed, generateIdentitySeed } from '../../src/key-store.js';
import { handleRequest } from '../../src/http-server.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testPath = join(tmpdir(), `wevibe-mcp-serves-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

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
    const mockHubResponse = { status: 'recorded', nullifier: 'test-nullifier-123' };
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
      memory_hash: 'Qmhash123456',
      nullifier: 'nullifier-abc',
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
  });

  it('POST /v1/serves with no Authorization header → 401', async () => {
    const req = createMockRequest('POST', '/v1/serves', {
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: 'Qmhash123456',
      nullifier: 'nullifier-abc',
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
      memory_hash: 'Qmhash123456',
      nullifier: 'nullifier-abc',
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
      memory_hash: 'Qmhash123456',
      nullifier: 'nullifier-abc',
      matched_keywords: ['some-kw'],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(400);
    expect((parsed.body as { error: string }).error).toContain('org_id');
  });

  it('POST /v1/serves when hub returns 5xx → 502', async () => {
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
      memory_hash: 'Qmhash123456',
      nullifier: 'nullifier-abc',
      matched_keywords: ['some-kw'],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(502);
  });

  it('rejects empty matched_keywords with 400', async () => {
    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({
      org_id: 'org-123',
      memory_hash: 'Qmhash123456',
      nullifier: 'nullifier-abc',
      matched_keywords: [],
    }));

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(400);
    expect((parsed.body as { error: string }).error).toContain('matched_keywords');
  });
});
