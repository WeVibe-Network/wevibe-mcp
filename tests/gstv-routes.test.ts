process.env.WEVIBE_KEYSTORE_TEST = '1';

import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearTestStore, generateIdentitySeed, storeIdentitySeed } from '../src/key-store.js';
import { handleRequest } from '../src/http-server.js';
import { stopGstvRuntime } from '../src/gstv/routes.js';
import { SessionTokenStore, _setTokenStoreForTests } from '../src/session-token.js';

const testPath = path.join(os.tmpdir(), `wevibe-mcp-gstv-routes-${randomUUID()}`, 'mcp-session-token');
const testStore = new SessionTokenStore(testPath);
const SUITE_LOG_DIR = tmp('gstv-routes-logs-suite-');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function findOpFile(op: string, preferredLogDir: string): string | null {
  const fileName = `${op}-${utcDay()}.log`;
  const candidates = [
    path.join(preferredLogDir, 'ops', fileName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
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

  if (body !== undefined) {
    setImmediate(() => {
      for (let i = 0; i < body.length; i += 1024) {
        const chunk = body.slice(i, i + 1024);
        listeners.data?.forEach((cb) => cb(chunk));
      }
      listeners.end?.forEach((cb) => cb());
    });
  } else {
    setImmediate(() => {
      listeners.end?.forEach((cb) => cb());
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

function parseResponse(res: ServerResponse & { body: string }): { status: number; body: Record<string, unknown> } {
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

function writeRepoMarker(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, '.wevibe'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, '.wevibe', 'org.json'),
    `${JSON.stringify(
      {
        mc_version: 1,
        org_id: 'org-test',
        project_fingerprint: 'proj-fp-123',
        fingerprint_source: 'realpath',
        bound_at: '2026-07-26T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function writeRepoFile(repoRoot: string, relPath: string, body: string): void {
  const abs = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

describe('GSTV HTTP routes', () => {
  let validToken = '';
  let gstvRoot = '';
  let logDir = '';

  beforeEach(async () => {
    stopGstvRuntime();
    _setTokenStoreForTests(testStore);
    testStore._reset();
    await testStore.init();
    validToken = testStore.getToken()!;

    gstvRoot = tmp('gstv-routes-root-');
    logDir = SUITE_LOG_DIR;
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
    process.env.WEVIBE_GSTV_ROOT = gstvRoot;
    process.env.WEVIBE_BENCH_CONSUMER_STATE_DIR = tmp('gstv-routes-state-');
    process.env.WEVIBE_LOG_DIR = logDir;
    clearTestStore();
    await storeIdentitySeed(generateIdentitySeed());
  });

  afterEach(() => {
    stopGstvRuntime();
    clearTestStore();
    delete process.env.WEVIBE_GSTV_ROOT;
    delete process.env.WEVIBE_BENCH_CONSUMER_STATE_DIR;
    delete process.env.WEVIBE_LOG_DIR;
  });

  it('401 without token on GET /v1/gstv/goal and POST /v1/gstv/seal', async () => {
    const goalReq = createMockRequest('GET', '/v1/gstv/goal?repo_root=/tmp/repo');
    const goalRes = createMockResponse();
    await handleRequest(goalReq, goalRes);
    expect(parseResponse(goalRes)).toEqual({
      status: 401,
      body: { status: 'error', error: 'unauthorized' },
    });

    const sealReq = createMockRequest('POST', '/v1/gstv/seal', { 'Content-Type': 'application/json' }, '{}');
    const sealRes = createMockResponse();
    await handleRequest(sealReq, sealRes);
    expect(parseResponse(sealRes)).toEqual({
      status: 401,
      body: { status: 'error', error: 'unauthorized' },
    });
  });

  it('GET /v1/gstv/goal returns open:false when gstv root has no open goal', async () => {
    const repoRoot = tmp('gstv-routes-repo-open-false-');
    const req = createMockRequest('GET', `/v1/gstv/goal?repo_root=${encodeURIComponent(repoRoot)}`, {
      Authorization: `Bearer ${validToken}`,
    });
    const res = createMockResponse();
    await handleRequest(req, res);

    expect(parseResponse(res)).toEqual({ status: 200, body: { open: false } });
  });

  it('POST /v1/gstv/seal validation errors return specific 400 codes', async () => {
    const baseHeaders = {
      Authorization: `Bearer ${validToken}`,
      'Content-Type': 'application/json',
    };

    const cases = [
      { body: { goal_text: 'x', predicate_command: 'npm test', predicate_file_paths: ['a.ts'] }, code: 'repo_root_required' },
      { body: { repo_root: '/tmp/repo', predicate_command: 'npm test', predicate_file_paths: ['a.ts'] }, code: 'goal_text_required' },
      { body: { repo_root: '/tmp/repo', goal_text: 'x', predicate_file_paths: ['a.ts'] }, code: 'predicate_command_required' },
      { body: { repo_root: '/tmp/repo', goal_text: 'x', predicate_command: 'npm test' }, code: 'predicate_file_paths_required' },
    ] as const;

    for (const testCase of cases) {
      const req = createMockRequest('POST', '/v1/gstv/seal', baseHeaders, JSON.stringify(testCase.body));
      const res = createMockResponse();
      await handleRequest(req, res);
      expect(parseResponse(res)).toEqual({
        status: 400,
        body: { status: 'error', code: testCase.code },
      });
    }
  });

  it('POST seal happy path logs gstv.seal and GET goal returns open:true boundary-needed', async () => {
    const repoRoot = tmp('gstv-routes-repo-happy-');
    writeRepoMarker(repoRoot);
    writeRepoFile(repoRoot, 'tests/predicate.test.ts', 'expect(2 + 2).toBe(4);\n');

    const sealReq = createMockRequest(
      'POST',
      '/v1/gstv/seal',
      {
        Authorization: `Bearer ${validToken}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({
        repo_root: repoRoot,
        goal_text: 'make predicate green',
        predicate_command: 'npx vitest run tests/predicate.test.ts',
        predicate_file_paths: ['tests/predicate.test.ts'],
        session_id: 'sess-123',
      }),
    );
    const sealRes = createMockResponse();
    await handleRequest(sealReq, sealRes);
    const sealParsed = parseResponse(sealRes);
    expect(sealParsed.status).toBe(200);
    expect(sealParsed.body.goal_id).toMatch(/^gstv-[0-9a-f]{16}$/);
    expect(sealParsed.body.seal_fp).toMatch(/^[0-9a-f]{8}$/);

    const sealOpsFile = findOpFile('gstv.seal', logDir);
    expect(sealOpsFile).not.toBeNull();
    const sealOps = fs.readFileSync(sealOpsFile!, 'utf8');
    expect(sealOps).toContain('op=gstv.seal');
    expect(sealOps).toContain('status=ok');

    const goalReq = createMockRequest('GET', `/v1/gstv/goal?repo_root=${encodeURIComponent(repoRoot)}`, {
      Authorization: `Bearer ${validToken}`,
    });
    const goalRes = createMockResponse();
    await handleRequest(goalReq, goalRes);
    const goalParsed = parseResponse(goalRes);

    expect(goalParsed.status).toBe(200);
    expect(goalParsed.body).toEqual({
      open: true,
      goal_id: sealParsed.body.goal_id,
      goal_text_fp: expect.stringMatching(/^[0-9a-f]{8}$/),
      predicate: {
        command: 'npx vitest run tests/predicate.test.ts',
        file_paths: ['tests/predicate.test.ts'],
      },
      needs_boundary_run: true,
      boundary_reason: 'no_observations',
    });
  });

  it('POST /v1/gstv/seal on unbound repo returns repo_not_bound', async () => {
    const repoRoot = tmp('gstv-routes-repo-unbound-');
    writeRepoFile(repoRoot, 'tests/predicate.test.ts', 'expect(true).toBe(true);\n');

    const req = createMockRequest(
      'POST',
      '/v1/gstv/seal',
      {
        Authorization: `Bearer ${validToken}`,
        'Content-Type': 'application/json',
      },
      JSON.stringify({
        repo_root: repoRoot,
        goal_text: 'x',
        predicate_command: 'npx vitest run tests/predicate.test.ts',
        predicate_file_paths: ['tests/predicate.test.ts'],
      }),
    );
    const res = createMockResponse();
    await handleRequest(req, res);

    expect(parseResponse(res)).toEqual({
      status: 400,
      body: { status: 'error', code: 'repo_not_bound' },
    });
  });
});
