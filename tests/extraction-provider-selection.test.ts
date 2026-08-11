process.env.WEVIBE_KEYSTORE_TEST = '1';

/**
 * Regression coverage for extraction PROVIDER SELECTION.
 *
 * WHY THIS FILE EXISTS: `handleExtract` derived the WIRE PROTOCOL from the
 * COST axis — `const provider = isLocal ? createOllamaProvider(...) : ...`.
 * Those are independent concerns. "Local" says the call is unmetered (trust a
 * num_ctx hint, run chunks serially, skip reroute-retry); it says NOTHING about
 * whether the engine speaks Ollama's native `/api/chat` or the OpenAI-compatible
 * `/v1/chat/completions`.
 *
 * The stack moved Ollama -> paid API -> LM Studio -> oMLX behind a local relay
 * proxy. All of those except Ollama are OpenAI-compatible, so every local
 * engine was being sent to `/api/chat` and answering 404 — and the dashboard's
 * LM Studio path had its configured `base_url` silently ignored.
 *
 * These tests assert the two axes stay separate, by driving the real
 * `handleRequest` and observing WHICH provider factory is constructed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { SessionTokenStore, _setTokenStoreForTests } from '../src/session-token.js';
import { clearTestStore } from '../src/key-store.js';
import { _resetJobsForTests, getJob } from '../src/extract-jobs.js';

const createOllamaProviderMock = vi.hoisted(() => vi.fn());
const createOpenAICompatibleProviderMock = vi.hoisted(() => vi.fn());
const chatMock = vi.hoisted(() => vi.fn());

vi.mock('../src/llm-ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/llm-ollama.js')>()),
  createOllamaProvider: createOllamaProviderMock,
}));

vi.mock('../src/llm-openai-compat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/llm-openai-compat.js')>()),
  createOpenAICompatibleProvider: createOpenAICompatibleProviderMock,
}));

import { handleRequest } from '../src/http-server.js';

const testPath = join(tmpdir(), `wevibe-mcp-provider-select-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

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

  setImmediate(() => {
    if (body) {
      listeners.data?.forEach(cb => cb(body));
    }
    listeners.end?.forEach(cb => cb());
  });

  return req;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
  let statusCode = 200;
  let responseBody = '';
  const res = {
    writeHead: (status: number) => { statusCode = status; },
    end: (body?: string) => { if (body) responseBody = body; },
    get statusCode() { return statusCode; },
    get body() { return responseBody; },
  } as unknown as ServerResponse & { statusCode: number; body: string };
  return res;
}

/** A minimal substrate with one resolved failure episode, so extraction is not gated. */
function resolvedEpisodeEvents(): unknown[] {
  return [
    { kind: 'user', time: 1000, seq: 0, role: 'user', text: 'the build fails' },
    {
      kind: 'tool',
      time: 1100,
      seq: 1,
      name: 'bash',
      input: 'npm run build',
      output: "src/index.ts(4,1): error TS2304: Cannot find name 'foo'.",
      exit: 1,
    },
    { kind: 'edit', time: 1200, seq: 2, name: 'edit', file: 'src/index.ts', detail: 'declare foo' },
    { kind: 'tool', time: 1300, seq: 3, name: 'bash', input: 'npm run build', output: 'Build succeeded', exit: 0 },
  ];
}

async function postExtract(token: string, payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = createMockRequest('POST', '/v1/extract', {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }, JSON.stringify(payload));
  const res = createMockResponse();
  await handleRequest(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

/** Wait for the async extraction job to leave the running state. */
async function settleJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = getJob(jobId);
    if (job && job.status !== 'running') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('extraction provider selection — cost axis vs wire protocol', () => {
  let validToken: string;
  let jobsDir: string;

  beforeEach(async () => {
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();

    _resetJobsForTests();
    jobsDir = join(tmpdir(), `wevibe-mcp-jobs-provider-${randomUUID()}`);
    process.env.WEVIBE_JOBS_PATH = jobsDir;

    fetchMock.mockReset();
    chatMock.mockReset();
    chatMock.mockResolvedValue('{"memories": []}');
    createOllamaProviderMock.mockReset();
    createOllamaProviderMock.mockImplementation((_url: string, model: string) => ({ model, chat: chatMock }));
    createOpenAICompatibleProviderMock.mockReset();
    createOpenAICompatibleProviderMock.mockImplementation((_baseUrl: string, model: string) => ({ model, chat: chatMock }));
  });

  afterEach(() => {
    clearTestStore();
    _resetJobsForTests();
    delete process.env.WEVIBE_JOBS_PATH;
    rmSync(jobsDir, { recursive: true, force: true });
  });

  it('routes the local relay proxy to the OpenAI-compatible transport, NOT Ollama', async () => {
    // The exact call that produced `Ollama returned 404`: a local, unmetered
    // engine that speaks OpenAI-compatible.
    const response = await postExtract(validToken, {
      model: 'qwen3.6-35b-a3b-bench',
      provider: 'local-llm-proxy',
      base_url: 'http://127.0.0.1:4545/v1',
      num_ctx: 262144,
      events: resolvedEpisodeEvents(),
      session_id: 'session-local-proxy',
      project_context: { title: 'p', directory: '/tmp/p', stack: 'ts' },
    });

    expect(response.status).toBe(202);
    await settleJob(response.body.job_id as string);

    expect(createOllamaProviderMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleProviderMock).toHaveBeenCalledTimes(1);
    // The caller's base_url must be honoured, never replaced by a remote default.
    expect(createOpenAICompatibleProviderMock.mock.calls[0][0]).toBe('http://127.0.0.1:4545/v1');
  });

  it('routes LM Studio to the OpenAI-compatible transport and honours the configured base_url', async () => {
    // The dashboard sends exactly this shape. Before the fix it was classified
    // "local" and sent to Ollama on :11434, silently ignoring lmstudio_url.
    const response = await postExtract(validToken, {
      model: 'local-model',
      provider: 'lm_studio',
      api_key: 'lm-studio',
      base_url: 'http://127.0.0.1:1234/v1',
      events: resolvedEpisodeEvents(),
      session_id: 'session-lmstudio',
      project_context: { title: 'p', directory: '/tmp/p', stack: 'ts' },
    });

    expect(response.status).toBe(202);
    await settleJob(response.body.job_id as string);

    expect(createOllamaProviderMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleProviderMock).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatibleProviderMock.mock.calls[0][0]).toBe('http://127.0.0.1:1234/v1');
  });

  it('still routes an explicit ollama provider to the native Ollama transport', async () => {
    const response = await postExtract(validToken, {
      model: 'llama3.1:8b-instruct-q4_0',
      provider: 'ollama',
      ollama_url: 'http://127.0.0.1:11434',
      events: resolvedEpisodeEvents(),
      session_id: 'session-ollama',
      project_context: { title: 'p', directory: '/tmp/p', stack: 'ts' },
    });

    expect(response.status).toBe(202);
    await settleJob(response.body.job_id as string);

    expect(createOpenAICompatibleProviderMock).not.toHaveBeenCalled();
    expect(createOllamaProviderMock).toHaveBeenCalledTimes(1);
    expect(createOllamaProviderMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434');
  });

  it('preserves the legacy Ollama default when no provider is named', async () => {
    const response = await postExtract(validToken, {
      model: 'llama3.1:8b-instruct-q4_0',
      events: resolvedEpisodeEvents(),
      session_id: 'session-default',
      project_context: { title: 'p', directory: '/tmp/p', stack: 'ts' },
    });

    expect(response.status).toBe(202);
    await settleJob(response.body.job_id as string);

    expect(createOpenAICompatibleProviderMock).not.toHaveBeenCalled();
    expect(createOllamaProviderMock).toHaveBeenCalledTimes(1);
  });

  it('routes openrouter to the OpenAI-compatible transport', async () => {
    const response = await postExtract(validToken, {
      model: 'anthropic/claude-3.5-sonnet',
      provider: 'openrouter',
      api_key: 'sk-test',
      base_url: 'https://openrouter.ai/api/v1',
      events: resolvedEpisodeEvents(),
      session_id: 'session-openrouter',
      project_context: { title: 'p', directory: '/tmp/p', stack: 'ts' },
    });

    expect(response.status).toBe(202);
    await settleJob(response.body.job_id as string);

    expect(createOllamaProviderMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleProviderMock).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatibleProviderMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1');
  });

  it('fails a local provider that omits base_url instead of falling back to the paid remote API', async () => {
    // Fail-closed: the old default was `https://openrouter.ai/api/v1`, so a
    // misconfigured LOCAL call would have been billed to a remote provider.
    const response = await postExtract(validToken, {
      model: 'qwen3.6-35b-a3b-bench',
      provider: 'local-llm-proxy',
      events: resolvedEpisodeEvents(),
      session_id: 'session-no-base-url',
      project_context: { title: 'p', directory: '/tmp/p', stack: 'ts' },
    });

    // Rejected up front with a typed code, rather than silently reaching out
    // to a paid endpoint on a call the operator declared local.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('provider_misconfigured');

    expect(createOpenAICompatibleProviderMock).not.toHaveBeenCalled();
    expect(createOllamaProviderMock).not.toHaveBeenCalled();
  });
});
