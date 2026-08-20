process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { clearTestStore, storeIdentitySeed, generateIdentitySeed } from '../../src/key-store.js';
import { handleRequest } from '../../src/http-server.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testPath = join(tmpdir(), `wevibe-mcp-denials-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);
const MEMORY_HASH_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const EPISODE_REF_HEX = 'a1b2';

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

async function postDenial(validToken: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = createMockRequest('POST', '/v1/denials', {
    'Authorization': `Bearer ${validToken}`,
    'Content-Type': 'application/json',
  }, JSON.stringify(body));

  const res = createMockResponse();
  await handleRequest(req, res);
  const parsed = parseResponse(res);
  return { status: parsed.status, body: parsed.body as Record<string, unknown> };
}

describe('POST /v1/denials episode_ref validation (fail-closed, mirrors serve path)', () => {
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

  it('missing episode_ref → 400 before any hub call', async () => {
    const result = await postDenial(validToken, {
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      reason: 'test-denial',
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ status: 'error', error: 'episode_ref must be a string' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('non-hex episode_ref → 400 before any hub call', async () => {
    const result = await postDenial(validToken, {
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      episode_ref: 'zzzz',
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ status: 'error', error: 'episode_ref must be lowercase hex' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('0x-prefixed episode_ref → 400 before any hub call', async () => {
    const result = await postDenial(validToken, {
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      episode_ref: `0x${EPISODE_REF_HEX}`,
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ status: 'error', error: 'episode_ref must not include 0x prefix' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('episode_ref longer than 64 bytes → 400 before any hub call', async () => {
    const result = await postDenial(validToken, {
      org_id: 'org-123',
      memory_hash: MEMORY_HASH_HEX,
      episode_ref: 'ab'.repeat(65),
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ status: 'error', error: 'episode_ref must be a 1-64 byte hex string' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
