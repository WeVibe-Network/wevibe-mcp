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

describe('gstv extended ops emitters', () => {
  let prevLogDir: string | undefined;
  let logDir: string;

  beforeEach(() => {
    prevLogDir = process.env.WEVIBE_LOG_DIR;
    logDir = mkdtempSync(path.join(os.tmpdir(), 'gstv-ops-extended-test-'));
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

  it('exports exact new OP constants', async () => {
    const { OP } = await import('../src/gstv/types.js');

    expect(OP.EPISODE_OPEN).toBe('episode.open');
    expect(OP.EPISODE_CLOSE).toBe('episode.close');
    expect(OP.EXTRACTION_UNLOCK).toBe('gstv.extraction.unlock');
    expect(OP.PREDICATE_RECEIPT).toBe('predicate.receipt');
    expect(OP.NEGATIVE_RECEIPT).toBe('negative.receipt');
    expect(OP.RUN_SUMMARY).toBe('gstv.run_summary');
  });

  it('emitEpisodeOpen writes exact catalog fields', async () => {
    const { emitEpisodeOpen } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    emitEpisodeOpen({
      trace: 'trace-episode-open',
      session_id: 'session-episode-open',
      episode_id: 'episode-001',
      signal_key: 'signal-key-episode-open',
      signal_key_mode: 'parsed',
      source: 'tool_error',
      status: 'ok',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.EPISODE_OPEN);
    expect(line).toContain('op=episode.open');
    expect(line).toContain('trace=trace-episode-open');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace',
      'session_id',
      'episode_id',
      'signal_key',
      'signal_key_mode',
      'source',
      'status',
    ]);
    expect(line).not.toContain('err=');
  });

  it('emitEpisodeClose writes exact catalog fields and fingerprints attempt_diff_fp', async () => {
    const { emitEpisodeClose } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const secret = 'super_secret_attempt_diff_material_that_must_not_log_raw_1234567890';
    emitEpisodeClose({
      trace: 'trace-episode-close',
      session_id: 'session-episode-close',
      episode_id: 'episode-002',
      signal_key: 'signal-key-episode-close',
      outcome: 'resolved',
      attempt_diff_fp: secret,
      edits: 5,
      coincidental_flip: false,
      status: 'ok',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.EPISODE_CLOSE);
    expect(line).toContain('op=episode.close');
    expect(line).toContain('trace=trace-episode-close');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace',
      'session_id',
      'episode_id',
      'signal_key',
      'outcome',
      'attempt_diff_fp',
      'edits',
      'coincidental_flip',
      'status',
    ]);
    expectFp8OrDash(line, ['attempt_diff_fp']);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('err=');
  });

  it('emitGstvExtractionUnlock writes exact catalog fields and fingerprints unlock_fp', async () => {
    const { emitGstvExtractionUnlock } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const secret = 'super_secret_unlock_material_that_must_not_log_raw_abcdefghij';
    emitGstvExtractionUnlock({
      trace: 'trace-extraction-unlock',
      session_id: 'session-extraction-unlock',
      goal_id: 'gstv-goal-unlock',
      links: 12,
      gaps: 2,
      episodes: 4,
      receipts_predicate: 3,
      receipts_negative: 1,
      attempts_to_green: 7,
      sessions: 2,
      red_boundaries: 3,
      unlock_fp: secret,
      status: 'ok',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.EXTRACTION_UNLOCK);
    expect(line).toContain('op=gstv.extraction.unlock');
    expect(line).toContain('trace=trace-extraction-unlock');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace',
      'session_id',
      'goal_id',
      'links',
      'gaps',
      'episodes',
      'receipts_predicate',
      'receipts_negative',
      'attempts_to_green',
      'sessions',
      'red_boundaries',
      'unlock_fp',
      'status',
    ]);
    expectFp8OrDash(line, ['unlock_fp']);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('err=');
  });

  it('emitPredicateReceipt writes exact catalog fields and fingerprints all fp fields', async () => {
    const { emitPredicateReceipt } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const envSecret = 'very_long_env_secret_value_that_should_never_appear_in_ops_logs_111111';
    const chainHeadSecret = 'very_long_chain_head_secret_value_that_should_never_appear_222222';
    const receiptSecret = 'very_long_receipt_secret_value_that_should_never_appear_333333';
    const sigSecret = 'very_long_signature_secret_value_that_should_never_appear_444444';
    emitPredicateReceipt({
      trace: 'trace-predicate-receipt',
      session_id: 'session-predicate-receipt',
      goal_id: 'gstv-goal-predicate-receipt',
      exit: 1,
      env_fp: envSecret,
      chain_head_fp: chainHeadSecret,
      receipt_fp: receiptSecret,
      sig_fp: sigSecret,
      status: 'error',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.PREDICATE_RECEIPT);
    expect(line).toContain('op=predicate.receipt');
    expect(line).toContain('trace=trace-predicate-receipt');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace',
      'session_id',
      'goal_id',
      'exit',
      'env_fp',
      'chain_head_fp',
      'receipt_fp',
      'sig_fp',
      'status',
    ]);
    expectFp8OrDash(line, ['env_fp', 'chain_head_fp', 'receipt_fp', 'sig_fp']);
    expect(line).not.toContain(envSecret);
    expect(line).not.toContain(chainHeadSecret);
    expect(line).not.toContain(receiptSecret);
    expect(line).not.toContain(sigSecret);
    expect(line).not.toContain('err=');
  });

  it('emitNegativeReceipt writes exact catalog fields and fingerprints all fp fields', async () => {
    const { emitNegativeReceipt } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    const citedStateSecret = 'very_long_cited_state_secret_value_that_should_never_appear_555555';
    const receiptSecret = 'very_long_negative_receipt_secret_value_that_should_never_appear_666666';
    const sigSecret = 'very_long_negative_signature_secret_value_that_should_never_appear_777777';
    emitNegativeReceipt({
      trace: 'trace-negative-receipt',
      session_id: 'session-negative-receipt',
      goal_id: 'gstv-goal-negative-receipt',
      cited_state_fp: citedStateSecret,
      receipt_fp: receiptSecret,
      sig_fp: sigSecret,
      status: 'ok',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.NEGATIVE_RECEIPT);
    expect(line).toContain('op=negative.receipt');
    expect(line).toContain('trace=trace-negative-receipt');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace',
      'session_id',
      'goal_id',
      'cited_state_fp',
      'receipt_fp',
      'sig_fp',
      'status',
    ]);
    expectFp8OrDash(line, ['cited_state_fp', 'receipt_fp', 'sig_fp']);
    expect(line).not.toContain(citedStateSecret);
    expect(line).not.toContain(receiptSecret);
    expect(line).not.toContain(sigSecret);
    expect(line).not.toContain('err=');
  });

  it('emitGstvRunSummary writes exact catalog fields', async () => {
    const { emitGstvRunSummary } = await import('../src/gstv/ops.js');
    const { OP } = await import('../src/gstv/types.js');

    emitGstvRunSummary({
      trace: 'trace-run-summary',
      run_id: 'run-20260726-a',
      goals: 8,
      episodes_open: 5,
      episodes_closed: 5,
      coincidental: 1,
      receipts_predicate: 4,
      receipts_negative: 2,
      unattributed_vector_only: 1,
      signal_key_mode: 'mixed',
      status: 'ok',
      err: 'ignored-by-catalog',
    });

    const line = readOpLine(logDir, OP.RUN_SUMMARY);
    expect(line).toContain('op=gstv.run_summary');
    expect(line).toContain('trace=trace-run-summary');
    expect(line).toContain(' INFO ');
    expectCatalogFields(line, [
      'trace',
      'run_id',
      'goals',
      'episodes_open',
      'episodes_closed',
      'coincidental',
      'receipts_predicate',
      'receipts_negative',
      'unattributed_vector_only',
      'signal_key_mode',
      'status',
    ]);
    expect(line).not.toContain('err=');
  });
});
