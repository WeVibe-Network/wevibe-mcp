process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { initCrypto, generateIdentity } from '../../src/crypto.js';
import { clearTestStore, storeIdentitySeed, generateIdentitySeed } from '../../src/key-store.js';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const testPath = join(tmpdir(), `wevibe-mcp-decision-notes-test-${randomUUID()}`, 'mcp-session-token');
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
    url: '/v1/decision-notes',
    headers: {},
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

describe('POST /v1/decision-notes', () => {
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
      headers: { Authorization: 'WeVibe-Signed test-signature' },
    });
  });

  afterEach(() => {
    clearTestStore();
  });

  async function callHandleDecisionNotes(
    body: object | string,
    authHeader: string | null = `Bearer ${validToken}`,
  ): Promise<{ status: number; body: unknown }> {
    const { handleDecisionNotes } = await import('../../src/http-server.js');

    const req = createMockRequest(typeof body === 'string' ? body : JSON.stringify(body));
    if (authHeader !== null) {
      req.headers.authorization = authHeader;
    }

    let status = 0;
    let responseBody: unknown;

    const res = {
      writeHead: (s: number) => { status = s; },
      end: (b: string) => { responseBody = b ? JSON.parse(b) : undefined; },
    };

    await (
      handleDecisionNotes as (req: IncomingMessage, res: unknown) => Promise<void>
    )(req, res as unknown as import('node:http').ServerResponse);

    return { status, body: responseBody };
  }

  it('valid body + hub 200 → 200 passthrough and correct forward shape', async () => {
    const reason = 'policy violation';
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ id: 'dn-123', status: 'queued' })),
    });

    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
      reason,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: 'dn-123', status: 'queued' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/orgs/org-123/decision-notes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      memory_hash: 'QmHash123',
      action: 'deny',
      reason,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toMatch(/^WeVibe-Signed/);
    expect(Object.prototype.hasOwnProperty.call(headers, 'X-WeVibe-Trace-Id')).toBe(true);
  });

  it('reason omitted → forward reason empty string and hub 201 maps to MCP 200', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({ id: 'dn-201', status: 'created' })),
    });

    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: 'dn-201', status: 'created' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      memory_hash: 'QmHash123',
      action: 'deny',
      reason: '',
    });
  });

  it('no Authorization header → 401', async () => {
    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
    }, null);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('wrong token → 401', async () => {
    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
    }, 'Bearer wrong-token');

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('invalid action values → 400', async () => {
    const allowResult = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'allow',
    });
    expect(allowResult.status).toBe(400);
    expect((allowResult.body as { error: string }).error).toContain('action');

    const uppercaseResult = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'DENY',
    });
    expect(uppercaseResult.status).toBe(400);
    expect((uppercaseResult.body as { error: string }).error).toContain('action');

    const missingResult = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
    });
    expect(missingResult.status).toBe(400);
    expect((missingResult.body as { error: string }).error).toContain('action');

    const numericResult = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 42,
    });
    expect(numericResult.status).toBe(400);
    expect((numericResult.body as { error: string }).error).toContain('action');
  });

  it('missing org_id and empty memory_hash → 400', async () => {
    const missingOrgResult = await callHandleDecisionNotes({
      memory_hash: 'QmHash123',
      action: 'deny',
    });
    expect(missingOrgResult.status).toBe(400);
    expect((missingOrgResult.body as { error: string }).error).toContain('org_id');

    const emptyMemoryHashResult = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: '',
      action: 'deny',
    });
    expect(emptyMemoryHashResult.status).toBe(400);
    expect((emptyMemoryHashResult.body as { error: string }).error).toContain('memory_hash');
  });

  it('invalid reason values → 400', async () => {
    const tooLongResult = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
      reason: 'x'.repeat(501),
    });
    expect(tooLongResult.status).toBe(400);
    expect((tooLongResult.body as { error: string }).error).toContain('reason');

    const nonStringResult = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
      reason: 123,
    });
    expect(nonStringResult.status).toBe(400);
    expect((nonStringResult.body as { error: string }).error).toContain('reason');
  });

  it('invalid JSON body → 400 invalid JSON', async () => {
    const result = await callHandleDecisionNotes('{not json', `Bearer ${validToken}`);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ status: 'error', error: 'invalid JSON' });
  });

  it('hub 403 passes through verbatim', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve(JSON.stringify({ error: 'trial members cannot post decision notes' })),
    });

    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'trial members cannot post decision notes' });
  });

  it('hub 500 passes through verbatim', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ error: 'hub exploded' })),
    });

    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
    });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'hub exploded' });
  });

  it('hub fetch throws plain Error → 502 upstream error', async () => {
    const { hubFetchVerified } = await import('../../src/hub-fetch.js');
    const mockHubFetchVerified = hubFetchVerified as ReturnType<typeof vi.fn>;
    mockHubFetchVerified.mockRejectedValueOnce(new Error('network down'));

    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
    });

    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: 'upstream error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hub signature verification failure → 502 specific error', async () => {
    const { hubFetchVerified, HubSignatureError } = await import('../../src/hub-fetch.js');
    const mockHubFetchVerified = hubFetchVerified as ReturnType<typeof vi.fn>;
    mockHubFetchVerified.mockRejectedValueOnce(new HubSignatureError('bad signature'));

    const result = await callHandleDecisionNotes({
      org_id: 'org-123',
      memory_hash: 'QmHash123',
      action: 'deny',
    });

    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: 'upstream signature verification failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
