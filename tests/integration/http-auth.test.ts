import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { clearTestStore } from '../../src/key-store.js';
import { handleRequest } from '../../src/http-server.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testPath = join(tmpdir(), `wevibe-mcp-auth-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

vi.stubGlobal('fetch', vi.fn());

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

describe('HTTP auth on all endpoints', () => {
  let validToken: string;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();
  });

  afterEach(() => {
    clearTestStore();
  });

  it('GET /v1/health with no token → 401', async () => {
    const req = createMockRequest('GET', '/v1/health', {});
    const res = createMockResponse();
    await handleRequest(req, res);
    const parsed = parseResponse(res);
    expect(parsed.status).toBe(401);
    expect(parsed.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('GET /v1/health with valid token → 200', async () => {
    const req = createMockRequest('GET', '/v1/health', {
      'Authorization': `Bearer ${validToken}`,
    });
    const res = createMockResponse();
    await handleRequest(req, res);
    const parsed = parseResponse(res);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual({
      status: 'ok',
      version: '0.2.0',
      build_stamp: expect.any(Number),
    });
  });

  it('POST /v1/recall with no token → 401', async () => {
    const req = createMockRequest('POST', '/v1/recall', {
      'Content-Type': 'application/json',
    }, JSON.stringify({ query: 'test query' }));
    const res = createMockResponse();
    await handleRequest(req, res);
    const parsed = parseResponse(res);
    expect(parsed.status).toBe(401);
    expect(parsed.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('POST /v1/recall with wrong token → 401', async () => {
    const fakeToken = 'a'.repeat(64);
    const req = createMockRequest('POST', '/v1/recall', {
      'Authorization': `Bearer ${fakeToken}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ query: 'test query' }));
    const res = createMockResponse();
    await handleRequest(req, res);
    const parsed = parseResponse(res);
    expect(parsed.status).toBe(401);
    expect(parsed.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('All four endpoints reject the same wrong token uniformly', async () => {
    const fakeToken = 'a'.repeat(64);

    const checkEndpoint = async (method: string, url: string, body?: string) => {
      const reqBody = body ?? (url === '/v1/recall'
        ? JSON.stringify({ query: 'test' })
        : url === '/v1/serves'
          ? JSON.stringify({ org_id: 'org-123', memory_hash: 'QmHash', nullifier: 'null' })
          : JSON.stringify({ org_id: 'org-123', memory_hash: 'QmHash', reason: 'incorrect' }));

      const req = createMockRequest(method, url, {
        'Authorization': `Bearer ${fakeToken}`,
        'Content-Type': 'application/json',
      }, reqBody);
      const res = createMockResponse();
      await handleRequest(req, res);
      return parseResponse(res);
    };

    const endpoints = [
      ['GET', '/v1/health'],
      ['POST', '/v1/recall'],
      ['POST', '/v1/serves'],
      ['POST', '/v1/reports'],
    ];

    for (const [method, url] of endpoints) {
      const parsed = await checkEndpoint(method, url);
      expect(parsed.status).toBe(401, `Expected 401 for ${method} ${url}, got ${parsed.status}`);
      expect(parsed.body).toEqual({ status: 'error', error: 'unauthorized' });
    }
  });
});
