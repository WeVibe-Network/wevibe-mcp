process.env.WEVIBE_KEYSTORE_TEST = '1';

/**
 * Coverage for the OrcaRouter provider path added in WO-CLOUD-6B:
 *
 * - `src/orcarouter.ts`: auth.json key resolution (fail-closed), static limits
 *   from opencode.json (fail-open), the live model catalog (fail-closed miss),
 *   per-dimension lower-limit merging, and prefix normalization.
 * - `src/http-server.ts`: `POST /v1/extract` with `provider: 'orcarouter'` and
 *   NO `api_key` resolves the operator's key from auth.json and honours the
 *   caller's `base_url` when constructing the OpenAI-compatible provider.
 *
 * D-MISSION-INVARIANT: the fixture key below is FAKE (51 chars, all zeros
 * tail). The leak test asserts no `logOp` invocation ever serializes it —
 * only `key_len` / `key_fp` may appear.
 *
 * Fixtures are a single static set; each test uses a DISTINCT model id so the
 * module-level catalog cache never serves a stale entry to a test that expects
 * a fresh resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { readFileSync as RealReadFileSync } from 'node:fs';
import { rmSync } from 'node:fs';

// Fixtures live in vi.hoisted so the node:fs mock factory (which runs during
// import resolution — before any module-level const executes) can serve them.
// NOTE: src/extraction-presets.ts reads prompt files EAGERLY at import time,
// so the mock's factory-time default delegates non-fixture paths to the real
// readFileSync; the unit-test beforeEach then installs the strict
// fixture-or-ENOENT variant (orcarouter only ever reads auth.json/opencode.json,
// both fixture-served, so unit behavior is unchanged).
const fixtures = vi.hoisted(() => {
  // FAKE fixture key — exactly 51 chars ('sk-orca-' + 43 zeros). NEVER the
  // operator's real orcarouter key.
  const FIXTURE_ORCAROUTER_KEY = `sk-orca-${'0'.repeat(43)}`;

  const AUTH_FIXTURE = JSON.stringify({
    orcarouter: { key: FIXTURE_ORCAROUTER_KEY, type: 'api' },
    openrouter: { key: 'sk-or-v1-other', type: 'api' },
  });

  const AUTH_FIXTURE_WITHOUT_ORCAROUTER = JSON.stringify({
    openrouter: { key: 'sk-or-v1-other', type: 'api' },
  });

  const OPENCODE_FIXTURE = JSON.stringify({
    provider: {
      orcarouter: {
        models: {
          'deepseek/deepseek-v4-pro-0813': { limit: { context: 1048576, output: 65536 } },
          'deepseek/deepseek-v4-flash-0731': { limit: { context: 2000000, output: 1000000 } },
          'grok/grok-4.6': { limit: { context: 500000, output: 65536 } },
        },
      },
    },
  });

  const CATALOG_FIXTURE = {
    data: [
      { id: 'deepseek/deepseek-v4-pro-0813', context_length: 1048576, max_completion_tokens: 384000 },
      { id: 'deepseek/deepseek-v4-flash-0731', context_length: 1048576, max_completion_tokens: 384000 },
      { id: 'grok/grok-4.6', context_length: 1048576, max_completion_tokens: 384000 },
      { id: 'anthropic/claude-opus-5', context_length: 1000000, max_completion_tokens: 128000 },
    ],
  };

  return { FIXTURE_ORCAROUTER_KEY, AUTH_FIXTURE, AUTH_FIXTURE_WITHOUT_ORCAROUTER, OPENCODE_FIXTURE, CATALOG_FIXTURE };
});

const TEST_HOME = '/mock-home';
const FIXTURE_ORCAROUTER_KEY = fixtures.FIXTURE_ORCAROUTER_KEY;
const AUTH_FIXTURE = fixtures.AUTH_FIXTURE;
const AUTH_FIXTURE_WITHOUT_ORCAROUTER = fixtures.AUTH_FIXTURE_WITHOUT_ORCAROUTER;
const OPENCODE_FIXTURE = fixtures.OPENCODE_FIXTURE;
const CATALOG_FIXTURE = fixtures.CATALOG_FIXTURE;

const mocks = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  homedirMock: vi.fn((): string => '/mock-home'),
  logOpMock: vi.fn(),
  realReadFileSync: undefined as typeof RealReadFileSync | undefined,
}));

// readFileSync is intercepted so auth.json/opencode.json resolve to fixtures;
// every other fs export stays real (job persistence, prompt-file loads, etc.).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mocks.realReadFileSync = actual.readFileSync;
  // Factory-time default: fixture-or-DELEGATE. Required because
  // extraction-presets.ts reads prompts eagerly during import resolution,
  // before any beforeEach runs.
  mocks.readFileSyncMock.mockImplementation((...args: Parameters<typeof RealReadFileSync>) => {
    const p = String(args[0]);
    if (p.includes('auth.json')) return fixtures.AUTH_FIXTURE;
    if (p.includes('opencode.json')) return fixtures.OPENCODE_FIXTURE;
    return (actual.readFileSync as (...a: Parameters<typeof RealReadFileSync>) => string)(...args);
  });
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof RealReadFileSync>) => mocks.readFileSyncMock(...args),
  };
});

// homedir is intercepted (default impl set above so eager callers at import
// time — e.g. session-token's default store path — never see undefined).
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: mocks.homedirMock,
}));

// logOp is mocked file-wide (repo pattern from hub-fetch.test.ts): keeps the
// leak-check hermetic and stops op-log writes from unit paths. fp stays real.
vi.mock('../src/logger.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/logger.js')>()),
  logOp: mocks.logOpMock,
}));

// Provider factory mocks for the handleRequest routing test (g) — mirrors
// extraction-provider-selection.test.ts.
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

import {
  ORCAROUTER_BASE_URL,
  resolveOrcarouterApiKey,
  resolveOrcarouterModelLimits,
} from '../src/orcarouter.js';
import { ContextWindowResolutionError } from '../src/model-context.js';
import { fp } from '../src/logger.js';
import { SessionTokenStore, _setTokenStoreForTests } from '../src/session-token.js';
import { clearTestStore } from '../src/key-store.js';
import { _resetJobsForTests, getJob } from '../src/extract-jobs.js';
import { handleRequest } from '../src/http-server.js';

function fixtureOrEnoentReadFileSync(path: unknown): string {
  const p = String(path);
  if (p.includes('auth.json')) return AUTH_FIXTURE;
  if (p.includes('opencode.json')) return OPENCODE_FIXTURE;
  throw new Error('ENOENT');
}

function catalogResponse(): Response {
  return new Response(JSON.stringify(CATALOG_FIXTURE), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.homedirMock.mockReturnValue(TEST_HOME);
  // Strict unit variant: auth.json/opencode.json -> fixtures, anything else
  // -> ENOENT (the integration describe swaps in the delegating variant).
  mocks.readFileSyncMock.mockImplementation(fixtureOrEnoentReadFileSync);
  mocks.logOpMock.mockReset();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => catalogResponse());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('orcarouter — key resolution and model limits', () => {
  it('(a) resolves real context_length from the catalog; config wins the output lower-limit', async () => {
    // catalog: context_length 1048576, max_completion_tokens 384000
    // static config: output 65536 -> min(384000, 65536) = 65536
    await expect(
      resolveOrcarouterModelLimits('deepseek/deepseek-v4-pro-0813', 'trace-a'),
    ).resolves.toEqual({ contextWindow: 1048576, maxCompletionTokens: 65536 });
    expect(fetchSpy).toHaveBeenCalledWith(
      `${ORCAROUTER_BASE_URL}/models`,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('(b1) lower-limit config-wins on the context dimension', async () => {
    // catalog context 1048576 vs static 500000 -> 500000; output min(384000, 65536) = 65536
    await expect(resolveOrcarouterModelLimits('grok/grok-4.6', 'trace-b1')).resolves.toEqual({
      contextWindow: 500000,
      maxCompletionTokens: 65536,
    });
  });

  it('(b2) lower-limit API-wins when static config is higher than the API value', async () => {
    // config context 2000000 > API 1048576 -> 1048576; config output 1000000 > API 384000 -> 384000
    await expect(
      resolveOrcarouterModelLimits('deepseek/deepseek-v4-flash-0731', 'trace-b2'),
    ).resolves.toEqual({ contextWindow: 1048576, maxCompletionTokens: 384000 });
  });

  it('(b3) model absent from static config falls back to the live catalog value', async () => {
    // in catalog, NOT in the opencode.json fixture -> untouched live values
    await expect(
      resolveOrcarouterModelLimits('anthropic/claude-opus-5', 'trace-b3'),
    ).resolves.toEqual({ contextWindow: 1000000, maxCompletionTokens: 128000 });
  });

  it('(c) fails closed on a model absent from the catalog', async () => {
    await expect(resolveOrcarouterModelLimits('nonexistent/model', 'trace-c')).rejects.toBeInstanceOf(
      ContextWindowResolutionError,
    );

    let caught: unknown;
    try {
      await resolveOrcarouterModelLimits('nonexistent/model', 'trace-c');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContextWindowResolutionError);
    expect((caught as ContextWindowResolutionError).code).toBe('unknown_model_context');
    expect((caught as Error).message).toContain('OrcaRouter');
  });

  it('(d) normalizes the orcarouter/ prefix before resolution', async () => {
    await expect(
      resolveOrcarouterModelLimits('orcarouter/deepseek/deepseek-v4-pro-0813', 'trace-d'),
    ).resolves.toEqual({ contextWindow: 1048576, maxCompletionTokens: 65536 });
  });

  it('(e) resolves the key from auth.json and NEVER logs the raw key', async () => {
    // Fresh module instance: the module-level catalog cache is cold, so the
    // limit resolution runs the live refresh path — the one that touches the
    // key and logs key_len/key_fp. (vi.mock registrations survive resetModules.)
    vi.resetModules();
    const fresh = await import('../src/orcarouter.js');

    const key = fresh.resolveOrcarouterApiKey();
    expect(key).toBe(FIXTURE_ORCAROUTER_KEY);
    expect(key).toHaveLength(51);
    expect(key.startsWith('sk-orca-')).toBe(true);

    mocks.logOpMock.mockClear();
    fetchSpy.mockClear();
    await expect(
      fresh.resolveOrcarouterModelLimits('deepseek/deepseek-v4-pro-0813', 'trace-e'),
    ).resolves.toEqual({ contextWindow: 1048576, maxCompletionTokens: 65536 });

    // The live refresh actually ran (key-bearing log fields were exercised):
    // exactly one catalog fetch, and a refresh log carrying key_len/key_fp.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const catalogLogs = mocks.logOpMock.mock.calls.filter(
      (call: unknown[]) => call[0] === 'orcarouter_catalog',
    );
    const refreshCall = catalogLogs.find(
      (call: unknown[]) => (call[2] as Record<string, unknown>).phase === 'refresh',
    );
    expect(refreshCall).toBeDefined();
    const refreshFields = refreshCall![2] as Record<string, unknown>;
    expect(refreshFields.key_len).toBe(Buffer.byteLength(FIXTURE_ORCAROUTER_KEY));
    expect(refreshFields.key_fp).toBe(fp(FIXTURE_ORCAROUTER_KEY));

    // D-MISSION-INVARIANT: no logOp invocation — op, level, or serialized
    // fields — may ever contain the raw key. Only key_fp/key_len are allowed.
    for (const call of mocks.logOpMock.mock.calls) {
      const serialized = JSON.stringify({ op: call[0], level: call[1], fields: call[2] });
      expect(serialized).not.toContain(FIXTURE_ORCAROUTER_KEY);
    }
  });

  it('(f) fails closed when auth.json has no orcarouter entry (and names the fix)', () => {
    mocks.readFileSyncMock.mockImplementation((path: unknown): string => {
      const p = String(path);
      if (p.includes('auth.json')) return AUTH_FIXTURE_WITHOUT_ORCAROUTER;
      if (p.includes('opencode.json')) return OPENCODE_FIXTURE;
      throw new Error('ENOENT');
    });

    let caught: unknown;
    try {
      resolveOrcarouterApiKey();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('auth.json');
    expect((caught as Error).message).toContain('opencode /connect');
  });

  it('(f2) fails closed when the orcarouter key is an empty string', () => {
    mocks.readFileSyncMock.mockImplementation((path: unknown): string => {
      const p = String(path);
      if (p.includes('auth.json')) {
        return JSON.stringify({ orcarouter: { key: '', type: 'api' } });
      }
      if (p.includes('opencode.json')) return OPENCODE_FIXTURE;
      throw new Error('ENOENT');
    });

    expect(() => resolveOrcarouterApiKey()).toThrow(/auth\.json/);
  });
});

// ---------------------------------------------------------------------------
// (g) Integration: POST /v1/extract with provider=orcarouter and NO api_key.
// Harness mirrors extraction-provider-selection.test.ts (mock request/response
// driving the real handleRequest), plus the auth.json fs fixture from above:
// the key must come out of auth.json, and base_url must be honoured verbatim.
// ---------------------------------------------------------------------------

function createMockRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
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

/** Minimal valid non-empty SubstrateEvent array (one resolved failure episode). */
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

async function postExtract(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
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

describe('orcarouter routing — POST /v1/extract', () => {
  const tokenPath = join(
    tmpdir(),
    `wevibe-mcp-orcarouter-routing-${randomUUID()}`,
    'mcp-session-token',
  );
  const testStore = new SessionTokenStore(tokenPath);

  let validToken: string;
  let jobsDir: string;

  beforeEach(async () => {
    // Integration variant: non-fixture reads (prompt files, job records,
    // session-token file) delegate to the REAL fs; auth.json/opencode.json
    // still resolve to the static fixtures.
    mocks.readFileSyncMock.mockImplementation(
      (path: unknown, options?: Parameters<typeof RealReadFileSync>[1]) => {
        const p = String(path);
        if (p.includes('auth.json')) return AUTH_FIXTURE;
        if (p.includes('opencode.json')) return OPENCODE_FIXTURE;
        return mocks.realReadFileSync!(path, options as never);
      },
    );

    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;
    clearTestStore();

    _resetJobsForTests();
    jobsDir = join(tmpdir(), `wevibe-mcp-jobs-orcarouter-${randomUUID()}`);
    process.env.WEVIBE_JOBS_PATH = jobsDir;

    chatMock.mockReset();
    chatMock.mockResolvedValue('{"memories": []}');
    createOllamaProviderMock.mockReset();
    createOllamaProviderMock.mockImplementation((_url: string, model: string) => ({ model, chat: chatMock }));
    createOpenAICompatibleProviderMock.mockReset();
    createOpenAICompatibleProviderMock.mockImplementation(
      (_baseUrl: string, model: string) => ({ model, chat: chatMock }),
    );
  });

  afterEach(() => {
    clearTestStore();
    _resetJobsForTests();
    delete process.env.WEVIBE_JOBS_PATH;
    rmSync(jobsDir, { recursive: true, force: true });
  });

  it('(g) resolves the key from auth.json and honours base_url for provider=orcarouter', async () => {
    expect(ORCAROUTER_BASE_URL).toBe('https://api.orcarouter.ai/v1');

    const response = await postExtract(validToken, {
      provider: 'orcarouter',
      model: 'deepseek/deepseek-v4-pro-0813',
      base_url: 'https://api.orcarouter.ai/v1',
      events: resolvedEpisodeEvents(),
      session_id: 'session-orcarouter',
      project_context: { title: 'p', directory: '/tmp/p', stack: 'ts' },
    });

    expect(response.status).toBe(202);

    // NOT Ollama; exactly one OpenAI-compatible provider built with the
    // caller's base_url, the request model, and the auth.json fixture key
    // (no api_key was sent — it MUST come out of auth.json).
    expect(createOllamaProviderMock).not.toHaveBeenCalled();
    expect(createOpenAICompatibleProviderMock).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatibleProviderMock).toHaveBeenCalledWith(
      'https://api.orcarouter.ai/v1',
      'deepseek/deepseek-v4-pro-0813',
      FIXTURE_ORCAROUTER_KEY,
    );

    // The job must run to completion: in-job context resolution goes through
    // the OrcaRouter catalog path (resolveOrcarouterModelLimits), which would
    // fail the job if the key or catalog resolution broke.
    await settleJob(response.body.job_id as string);
    const job = getJob(response.body.job_id as string);
    expect(job).toBeDefined();
    expect(job!.status).toBe('done');
  });
});
