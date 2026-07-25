process.env.WEVIBE_KEYSTORE_TEST = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readChain } from '../src/gstv/chain.js';
import { GstvEngine } from '../src/gstv/engine.js';
import { closedPath } from '../src/gstv/paths.js';
import { readObservations } from '../src/gstv/predicate.js';
import { clearTestStore, storeIdentitySeed } from '../src/key-store.js';
import { createGoalSeal } from '../src/gstv/store.js';
import { ensureCrypto } from '../src/crypto-utils.js';
import { SPOOL_EVENT, type SpoolEnvelope } from '../src/gstv/types.js';

const KNOWN_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SUITE_LOG_DIR = tmp('gstv-engine-logs-suite-');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function writeOrgMarker(repoRoot: string): void {
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

function opLines(logDir: string, op: string): string[] {
  const filePath = path.join(logDir, 'ops', `${op}-${utcDay()}.log`);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
}

function makeEnvelope(input: {
  seq: number;
  ts: string;
  session_id: string;
  event: SpoolEnvelope['event'];
  payload: Record<string, unknown>;
  trace_id?: string | null;
}): SpoolEnvelope {
  return {
    v: 'spool-v1',
    seq: input.seq,
    ts: input.ts,
    session_id: input.session_id,
    trace_id: input.trace_id ?? null,
    event: input.event,
    payload: input.payload,
  } as SpoolEnvelope;
}

function appendSpoolLine(spoolDir: string, envelope: SpoolEnvelope): void {
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.appendFileSync(path.join(spoolDir, 'spool-v1.jsonl'), `${JSON.stringify(envelope)}\n`, 'utf8');
}

async function makeFixture(): Promise<{
  root: string;
  spoolDir: string;
  repoRoot: string;
  goalId: string;
  goalDir: string;
  command: string;
  predicateRelPath: string;
  predicateBody: string;
}> {
  const root = tmp('gstv-engine-root-');
  const spoolDir = tmp('gstv-engine-spool-');
  const repoRoot = tmp('gstv-engine-repo-');

  writeOrgMarker(repoRoot);
  writeRepoFile(repoRoot, 'src/app.ts', 'export const x = 1;\n');

  const predicateRelPath = 'tests/predicate.test.ts';
  const predicateBody = 'expect(2 + 2).toBe(4);\n';
  writeRepoFile(repoRoot, predicateRelPath, predicateBody);

  const command = `npx vitest run ${predicateRelPath}`;
  const created = await createGoalSeal(
    {
      repo_root: repoRoot,
      goal_text: 'get predicate green',
      predicate_command: command,
      predicate_file_paths: [predicateRelPath],
    },
    { root },
  );

  return {
    root,
    spoolDir,
    repoRoot,
    goalId: created.goal_id,
    goalDir: path.join(root, 'goals', created.goal_id),
    command,
    predicateRelPath,
    predicateBody,
  };
}

describe('gstv/engine orchestrator', () => {
  beforeEach(async () => {
    process.env.WEVIBE_LOG_DIR = SUITE_LOG_DIR;
    fs.rmSync(SUITE_LOG_DIR, { recursive: true, force: true });
    fs.mkdirSync(SUITE_LOG_DIR, { recursive: true });
    clearTestStore();
    await storeIdentitySeed(Buffer.from(KNOWN_SEED_HEX, 'hex'));
    vi.restoreAllMocks();
    await ensureCrypto();
  });

  it('(a) attach match appends one attach state link and emits gstv.attach match=true', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 1000 });

    await engine.ingest(
      makeEnvelope({
        seq: 1,
        ts: '2026-07-26T10:00:00.000Z',
        session_id: 'sess-a',
        event: SPOOL_EVENT.GSTV_ATTACH_ATTEMPT,
        payload: { goal_id: f.goalId },
        trace_id: 'trace-a',
      }),
    );

    const chain = await readChain(f.goalDir);
    expect(chain).toHaveLength(1);
    expect(chain[0].cause).toBe('attach');
    expect(chain[0].kind).toBe('state');

    const attachOps = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.attach').filter((line) => line.includes(`goal_id=${f.goalId}`));
    expect(attachOps).toHaveLength(1);
    expect(attachOps[0]).toContain('match=true');
  });

  it('(b) tool link then file.edited correlation skip within 500ms, external link after 3000ms', async () => {
    const f = await makeFixture();
    let nowMs = 10_000;
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => nowMs });

    await engine.attachSession('sess-b', f.goalId);

    await engine.ingest(
      makeEnvelope({
        seq: 2,
        ts: '2026-07-26T10:10:00.000Z',
        session_id: 'sess-b',
        event: SPOOL_EVENT.TOOL_EXECUTE_AFTER,
        payload: { call_id: 'call-1', tool: 'git status', exit_code: 0 },
      }),
    );

    nowMs += 500;
    await engine.ingest(
      makeEnvelope({
        seq: 3,
        ts: '2026-07-26T10:10:00.500Z',
        session_id: 'sess-b',
        event: SPOOL_EVENT.FILE_EDITED,
        payload: { path: 'src/app.ts' },
      }),
    );

    nowMs += 3000;
    writeRepoFile(f.repoRoot, 'src/app.ts', 'export const x = 2;\n');
    await engine.ingest(
      makeEnvelope({
        seq: 4,
        ts: '2026-07-26T10:10:03.500Z',
        session_id: 'sess-b',
        event: SPOOL_EVENT.FILE_EDITED,
        payload: { path: 'src/app.ts' },
      }),
    );

    const chain = await readChain(f.goalDir);
    const causes = chain.map((item) => item.cause);
    expect(causes).toContain('call-1');
    expect(causes.filter((c) => c === 'external')).toHaveLength(1);
  });

  it('(c) uncorrelated file.watcher.updated appends watcher gap and emits BOTH chain.link(kind=gap)+gap ops', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 5000 });
    await engine.attachSession('sess-c', f.goalId);

    writeRepoFile(f.repoRoot, 'src/new.ts', 'export const y = 1;\n');
    await engine.ingest(
      makeEnvelope({
        seq: 5,
        ts: '2026-07-26T10:20:00.000Z',
        session_id: 'sess-c',
        event: SPOOL_EVENT.FILE_WATCHER_UPDATED,
        payload: { path: 'src/new.ts' },
        trace_id: 'trace-c',
      }),
    );

    const chain = await readChain(f.goalDir);
    const gap = chain.find((link) => link.kind === 'gap');
    expect(gap).toBeDefined();
    expect(gap?.detector).toBe('watcher');

    const chainOps = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.chain.link').filter((line) => line.includes('trace=trace-c'));
    const gapOps = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.gap').filter((line) => line.includes('trace=trace-c'));
    expect(chainOps.some((line) => line.includes('kind=gap'))).toBe(true);
    expect(gapOps).toHaveLength(1);
    expect(gapOps[0]).toContain('detector=watcher');
  });

  it('(d) attach mismatch emits attach match=false and gap detector=attach_mismatch', async () => {
    const f = await makeFixture();
    writeRepoFile(f.repoRoot, 'src/app.ts', 'export const x = 99;\n');

    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 0 });
    await engine.ingest(
      makeEnvelope({
        seq: 6,
        ts: '2026-07-26T10:30:00.000Z',
        session_id: 'sess-d',
        event: SPOOL_EVENT.GSTV_ATTACH_ATTEMPT,
        payload: { goal_id: f.goalId },
      }),
    );

    const chain = await readChain(f.goalDir);
    expect(chain).toHaveLength(1);
    expect(chain[0].kind).toBe('gap');
    expect(chain[0].detector).toBe('attach_mismatch');

    const attachOps = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.attach').filter((line) => line.includes(`goal_id=${f.goalId}`));
    expect(attachOps).toHaveLength(1);
    expect(attachOps[0]).toContain('match=false');
  });

  it('(e) tool.execute.after red then green (sealed command) records observations and closes with attempts_to_green=2', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 0 });
    await engine.attachSession('sess-e', f.goalId);

    await engine.ingest(
      makeEnvelope({
        seq: 7,
        ts: '2026-07-26T10:40:00.000Z',
        session_id: 'sess-e',
        event: SPOOL_EVENT.TOOL_EXECUTE_AFTER,
        payload: { call_id: 'call-red', tool: f.command, exit_code: 1 },
      }),
    );
    expect(fs.existsSync(closedPath(f.root, f.goalId))).toBe(false);

    await engine.ingest(
      makeEnvelope({
        seq: 8,
        ts: '2026-07-26T10:41:00.000Z',
        session_id: 'sess-e',
        event: SPOOL_EVENT.TOOL_EXECUTE_AFTER,
        payload: { call_id: 'call-green', tool: f.command, exit_code: 0 },
      }),
    );

    const observations = await readObservations(f.goalDir);
    expect(observations).toHaveLength(2);
    expect(fs.existsSync(closedPath(f.root, f.goalId))).toBe(true);
    const closed = JSON.parse(fs.readFileSync(closedPath(f.root, f.goalId), 'utf8')) as { attempts_to_green: number };
    expect(closed.attempts_to_green).toBe(2);

    const closeOps = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.goal.close').filter((line) => line.includes(`goal_id=${f.goalId}`));
    expect(closeOps).toHaveLength(1);
    expect(closeOps[0]).toContain('attempts_to_green=2');
  });

  it('(e2) command.executed honest absence records null exits and never closes', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 0 });
    await engine.attachSession('sess-e2', f.goalId);

    await engine.ingest(
      makeEnvelope({
        seq: 71,
        ts: '2026-07-26T10:42:00.000Z',
        session_id: 'sess-e2',
        event: SPOOL_EVENT.COMMAND_EXECUTED,
        payload: { command: f.command, args_excerpt: '--run' },
      }),
    );
    await engine.ingest(
      makeEnvelope({
        seq: 72,
        ts: '2026-07-26T10:42:01.000Z',
        session_id: 'sess-e2',
        event: SPOOL_EVENT.COMMAND_EXECUTED,
        payload: { command: f.command, args_excerpt: '--run' },
      }),
    );

    const observations = await readObservations(f.goalDir);
    expect(observations).toHaveLength(2);
    observations.forEach((observation) => {
      expect(observation.exit).toBeNull();
    });
    expect(fs.existsSync(closedPath(f.root, f.goalId))).toBe(false);

    const closeOps = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.goal.close').filter((line) => line.includes(`goal_id=${f.goalId}`));
    expect(closeOps).toHaveLength(0);
  });

  it('(f) gstv.boundary.run appends boundary cause link and boundary-source observation', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 0 });

    await engine.ingest(
      makeEnvelope({
        seq: 9,
        ts: '2026-07-26T10:50:00.000Z',
        session_id: 'sess-f',
        event: SPOOL_EVENT.GSTV_BOUNDARY_RUN,
        payload: { goal_id: f.goalId, command: 'echo non-sealed-command', exit_code: 0, duration_ms: 123 },
      }),
    );

    const chain = await readChain(f.goalDir);
    expect(chain.some((link) => link.cause === 'boundary')).toBe(true);
    const observations = await readObservations(f.goalDir);
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe('boundary');
    expect(observations[0].command).toBe('echo non-sealed-command');
  });

  it('(g) two sessions attaching same goal keep one continuous chain and close stats include both sessions', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 0 });

    await engine.attachSession('sess-g1', f.goalId);
    await engine.attachSession('sess-g2', f.goalId);

    await engine.ingest(
      makeEnvelope({
        seq: 10,
        ts: '2026-07-26T11:00:00.000Z',
        session_id: 'sess-g2',
        event: SPOOL_EVENT.GSTV_BOUNDARY_RUN,
        payload: { goal_id: f.goalId, command: f.command, exit_code: 0, duration_ms: 5 },
      }),
    );

    const chain = await readChain(f.goalDir);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    chain.forEach((link, index) => {
      expect(link.index).toBe(index);
    });

    const closed = JSON.parse(fs.readFileSync(closedPath(f.root, f.goalId), 'utf8')) as { sessions: number };
    expect(closed.sessions).toBe(2);
  });

  it('(h) end-to-end via real SpoolConsumer pollOnce: attach -> tool -> boundary green materializes chain+observation+close', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 100 });

    appendSpoolLine(
      f.spoolDir,
      makeEnvelope({
        seq: 0,
        ts: '2026-07-26T11:10:00.000Z',
        session_id: 'sess-h',
        event: SPOOL_EVENT.GSTV_ATTACH_ATTEMPT,
        payload: { goal_id: f.goalId },
      }),
    );
    await engine.pollOnce();

    appendSpoolLine(
      f.spoolDir,
      makeEnvelope({
        seq: 1,
        ts: '2026-07-26T11:10:02.000Z',
        session_id: 'sess-h',
        event: SPOOL_EVENT.TOOL_EXECUTE_AFTER,
        payload: { call_id: 'call-h', tool: 'git status', exit_code: 0 },
      }),
    );
    await engine.pollOnce();

    appendSpoolLine(
      f.spoolDir,
      makeEnvelope({
        seq: 2,
        ts: '2026-07-26T11:10:03.000Z',
        session_id: 'sess-h',
        event: SPOOL_EVENT.GSTV_BOUNDARY_RUN,
        payload: { goal_id: f.goalId, command: f.command, exit_code: 0, duration_ms: 5 },
      }),
    );
    await engine.pollOnce();

    const chain = await readChain(f.goalDir);
    const observations = await readObservations(f.goalDir);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(observations.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(closedPath(f.root, f.goalId))).toBe(true);
  });

  it('(i) internal handler throw logs gstv.engine error and subsequent events still process', async () => {
    const f = await makeFixture();
    const engine = new GstvEngine({ root: f.root, spoolDirs: [f.spoolDir], now: () => 100_000 });
    await engine.attachSession('sess-i', f.goalId);

    fs.rmSync(f.repoRoot, { recursive: true, force: true });
    await engine.ingest(
      makeEnvelope({
        seq: 11,
        ts: '2026-07-26T11:20:00.000Z',
        session_id: 'sess-i',
        event: SPOOL_EVENT.TOOL_EXECUTE_AFTER,
        payload: { call_id: 'will-throw', tool: 'git status', exit_code: 0 },
        trace_id: 'trace-i',
      }),
    );

    writeOrgMarker(f.repoRoot);
    writeRepoFile(f.repoRoot, 'src/app.ts', 'export const x = 1;\n');
    writeRepoFile(f.repoRoot, f.predicateRelPath, f.predicateBody);

    await engine.ingest(
      makeEnvelope({
        seq: 12,
        ts: '2026-07-26T11:20:05.000Z',
        session_id: 'sess-i',
        event: SPOOL_EVENT.FILE_EDITED,
        payload: { path: 'src/app.ts' },
        trace_id: 'trace-i-next',
      }),
    );

    const errOps = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.engine').filter((line) => line.includes('trace=trace-i'));
    expect(errOps.some((line) => line.includes('event=tool.execute.after'))).toBe(true);

    const chain = await readChain(f.goalDir);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain.some((link) => link.cause === 'external')).toBe(true);
  });
});
