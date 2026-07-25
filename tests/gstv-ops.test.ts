import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UTC_DAY = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

function readOpLine(logDir: string, op: string): string {
  const filePath = path.join(logDir, 'ops', `${op}-${UTC_DAY()}.log`);
  const content = readFileSync(filePath, 'utf8').trim();
  const lines = content.split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function expectCatalogFields(line: string, keys: string[]): void {
  for (const key of keys) {
    expect(line).toContain(`${key}=`);
  }
}

function expectFp8OrDash(line: string, keys: string[]): void {
  for (const key of keys) {
    expect(line).toMatch(new RegExp(`\\b${key}=([0-9a-f]{8}|-)(\\b|$)`));
  }
}

describe('gstv ops emitters', () => {
  let prevLogDir: string | undefined;
  let logDir: string;

  beforeEach(() => {
    prevLogDir = process.env.WEVIBE_LOG_DIR;
    logDir = mkdtempSync(path.join(os.tmpdir(), 'gstv-ops-test-'));
    process.env.WEVIBE_LOG_DIR = logDir;
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

  it('emitGstvSeal writes exact catalog fields with fingerprint-only values', async () => {
    const { emitGstvSeal } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const secret = 'sk_live_SUPER_SECRET_123';
    emitGstvSeal({
      trace: 'trace-seal',
      session_id: 'session-a',
      goal_id: 'gstv-goal-a',
      goal_text_fp: secret,
      predicate_fp: secret,
      state0_fp: secret,
      repo_fp: secret,
      seal_fp: secret,
      ed_pub_fp: secret,
      sig_fp: secret,
      status: 'ok',
      dur_ms: 42,
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.SEAL);
    expect(line).toContain('op=gstv.seal');
    expect(line).toContain('trace=trace-seal');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace', 'session_id', 'goal_id', 'goal_text_fp', 'predicate_fp', 'state0_fp',
      'repo_fp', 'seal_fp', 'ed_pub_fp', 'sig_fp', 'status', 'dur_ms',
    ]);
    expectFp8OrDash(line, [
      'goal_text_fp', 'predicate_fp', 'state0_fp', 'repo_fp', 'seal_fp', 'ed_pub_fp', 'sig_fp',
    ]);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('err=');
  });

  it('emitGstvAttach warns on mismatch and includes exact catalog fields', async () => {
    const { emitGstvAttach } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const secret = 'api_key_DO_NOT_LOG_456';
    emitGstvAttach({
      trace: 'trace-attach',
      session_id: 'session-b',
      goal_id: 'gstv-goal-b',
      match: false,
      head_fp: secret,
      state_fp: secret,
      status: 'err',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.ATTACH);
    expect(line).toContain('op=gstv.attach');
    expect(line).toContain('trace=trace-attach');
    expect(line).toContain(' WARN ');
    expectCatalogFields(line, ['trace', 'session_id', 'goal_id', 'match', 'head_fp', 'state_fp', 'status']);
    expectFp8OrDash(line, ['head_fp', 'state_fp']);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('err=');
  });

  it('emitGstvChainLink writes exact catalog fields and warns for gap kind', async () => {
    const { emitGstvChainLink } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const secret = 'bearer_secret_token_789';
    emitGstvChainLink({
      trace: 'trace-link',
      session_id: 'session-c',
      goal_id: 'gstv-goal-c',
      index: 3,
      kind: 'gap',
      cause: 'watcher-missed-event',
      state_fp: secret,
      diff_fp: secret,
      link_fp: secret,
      prev_fp: secret,
      status: 'ok',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.CHAIN_LINK);
    expect(line).toContain('op=gstv.chain.link');
    expect(line).toContain('trace=trace-link');
    expect(line).toContain(' WARN ');
    expectCatalogFields(line, [
      'trace', 'session_id', 'goal_id', 'index', 'kind', 'cause',
      'state_fp', 'diff_fp', 'link_fp', 'prev_fp', 'status',
    ]);
    expectFp8OrDash(line, ['state_fp', 'diff_fp', 'link_fp', 'prev_fp']);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('err=');
  });

  it('emitGstvGap always warns and writes exact catalog fields', async () => {
    const { emitGstvGap } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const secret = 'private_material_should_not_leak';
    emitGstvGap({
      trace: 'trace-gap',
      session_id: 'session-d',
      goal_id: 'gstv-goal-d',
      detector: 'attach_mismatch',
      path: '/tmp/workspace/file.ts',
      index: 4,
      link_fp: secret,
      status: 'err',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.GAP);
    expect(line).toContain('op=gstv.gap');
    expect(line).toContain('trace=trace-gap');
    expect(line).toContain(' WARN ');
    expectCatalogFields(line, ['trace', 'session_id', 'goal_id', 'detector', 'path', 'index', 'link_fp', 'status']);
    expectFp8OrDash(line, ['link_fp']);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('err=');
  });

  it('emitGstvPredicateObserve warns for drifted observation and writes exact fields', async () => {
    const { emitGstvPredicateObserve } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const secret = '-----BEGIN PRIVATE KEY-----';
    emitGstvPredicateObserve({
      trace: 'trace-predicate',
      session_id: 'session-e',
      goal_id: 'gstv-goal-e',
      source: 'boundary',
      exit: 1,
      state_fp: secret,
      env_fp: secret,
      testfile_match: false,
      status: 'ok',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.PREDICATE_OBSERVE);
    expect(line).toContain('op=gstv.predicate.observe');
    expect(line).toContain('trace=trace-predicate');
    expect(line).toContain(' WARN ');
    expectCatalogFields(line, [
      'trace', 'session_id', 'goal_id', 'source', 'exit', 'state_fp', 'env_fp', 'testfile_match', 'status',
    ]);
    expectFp8OrDash(line, ['state_fp', 'env_fp']);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('err=');
  });

  it('emitGstvGoalClose logs aggregate close counters with exact catalog fields', async () => {
    const { emitGstvGoalClose } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    emitGstvGoalClose({
      trace: 'trace-close',
      session_id: 'session-f',
      goal_id: 'gstv-goal-f',
      attempts_to_green: 7,
      sessions: 2,
      links: 11,
      gaps: 1,
      red_boundaries: 3,
      status: 'ok',
      dur_ms: 250,
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.GOAL_CLOSE);
    expect(line).toContain('op=gstv.goal.close');
    expect(line).toContain('trace=trace-close');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace', 'session_id', 'goal_id', 'attempts_to_green',
      'sessions', 'links', 'gaps', 'red_boundaries', 'status', 'dur_ms',
    ]);
    expect(line).toContain('attempts_to_green=7');
    expect(line).toContain('sessions=2');
    expect(line).toContain('links=11');
    expect(line).toContain('gaps=1');
    expect(line).toContain('red_boundaries=3');
    expect(line).not.toContain('err=');
  });
});
