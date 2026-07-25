import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendLink } from '../src/gstv/chain.js';
import { observationsPath } from '../src/gstv/paths.js';
import { sha256Hex, type GoalMeta, type GoalSeal, type PredicateObservation } from '../src/gstv/types.js';

const UTC_DAY = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function opLines(logDir: string, op: string): string[] {
  const filePath = path.join(logDir, 'ops', `${op}-${UTC_DAY()}.log`);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
}

function fixture(goalId = 'gstv-goal-predicate'): {
  root: string;
  repoRoot: string;
  goalId: string;
  goalDir: string;
  seal: GoalSeal;
  meta: GoalMeta;
  goal: { goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string };
} {
  const root = tmp('gstv-predicate-root-');
  const repoRoot = tmp('gstv-predicate-repo-');
  const goalDir = path.join(root, 'goals', goalId);
  fs.mkdirSync(goalDir, { recursive: true });

  const fileA = { rel: 'tests/predicate.test.ts', body: 'expect(1 + 1).toBe(2);\n' };
  const fileB = { rel: 'src/lib.ts', body: 'export const x = 1;\n' };
  for (const file of [fileA, fileB]) {
    const abs = path.join(repoRoot, file.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.body, 'utf8');
  }

  const seal: GoalSeal = {
    goal_id: goalId,
    goal_text_hash: 'a'.repeat(64),
    predicate_hash: 'b'.repeat(64),
    state0_hash: 'c'.repeat(64),
    repo_binding: 'org:fp',
    sealed_at: '2026-07-26T12:00:00.000Z',
    contributor_sig: 'd'.repeat(128),
    chain_anchor: null,
    state_alg: 'walk-v1',
  };
  const meta: GoalMeta = {
    repo_root: repoRoot,
    predicate_command: 'npx vitest run tests/predicate.test.ts',
    predicate_file_paths: [
      { path: fileA.rel, sha256: sha256Hex(Buffer.from(fileA.body, 'utf8')) },
      { path: fileB.rel, sha256: sha256Hex(Buffer.from(fileB.body, 'utf8')) },
    ],
    state_alg: 'walk-v1',
    goal_text_fp: 'deadbeef',
  };

  fs.writeFileSync(path.join(goalDir, 'seal.json'), `${JSON.stringify(seal, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(goalDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  return { root, repoRoot, goalId, goalDir, seal, meta, goal: { goal_id: goalId, seal, meta, dir: goalDir } };
}

function appendObs(goalDir: string, obs: PredicateObservation): void {
  fs.appendFileSync(path.join(goalDir, 'observations.jsonl'), `${JSON.stringify(obs)}\n`, 'utf8');
}

describe('gstv/predicate matcher observer closer', () => {
  let prevLogDir: string | undefined;

  beforeEach(() => {
    prevLogDir = process.env.WEVIBE_LOG_DIR;
    process.env.WEVIBE_LOG_DIR = tmp('gstv-predicate-logs-');
    vi.resetModules();
  });

  afterEach(() => {
    if (prevLogDir === undefined) {
      delete process.env.WEVIBE_LOG_DIR;
    } else {
      process.env.WEVIBE_LOG_DIR = prevLogDir;
    }
    vi.resetModules();
  });

  it('matchesSealedCommand trims only boundaries (internal bytes exact)', async () => {
    const { matchesSealedCommand } = await import('../src/gstv/predicate.js');
    expect(matchesSealedCommand('npm test', 'npm test')).toBe(true);
    expect(matchesSealedCommand('npm test', '  npm test  ')).toBe(true);
    expect(matchesSealedCommand('npm  test', 'npm test')).toBe(false);
    expect(matchesSealedCommand('npm test -- --runInBand', 'npm test --runInBand')).toBe(false);
    expect(matchesSealedCommand('A', 'a')).toBe(false);
  });

  it('green tool observation closes and writes close op attempts_to_green=1', async () => {
    const { observePredicate, readObservations } = await import('../src/gstv/predicate.js');
    const f = fixture();
    const out = await observePredicate(
      f.goal,
      { source: 'tool', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:01:00.000Z', session_id: 's1', trace: 't1' },
      { root: f.root },
    );
    expect(out.closed).toBe(true);
    expect(out.alreadyClosed).toBe(false);
    expect(out.observation.testfile_match).toBe(true);
    expect(await readObservations(f.goalDir)).toHaveLength(1);
    expect(fs.existsSync(path.join(f.goalDir, 'closed.json'))).toBe(true);
    const close = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.goal.close');
    expect(close).toHaveLength(1);
    expect(close[0]).toContain('attempts_to_green=1');
  });

  it('red observation does not close', async () => {
    const { observePredicate } = await import('../src/gstv/predicate.js');
    const f = fixture();
    const out = await observePredicate(
      f.goal,
      { source: 'command', command: f.meta.predicate_command, exit: 1, ts: '2026-07-26T12:02:00.000Z', session_id: 's1', trace: 't2' },
      { root: f.root },
    );
    expect(out.closed).toBe(false);
    expect(fs.existsSync(path.join(f.goalDir, 'closed.json'))).toBe(false);
    expect(opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.goal.close')).toHaveLength(0);
  });

  it('drifted green does not close; restore then closes; attempts include drifted', async () => {
    const { observePredicate } = await import('../src/gstv/predicate.js');
    const f = fixture();
    const target = path.join(f.repoRoot, 'tests/predicate.test.ts');
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, 'expect(false).toBe(false);\n', 'utf8');

    const drift = await observePredicate(
      f.goal,
      { source: 'command', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:03:00.000Z', session_id: 's1', trace: 't3' },
      { root: f.root },
    );
    expect(drift.closed).toBe(false);
    expect(drift.observation.testfile_match).toBe(false);
    const observe = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.predicate.observe');
    expect(observe[observe.length - 1]).toContain(' WARN ');

    fs.writeFileSync(target, original, 'utf8');
    const restored = await observePredicate(
      f.goal,
      { source: 'command', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:04:00.000Z', session_id: 's1', trace: 't4' },
      { root: f.root },
    );
    expect(restored.closed).toBe(true);
    const closed = JSON.parse(fs.readFileSync(path.join(f.goalDir, 'closed.json'), 'utf8')) as { attempts_to_green: number };
    expect(closed.attempts_to_green).toBe(2);
  });

  it('missing predicate file yields testfile_match=false and never closes', async () => {
    const { observePredicate } = await import('../src/gstv/predicate.js');
    const f = fixture();
    fs.unlinkSync(path.join(f.repoRoot, 'tests/predicate.test.ts'));
    const out = await observePredicate(
      f.goal,
      { source: 'tool', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:05:00.000Z', session_id: 's1', trace: 't5' },
      { root: f.root },
    );
    expect(out.observation.testfile_match).toBe(false);
    expect(out.closed).toBe(false);
  });

  it('idempotent close: second green only records observation, no second goal.close, closed.json unchanged', async () => {
    const { observePredicate, readObservations } = await import('../src/gstv/predicate.js');
    const f = fixture();
    const first = await observePredicate(
      f.goal,
      { source: 'command', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:06:00.000Z', session_id: 's1', trace: 't6' },
      { root: f.root },
    );
    expect(first.closed).toBe(true);
    const closedFile = path.join(f.goalDir, 'closed.json');
    const before = fs.readFileSync(closedFile);

    const second = await observePredicate(
      f.goal,
      { source: 'command', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:07:00.000Z', session_id: 's2', trace: 't7' },
      { root: f.root },
    );
    expect(second.closed).toBe(false);
    expect(second.alreadyClosed).toBe(true);
    expect(Buffer.compare(before, fs.readFileSync(closedFile))).toBe(0);
    expect(opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.goal.close')).toHaveLength(1);
    expect(await readObservations(f.goalDir)).toHaveLength(2);
  });

  it('boundary red contributes red_boundaries to close record', async () => {
    const { observePredicate } = await import('../src/gstv/predicate.js');
    const f = fixture();
    await observePredicate(
      f.goal,
      { source: 'boundary', command: f.meta.predicate_command, exit: 2, ts: '2026-07-26T12:08:00.000Z', session_id: 's1', trace: 't8' },
      { root: f.root },
    );
    await observePredicate(
      f.goal,
      { source: 'tool', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:09:00.000Z', session_id: 's1', trace: 't9' },
      { root: f.root },
    );
    const closed = JSON.parse(fs.readFileSync(path.join(f.goalDir, 'closed.json'), 'utf8')) as { red_boundaries: number };
    expect(closed.red_boundaries).toBe(1);
  });

  it('close stats sessions/links/gaps come from chain', async () => {
    const { observePredicate } = await import('../src/gstv/predicate.js');
    const f = fixture();
    await appendLink(f.goalDir, f.seal, { ts: '2026-07-26T12:10:00.000Z', session_id: 'sa', cause: 'tool.1', kind: 'state', state_hash: '1'.repeat(64), diff_hash: '2'.repeat(64) });
    await appendLink(f.goalDir, f.seal, { ts: '2026-07-26T12:10:05.000Z', session_id: 'sb', cause: 'attach', kind: 'gap', detector: 'watcher', state_hash: '3'.repeat(64), diff_hash: '4'.repeat(64) });
    await appendLink(f.goalDir, f.seal, { ts: '2026-07-26T12:10:10.000Z', session_id: 'sa', cause: 'tool.2', kind: 'state', state_hash: '5'.repeat(64), diff_hash: '6'.repeat(64) });
    await observePredicate(
      f.goal,
      { source: 'command', command: f.meta.predicate_command, exit: 0, ts: '2026-07-26T12:11:00.000Z', session_id: 'sb', trace: 't10' },
      { root: f.root },
    );
    const closed = JSON.parse(fs.readFileSync(path.join(f.goalDir, 'closed.json'), 'utf8')) as { sessions: number; links: number; gaps: number };
    expect(closed.sessions).toBe(2);
    expect(closed.links).toBe(3);
    expect(closed.gaps).toBe(1);
  });

  it('boundaryStampDecision: no obs, current observation, state changed after obs, equal timestamp needs run', async () => {
    const { boundaryStampDecision } = await import('../src/gstv/predicate.js');

    const a = fixture('gstv-no-observations');
    expect(await boundaryStampDecision(a.goalDir)).toEqual({ needs_boundary_run: true, boundary_reason: 'no_observations' });

    const b = fixture('gstv-observation-current');
    await appendLink(b.goalDir, b.seal, { ts: '2026-07-26T13:00:00.000Z', session_id: 's1', cause: 'tool.1', kind: 'state', state_hash: '7'.repeat(64), diff_hash: '8'.repeat(64) });
    appendObs(b.goalDir, { goal_id: b.goalId, ts: '2026-07-26T13:00:10.000Z', session_id: 's1', source: 'boundary', command: b.meta.predicate_command, exit: 0, state_fp: '11111111', env_fp: '22222222', testfile_match: true });
    expect(await boundaryStampDecision(b.goalDir)).toEqual({ needs_boundary_run: false, boundary_reason: 'observation_current' });
    await appendLink(b.goalDir, b.seal, { ts: '2026-07-26T13:00:20.000Z', session_id: 's1', cause: 'tool.2', kind: 'state', state_hash: '9'.repeat(64), diff_hash: 'a'.repeat(64) });
    expect(await boundaryStampDecision(b.goalDir)).toEqual({ needs_boundary_run: true, boundary_reason: 'state_changed_since_last_observation' });

    const c = fixture('gstv-equal-ts');
    await appendLink(c.goalDir, c.seal, { ts: '2026-07-26T14:00:00.000Z', session_id: 's1', cause: 'tool.1', kind: 'state', state_hash: 'b'.repeat(64), diff_hash: 'c'.repeat(64) });
    appendObs(c.goalDir, { goal_id: c.goalId, ts: '2026-07-26T14:00:00.000Z', session_id: 's1', source: 'boundary', command: c.meta.predicate_command, exit: 0, state_fp: '33333333', env_fp: '44444444', testfile_match: true });
    expect(await boundaryStampDecision(c.goalDir)).toEqual({ needs_boundary_run: true, boundary_reason: 'state_changed_since_last_observation' });
  });

  it('readObservations parses jsonl and throws observations_corrupt on bad line', async () => {
    const { readObservations } = await import('../src/gstv/predicate.js');
    const f = fixture('gstv-observation-corrupt');
    const p = observationsPath(f.root, f.goalId);
    fs.writeFileSync(
      p,
      `${JSON.stringify({ goal_id: f.goalId, ts: '2026-07-26T15:00:00.000Z', session_id: 's1', source: 'tool', command: f.meta.predicate_command, exit: 0, state_fp: 'aaaaaaaa', env_fp: 'bbbbbbbb', testfile_match: true })}\n{not-json}\n`,
      'utf8',
    );
    await expect(readObservations(f.goalDir)).rejects.toThrowError('observations_corrupt');
  });
});
