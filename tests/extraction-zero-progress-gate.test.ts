process.env.WEVIBE_KEYSTORE_TEST = '1';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { SessionTokenStore, _setTokenStoreForTests } from '../src/session-token.js';
import { clearTestStore } from '../src/key-store.js';
import { _resetJobsForTests } from '../src/extract-jobs.js';

const emitExtractionIntegrityMock = vi.hoisted(() => vi.fn());
const segmentFailureEpisodesMock = vi.hoisted(() => vi.fn());
const ollamaChatMock = vi.hoisted(() => vi.fn());

vi.mock('../src/extraction-integrity.js', async () => {
  const actual = await vi.importActual<typeof import('../src/extraction-integrity.js')>('../src/extraction-integrity.js');
  return {
    ...actual,
    emitExtractionIntegrity: emitExtractionIntegrityMock,
  };
});

vi.mock('../src/failure-episodes.js', async () => {
  const actual = await vi.importActual<typeof import('../src/failure-episodes.js')>('../src/failure-episodes.js');
  return {
    ...actual,
    segmentFailureEpisodes: segmentFailureEpisodesMock,
  };
});

vi.mock('../src/llm-ollama.js', async () => {
  const actual = await vi.importActual<typeof import('../src/llm-ollama.js')>('../src/llm-ollama.js');
  return {
    ...actual,
    createOllamaProvider: vi.fn(() => ({
      chat: ollamaChatMock,
    })),
  };
});

import { handleRequest } from '../src/http-server.js';

const testPath = join(tmpdir(), `wevibe-mcp-http-extract-zero-progress-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

type ParsedResponse = { status: number; body: Record<string, unknown> };

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

function parseResponse(res: ServerResponse & { body: string }): ParsedResponse {
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

async function postExtract(validToken: string, payload: Record<string, unknown>): Promise<ParsedResponse> {
  const req = createMockRequest('POST', '/v1/extract', {
    Authorization: `Bearer ${validToken}`,
    'Content-Type': 'application/json',
  }, JSON.stringify(payload));
  const res = createMockResponse();
  await handleRequest(req, res);
  return parseResponse(res);
}

async function getExtractStatus(validToken: string, jobId: string): Promise<ParsedResponse> {
  const req = createMockRequest('GET', `/v1/extract/status/${encodeURIComponent(jobId)}`, {
    Authorization: `Bearer ${validToken}`,
  });
  const res = createMockResponse();
  await handleRequest(req, res);
  return parseResponse(res);
}

function unresolvedEpisodeFixture() {
  return [
    {
      kind: 'tool',
      time: 1,
      seq: 0,
      name: 'bash',
      input: 'go build ./...',
      output: 'build is broken',
      exit: 1,
      status: 'completed',
    },
    {
      kind: 'edit',
      time: 2,
      seq: 0,
      file: 'src/main.go',
      detail: 'attempt fix',
    },
  ];
}

function resolvedEpisodeFixture() {
  return [
    {
      kind: 'tool',
      time: 1,
      seq: 0,
      name: 'npm test',
      input: 'npm test',
      output: 'FAIL src/app.test.ts',
      exit: 1,
      status: 'completed',
    },
    {
      kind: 'edit',
      time: 2,
      seq: 0,
      file: 'src/app.ts',
      detail: 'attempt fix',
    },
    {
      kind: 'tool',
      time: 3,
      seq: 0,
      name: 'npm test',
      input: 'npm test',
      output: 'PASS src/app.test.ts',
      exit: 0,
      status: 'completed',
    },
  ];
}

describe('POST /v1/extract zero-progress gate', () => {
  let validToken: string;
  let jobsDir: string;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();

    _resetJobsForTests();
    jobsDir = join(tmpdir(), `wevibe-mcp-jobs-zero-progress-${randomUUID()}`);
    process.env.WEVIBE_JOBS_PATH = jobsDir;

    fetchMock.mockReset();
    ollamaChatMock.mockReset();
    ollamaChatMock.mockResolvedValue('[]');

    emitExtractionIntegrityMock.mockReset();
    emitExtractionIntegrityMock.mockImplementation((input: unknown) => input);

    segmentFailureEpisodesMock.mockReset();
    const actual = await vi.importActual<typeof import('../src/failure-episodes.js')>('../src/failure-episodes.js');
    segmentFailureEpisodesMock.mockImplementation(actual.segmentFailureEpisodes);
  });

  afterEach(() => {
    clearTestStore();
    _resetJobsForTests();
    delete process.env.WEVIBE_JOBS_PATH;
    rmSync(jobsDir, { recursive: true, force: true });
  });

  it('completes zero-progress sessions immediately with no memories and no LLM call', async () => {
    const extractResponse = await postExtract(validToken, {
      model: 'llama3.1:8b-instruct-q4_0',
      events: unresolvedEpisodeFixture(),
      session_id: 'session-zero-progress',
      project_context: {
        title: 'zero-progress-project',
        directory: '/tmp',
        stack: ['typescript'],
      },
    });

    expect(extractResponse.status).toBe(202);
    expect(extractResponse.body.status).toBe('accepted');

    const jobId = extractResponse.body.job_id;
    expect(typeof jobId).toBe('string');

    const statusResponse = await getExtractStatus(validToken, String(jobId));
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.status).toBe('done');

    const result = statusResponse.body.result as { memories: unknown[]; meta?: { emptyReason?: string } };
    expect(Array.isArray(result.memories)).toBe(true);
    expect(result.memories).toEqual([]);
    expect(result.meta?.emptyReason).toBe('zero_progress');

    expect(ollamaChatMock).not.toHaveBeenCalled();

    expect(emitExtractionIntegrityMock).toHaveBeenCalledWith(expect.objectContaining({
      jobId: String(jobId),
      outcome: 'completed',
      emittedMemoryCount: 0,
      emptyReason: 'zero_progress',
      episodes: {
        resolved: 0,
        unresolved: 1,
        coincidental: 0,
      },
    }));

    const integrityInput = emitExtractionIntegrityMock.mock.calls[0]?.[0] as {
      episodes: { resolved: number };
      emittedMemoryCount: number;
      outcome: string;
    };
    expect(integrityInput.outcome).toBe('completed');
    expect(integrityInput.episodes.resolved).toBe(0);
    expect(integrityInput.emittedMemoryCount).toBe(0);
    expect(integrityInput.episodes.resolved === 0 && integrityInput.emittedMemoryCount > 0).toBe(false);
  });

  it('runs normal extraction path when resolved episodes are present', async () => {
    const extractResponse = await postExtract(validToken, {
      model: 'llama3.1:8b-instruct-q4_0',
      events: resolvedEpisodeFixture(),
      session_id: 'session-resolved',
      project_context: {
        title: 'resolved-project',
        directory: '/tmp',
        stack: ['typescript'],
      },
    });

    expect(extractResponse.status).toBe(202);
    expect(extractResponse.body.status).toBe('accepted');

    const jobId = String(extractResponse.body.job_id);

    ollamaChatMock.mockResolvedValue(JSON.stringify([
      {
        implement: 'Capture and retain resolved debugging tactic for future reuse.',
        context: 'Resolved test failure after targeted edit.',
        dnd: null,
        stack: ['typescript', 'vitest'],
        memory_type: 'memory',
      },
    ]));

    const deadline = Date.now() + 3000;
    let statusResponse = await getExtractStatus(validToken, jobId);
    while (statusResponse.body.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      statusResponse = await getExtractStatus(validToken, jobId);
    }

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.status).toBe('done');
    expect(ollamaChatMock).toHaveBeenCalled();

    const completionCall = emitExtractionIntegrityMock.mock.calls.find(call => call[0]?.jobId === jobId)?.[0] as {
      outcome: string;
      episodes: { resolved: number };
      emittedMemoryCount: number;
    };
    expect(completionCall).toBeDefined();
    expect(completionCall.outcome).toBe('completed');
    expect(completionCall.episodes.resolved).toBeGreaterThanOrEqual(1);
    expect(completionCall.emittedMemoryCount).toBeGreaterThanOrEqual(0);
    expect(completionCall.episodes.resolved === 0 && completionCall.emittedMemoryCount > 0).toBe(false);
  });

  it('fails closed when failure-episode segmentation throws and emits failed integrity', async () => {
    segmentFailureEpisodesMock.mockImplementation(() => {
      throw new Error('segmentation exploded');
    });

    const extractResponse = await postExtract(validToken, {
      model: 'llama3.1:8b-instruct-q4_0',
      events: unresolvedEpisodeFixture(),
      session_id: 'session-segmentation-fail',
    });

    expect(extractResponse.status).toBe(500);
    expect(extractResponse.body).toEqual({
      status: 'error',
      error: 'extraction_segmentation_failed',
    });

    expect(ollamaChatMock).not.toHaveBeenCalled();
    expect(emitExtractionIntegrityMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
      emptyReason: 'segmentation_error',
    }));
  });
});
