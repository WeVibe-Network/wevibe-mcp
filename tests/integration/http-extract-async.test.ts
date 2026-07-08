process.env.WEVIBE_KEYSTORE_TEST = '1';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { SessionTokenStore, _setTokenStoreForTests } from '../../src/session-token.js';
import { clearTestStore } from '../../src/key-store.js';
import { handleRequest } from '../../src/http-server.js';
import { _resetJobsForTests, completeJob, createJob } from '../../src/extract-jobs.js';
import type { ExtractionResult } from '../../src/extraction.js';

const testPath = join(tmpdir(), `wevibe-mcp-http-extract-async-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

vi.stubGlobal('fetch', vi.fn());

function seededExtractionResult(): ExtractionResult {
  return {
    memories: [
      {
        implement: 'Persist extraction status jobs for robust async polling.',
        context: 'HTTP status route integration test seed.',
        dnd: null,
        stack: ['typescript', 'vitest'],
        memory_type: 'memory',
        preference_confidence: 0.9,
        extraction_hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        keywords: {
          classified: [],
          suggestions: [],
        },
      },
    ],
    meta: { emptyReason: 'none' },
  };
}

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
        listeners.data?.forEach(cb => cb(chunk));
      }
      listeners.end?.forEach(cb => cb());
    });
  } else {
    setImmediate(() => {
      listeners.end?.forEach(cb => cb());
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

describe('GET /v1/extract/status/:job_id', () => {
  let validToken: string;
  let jobsDir: string;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();

    _resetJobsForTests();
    jobsDir = join(tmpdir(), `wevibe-mcp-jobs-http-status-${randomUUID()}`);
    process.env.WEVIBE_JOBS_PATH = jobsDir;
  });

  afterEach(() => {
    clearTestStore();
    _resetJobsForTests();
    delete process.env.WEVIBE_JOBS_PATH;
    rmSync(jobsDir, { recursive: true, force: true });
  });

  it('returns 401 without bearer auth', async () => {
    const req = createMockRequest('GET', '/v1/extract/status/job-unauth');
    const res = createMockResponse();

    await handleRequest(req, res);
    const parsed = parseResponse(res);

    expect(parsed.status).toBe(401);
    expect(parsed.body).toEqual({ status: 'error', error: 'unauthorized' });
  });

  it('returns 404 for unknown job with valid bearer auth', async () => {
    const req = createMockRequest('GET', '/v1/extract/status/job-missing', {
      Authorization: `Bearer ${validToken}`,
    });
    const res = createMockResponse();

    await handleRequest(req, res);
    const parsed = parseResponse(res);

    expect(parsed.status).toBe(404);
    expect(parsed.body).toEqual({ status: 'error', error: 'job not found' });
  });

  it('returns seeded done job and preserves result.memories byte-compat shape', async () => {
    const jobId = `job-${randomUUID()}`;
    const seeded = seededExtractionResult();

    createJob(jobId, undefined, 'trace-http-seed');
    completeJob(jobId, seeded, 'trace-http-seed');

    const req = createMockRequest('GET', `/v1/extract/status/${encodeURIComponent(jobId)}`, {
      Authorization: `Bearer ${validToken}`,
    });
    const res = createMockResponse();

    await handleRequest(req, res);
    const parsed = parseResponse(res);
    const body = parsed.body as {
      status: string;
      chunks_done: number;
      chunks_total: number;
      result?: ExtractionResult;
      started_at: string;
      updated_at: string;
    };

    expect(parsed.status).toBe(200);
    expect(body.status).toBe('done');
    expect(body.chunks_done).toBe(0);
    expect(body.chunks_total).toBe(0);
    expect(body.result).toBeDefined();
    expect(body.result?.memories).toEqual(seeded.memories);
    expect(JSON.stringify(body.result?.memories)).toBe(JSON.stringify(seeded.memories));
    expect(typeof body.started_at).toBe('string');
    expect(typeof body.updated_at).toBe('string');
  });
});
