process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { clearTestStore } from '../../src/key-store.js';
import { handleRequest } from '../../src/http-server.js';

const testPath = join(tmpdir(), `wevibe-mcp-body-guard-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

function createMockRequest(method: string, url: string, headers: Record<string, string> = {}, body?: string): IncomingMessage {
  const listeners: Record<string, Array<(arg?: Buffer | string) => void>> = {};
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const req = {
    method,
    url,
    headers: normalizedHeaders,
    on(event: string, callback: (arg?: Buffer | string) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      return req;
    },
    removeListener() { return req; },
    destroy() {
      return req;
    },
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

function createMockRequestNoEnd(method: string, url: string, headers: Record<string, string> = {}, firstChunk?: string): IncomingMessage {
  const listeners: Record<string, Array<(arg?: Buffer | string) => void>> = {};
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const req = {
    method,
    url,
    headers: normalizedHeaders,
    on(event: string, callback: (arg?: Buffer | string) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      return req;
    },
    removeListener() { return req; },
    destroy() {
      return req;
    },
  } as unknown as IncomingMessage;

  setImmediate(() => {
    if (firstChunk) {
      listeners['data']?.forEach(cb => cb(firstChunk));
    }
  });

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

function parseResponse(res: ServerResponse & { body: string }): { status: number; body: Record<string, unknown> } {
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe('HTTP body guard', () => {
  let validToken: string;
  let originalBodyMaxBytes: string | undefined;
  let originalBodyTimeoutMs: string | undefined;

  beforeEach(async () => {
    originalBodyMaxBytes = process.env.WEVIBE_BODY_MAX_BYTES;
    originalBodyTimeoutMs = process.env.WEVIBE_BODY_TIMEOUT_MS;

    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
  });

  afterEach(() => {
    if (originalBodyMaxBytes === undefined) {
      delete process.env.WEVIBE_BODY_MAX_BYTES;
    } else {
      process.env.WEVIBE_BODY_MAX_BYTES = originalBodyMaxBytes;
    }

    if (originalBodyTimeoutMs === undefined) {
      delete process.env.WEVIBE_BODY_TIMEOUT_MS;
    } else {
      process.env.WEVIBE_BODY_TIMEOUT_MS = originalBodyTimeoutMs;
    }

    clearTestStore();
  });

  it('returns 413 when request body exceeds configured max bytes', async () => {
    process.env.WEVIBE_BODY_MAX_BYTES = '2048';

    const largeBody = JSON.stringify({
      org_id: 'org-123',
      memory_hash: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
      matched_keywords: ['k'],
      note: 'x'.repeat(4096),
    });

    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, largeBody);

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(413);
    expect(parsed.body.code).toBe('body_too_large');
  });

  it('returns 408 when request body exceeds total timeout', async () => {
    process.env.WEVIBE_BODY_TIMEOUT_MS = '50';

    const req = createMockRequestNoEnd('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, '{');

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).toBe(408);
    expect(parsed.body.code).toBe('body_timeout');
  });

  it('does not trigger body guard for normal small-body flow', async () => {
    const req = createMockRequest('POST', '/v1/serves', {
      'Authorization': `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    }, '{"org_id":"org-123"');

    const res = createMockResponse();
    await handleRequest(req, res);

    const parsed = parseResponse(res);
    expect(parsed.status).not.toBe(413);
    expect(parsed.status).not.toBe(408);
    expect(parsed.status).toBe(400);
    expect(parsed.body.error).toBe('invalid JSON');
  });
});
