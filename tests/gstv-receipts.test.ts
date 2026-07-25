process.env.WEVIBE_KEYSTORE_TEST = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { ensureCrypto } from '../src/crypto-utils.js';
import {
  computeTierLabel,
  verifyReceiptSignature,
  writeNegativeReceipt,
  writePredicateReceipt,
} from '../src/gstv/receipts.js';
import { OP } from '../src/gstv/types.js';
import { clearTestStore, storeIdentitySeed } from '../src/key-store.js';

const KNOWN_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SUITE_LOG_DIR = tmp('gstv-receipts-logs-');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function readLatestOpLine(logDir: string, op: string): string {
  const logFile = path.join(logDir, 'ops', `${op}-${utcDay()}.log`);
  const content = fs.readFileSync(logFile, 'utf8').trim();
  const lines = content.split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

describe('gstv/receipts', () => {
  let prevLogDir: string | undefined;

  beforeEach(async () => {
    clearTestStore();
    await storeIdentitySeed(Buffer.from(KNOWN_SEED_HEX, 'hex'));
    await ensureCrypto();

    prevLogDir = process.env.WEVIBE_LOG_DIR;
    process.env.WEVIBE_LOG_DIR = SUITE_LOG_DIR;
  });

  afterEach(() => {
    if (prevLogDir === undefined) {
      delete process.env.WEVIBE_LOG_DIR;
    } else {
      process.env.WEVIBE_LOG_DIR = prevLogDir;
    }
  });

  it('writes predicate receipt (0600), signs/verifies, and logs only fp8 material', async () => {
    const goalDirPath = tmp('gstv-receipts-goal-');
    const chainHead = 'a'.repeat(64);
    const predicateHash = 'b'.repeat(64);
    const stateHash = 'c'.repeat(64);

    const result = await writePredicateReceipt(
      goalDirPath,
      {
        goal_id: 'gstv-goal-1',
        exit: 0,
        chain_head: chainHead,
        predicate_hash: predicateHash,
        state_hash: stateHash,
        attempts_to_green: 2,
      },
      { trace: 'trace-receipt-1', session_id: 'session-receipt-1' },
    );

    expect(result.receipt_id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifact.v).toBe('gstv-receipt-v1');
    expect(result.artifact.kind).toBe('predicate');
    expect(result.artifact.bench_mock).toBe(true);
    expect(verifyReceiptSignature(result.artifact)).toBe(true);

    const filePath = path.join(goalDirPath, 'receipts', `${result.receipt_id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      v: string;
      kind: string;
      bench_mock: boolean;
    };
    expect(onDisk.v).toBe('gstv-receipt-v1');
    expect(onDisk.kind).toBe('predicate');
    expect(onDisk.bench_mock).toBe(true);

    const line = readLatestOpLine(process.env.WEVIBE_LOG_DIR!, OP.PREDICATE_RECEIPT);
    expect(line).toContain('op=predicate.receipt');
    expect(line).toContain('status=ok');
    expect(line).toMatch(/\benv_fp=[0-9a-f]{8}(\b|$)/);
    expect(line).toMatch(/\bchain_head_fp=[0-9a-f]{8}(\b|$)/);
    expect(line).toMatch(/\breceipt_fp=[0-9a-f]{8}(\b|$)/);
    expect(line).toMatch(/\bsig_fp=[0-9a-f]{8}(\b|$)/);
    expect(line).not.toContain(chainHead);
    expect(line).not.toContain(predicateHash);
    expect(line).not.toContain(stateHash);
    expect(line).not.toMatch(/[0-9a-f]{64}/);
  });

  it('verifyReceiptSignature fails when artifact is tampered', async () => {
    const goalDirPath = tmp('gstv-receipts-tamper-');
    const result = await writePredicateReceipt(
      goalDirPath,
      {
        goal_id: 'gstv-goal-2',
        exit: 1,
        chain_head: '1'.repeat(64),
        predicate_hash: '2'.repeat(64),
        state_hash: '3'.repeat(64),
        attempts_to_green: 5,
      },
      { trace: 'trace-receipt-2', session_id: 'session-receipt-2' },
    );

    const tampered = { ...result.artifact, state_hash: 'f'.repeat(64) };
    expect(verifyReceiptSignature(tampered)).toBe(false);
  });

  it('writes negative receipt with weak-semantics fields verbatim', async () => {
    const goalDirPath = tmp('gstv-negative-receipt-');
    const result = await writeNegativeReceipt(
      goalDirPath,
      {
        goal_id: 'gstv-goal-3',
        cited_state_hash: 'd'.repeat(64),
        cited_episode_id: null,
      },
      { trace: 'trace-receipt-3', session_id: 'session-receipt-3' },
    );

    expect(result.receipt_id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifact.v).toBe('gstv-receipt-v1');
    expect(result.artifact.kind).toBe('negative');
    expect(result.artifact.absent_from_final).toBe(true);
    expect(result.artifact.basis).toBe('cited_files_absent_from_closing_manifest');
    expect(result.artifact.semantics).toBe('not_sufficient_as_tried_then');
    expect(result.artifact.bench_mock).toBe(true);
    expect(verifyReceiptSignature(result.artifact)).toBe(true);
  });

  it('computeTierLabel maps true->T1 and false->T0', () => {
    expect(computeTierLabel(true)).toBe('T1');
    expect(computeTierLabel(false)).toBe('T0');
  });

  it('error path emits status=error then throws', async () => {
    const goalDirPath = tmp('gstv-receipt-error-');
    clearTestStore();

    await expect(
      writePredicateReceipt(
        goalDirPath,
        {
          goal_id: 'gstv-goal-err',
          exit: 2,
          chain_head: 'e'.repeat(64),
          predicate_hash: 'f'.repeat(64),
          state_hash: '0'.repeat(64),
          attempts_to_green: 1,
        },
        { trace: 'trace-receipt-err', session_id: 'session-receipt-err' },
      ),
    ).rejects.toThrow();

    const line = readLatestOpLine(process.env.WEVIBE_LOG_DIR!, OP.PREDICATE_RECEIPT);
    expect(line).toContain('op=predicate.receipt');
    expect(line).toContain('status=error');
  });
});
