process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { initCrypto, generateIdentity } from '../../src/crypto.js';
import { clearTestStore, storeIdentitySeed, generateIdentitySeed } from '../../src/key-store.js';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testPath = join(tmpdir(), `wevibe-mcp-reports-test-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

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

vi.mock('../../src/key-store.js', async () => {
  const actual = await vi.importActual('../../src/key-store.js');
  return {
    ...actual,
    loadIdentity: vi.fn(),
  };
});

vi.mock('../../src/auth.js', async () => {
  const actual = await vi.importActual('../../src/auth.js');
  return {
    ...actual,
    buildWeVibeSignedAuth: vi.fn(),
  };
});

function createMockRequest(body: string): IncomingMessage {
  let closed = false;

  const req = {
    method: 'POST',
    url: '/v1/reports',
    headers: { 'authorization': 'Bearer valid-token' },
  } as unknown as IncomingMessage & {
    on: (event: string, callback: (chunk?: string) => void) => typeof req;
    removeAllListeners: () => void;
  };

  req.on = (event: string, callback: (chunk?: string) => void) => {
    if (event === 'data') {
      if (!closed && body.length > 0) {
        setImmediate(() => callback(body));
      }
    } else if (event === 'end') {
      if (!closed) {
        closed = true;
        setImmediate(() => callback());
      }
    } else if (event === 'error') {
      // noop
    }
    return req;
  };

  req.removeAllListeners = () => {};

  return req as IncomingMessage;
}

describe('POST /v1/reports', () => {
  let validToken: string;
  let mockLoadIdentity: ReturnType<typeof vi.fn>;
  let mockBuildWeVibeSignedAuth: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;

    vi.clearAllMocks();
    fetchMock.mockReset();
    clearTestStore();
    await storeIdentitySeed(generateIdentitySeed());
    await initCrypto();

    const { loadIdentity } = await import('../../src/key-store.js');
    const { buildWeVibeSignedAuth } = await import('../../src/auth.js');

    mockLoadIdentity = loadIdentity as ReturnType<typeof vi.fn>;
    mockBuildWeVibeSignedAuth = buildWeVibeSignedAuth as ReturnType<typeof vi.fn>;

    const identity = generateIdentity();
    mockLoadIdentity.mockResolvedValue(identity);
    mockBuildWeVibeSignedAuth.mockResolvedValue({
      pubkeyHex: Buffer.from(identity.edPubkey).toString('hex'),
      headers: { 'Authorization': 'WeVibe-Signed test-signature' },
    });
  });

  afterEach(() => {
    clearTestStore();
  });

  async function callHandleReports(bodyObj: object, authHeader?: string): Promise<{ status: number; body: unknown }> {
    const { handleReports } = await import('../../src/http-server.js');

    const req = createMockRequest(JSON.stringify(bodyObj));
    if (authHeader) {
      req.headers['authorization'] = authHeader;
    }

    let status = 0;
    let responseBody: unknown;

    const res = {
      writeHead: (s: number) => { status = s; },
      end: (b: string) => { responseBody = b ? JSON.parse(b) : undefined; },
    };

    await (handleReports as (req: IncomingMessage, res: unknown) => Promise<void>)(req, res as unknown as import('node:http').ServerResponse);

    return { status, body: responseBody };
  }

  it('POST /v1/reports with valid token + valid body → hub returns 201 → 201', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({ id: 'report-123', status: 'submitted' })),
    });

    const result = await callHandleReports({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      reason: 'incorrect',
      note: 'This memory is wrong',
    }, `Bearer ${validToken}`);

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: 'report-123', status: 'submitted' });
  });

  it('POST /v1/reports with no Authorization → 401', async () => {
    const result = await callHandleReports({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      reason: 'incorrect',
    });

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('POST /v1/reports with wrong token → 401', async () => {
    const result = await callHandleReports({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      reason: 'incorrect',
    }, 'Bearer wrong-token');

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('POST /v1/reports with invalid reason enum → 400', async () => {
    const result = await callHandleReports({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      reason: 'not_a_valid_reason',
    }, `Bearer ${validToken}`);

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('reason');
  });

  it('POST /v1/reports with note > 2000 chars → 400', async () => {
    const result = await callHandleReports({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      reason: 'incorrect',
      note: 'x'.repeat(2001),
    }, `Bearer ${validToken}`);

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('note');
  });

  it('POST /v1/reports when hub returns 403 (trial member) → 403 forwarded', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve(JSON.stringify({ error: 'trial members cannot submit reports' })),
    });

    const result = await callHandleReports({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      reason: 'incorrect',
    }, `Bearer ${validToken}`);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'trial members cannot submit reports' });
  });

  it('POST /v1/reports when hub returns 5xx → 502 generic', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('Bad Gateway'),
    });

    const result = await callHandleReports({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      reason: 'incorrect',
    }, `Bearer ${validToken}`);

    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: 'upstream error' });
  });
});
