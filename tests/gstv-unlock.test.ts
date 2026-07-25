process.env.WEVIBE_KEYSTORE_TEST = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureCrypto } from '../src/crypto-utils.js';
import { appendLink } from '../src/gstv/chain.js';
import { verifyReceiptSignature } from '../src/gstv/receipts.js';
import { sha256Hex, type GoalMeta, type GoalSeal } from '../src/gstv/types.js';

const KNOWN_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SECRET_SENTINEL = 'SUPER_SECRET_SHOULD_NEVER_APPEAR_IN_OPS';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function opLines(logDir: string, op: string): string[] {
  const candidates = [logDir, path.join(os.tmpdir(), 'wevibe-test-logs')];
  const lines: string[] = [];
  for (const baseDir of candidates) {
    const filePath = path.join(baseDir, 'ops', `${op}-${utcDay()}.log`);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    lines.push(...fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0));
  }
  return lines;
}

function allOpLines(logDir: string): string[] {
  const lines: string[] = [];
  const candidates = [logDir, path.join(os.tmpdir(), 'wevibe-test-logs')];
  for (const baseDir of candidates) {
    const opsDir = path.join(baseDir, 'ops');
    if (!fs.existsSync(opsDir)) {
      continue;
    }
    const files = fs.readdirSync(opsDir).filter((name) => name.endsWith('.log'));
    for (const fileName of files) {
      lines.push(...fs.readFileSync(path.join(opsDir, fileName), 'utf8').split('\n').filter(Boolean));
    }
  }
  return lines;
}

function fixture(goalId = 'gstv-goal-unlock'): {
  root: string;
  repoRoot: string;
  goalId: string;
  goalDir: string;
  seal: GoalSeal;
  meta: GoalMeta;
  goal: { goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string };
} {
  const root = tmp('gstv-unlock-root-');
  const repoRoot = tmp('gstv-unlock-repo-');
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

function writeManifestHead(goalDir: string, files: string[]): void {
  fs.writeFileSync(
    path.join(goalDir, 'manifest-head.json'),
    `${JSON.stringify({
      alg: 'walk-v1',
      files: files.map((filePath) => ({ path: filePath, sha256: sha256Hex(filePath) })),
      updated_at: '2026-07-26T12:00:30.000Z',
    })}\n`,
    'utf8',
  );
}

async function seedHead(f: ReturnType<typeof fixture>): Promise<void> {
  await appendLink(f.goalDir, f.seal, {
    ts: '2026-07-26T12:00:30.000Z',
    session_id: 'seed-session',
    cause: 'attach',
    kind: 'state',
    state_hash: '1'.repeat(64),
    diff_hash: '2'.repeat(64),
  });
}

function closeEvent(trace = 'trace-close', session = 'session-close') {
  return {
    source: 'tool' as const,
    command: 'npx vitest run tests/predicate.test.ts',
    exit: 0,
    ts: '2026-07-26T12:01:00.000Z',
    session_id: session,
    trace,
  };
}

async function observe(
  goal: { goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string },
  ev: { source: 'tool'; command: string; exit: number; ts: string; session_id: string; trace: string },
  root: string,
) {
  const { observePredicate } = await import('../src/gstv/predicate.js');
  return observePredicate(goal, ev, { root });
}

describe('gstv unlock + close measurement', () => {
  let prevLogDir: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    const keyStore = await import('../src/key-store.js');
    keyStore.clearTestStore();
    await keyStore.storeIdentitySeed(Buffer.from(KNOWN_SEED_HEX, 'hex'));
    await ensureCrypto();

    prevLogDir = process.env.WEVIBE_LOG_DIR;
    process.env.WEVIBE_LOG_DIR = tmp('gstv-unlock-logs-');
  });

  afterEach(() => {
    if (prevLogDir === undefined) {
      delete process.env.WEVIBE_LOG_DIR;
    } else {
      process.env.WEVIBE_LOG_DIR = prevLogDir;
    }
    vi.resetModules();
  });

  it('on close writes signed bench-mock predicate receipt and predicate.receipt op uses catalog fp8 fields only', async () => {
    const f = fixture('gstv-unlock-receipt');
    await seedHead(f);
    writeManifestHead(f.goalDir, ['src/final-green.ts']);

    const out = await observe(f.goal, closeEvent('trace-a', 'session-a'), f.root);
    expect(out.closed).toBe(true);

    const receiptFiles = fs.readdirSync(path.join(f.goalDir, 'receipts')).filter((name) => name.endsWith('.json'));
    const predicateReceipts = receiptFiles
      .map((name) => JSON.parse(fs.readFileSync(path.join(f.goalDir, 'receipts', name), 'utf8')) as Record<string, unknown>)
      .filter((artifact) => artifact.kind === 'predicate');
    expect(predicateReceipts).toHaveLength(1);

    const artifact = predicateReceipts[0] as {
      kind: string;
      bench_mock: boolean;
      chain_head: string;
      contributor_sig: string;
    };
    expect(artifact.kind).toBe('predicate');
    expect(artifact.bench_mock).toBe(true);
    expect(artifact.chain_head).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyReceiptSignature(predicateReceipts[0] as never)).toBe(true);

    const lines = opLines(process.env.WEVIBE_LOG_DIR!, 'predicate.receipt');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('op=predicate.receipt');
    expect(lines[0]).toContain('trace=trace-a');
    expect(lines[0]).toContain('session_id=session-a');
    expect(lines[0]).toContain(`goal_id=${f.goalId}`);
    expect(lines[0]).toContain('exit=0');
    expect(lines[0]).toContain('status=ok');
    expect(lines[0]).toMatch(/\benv_fp=[0-9a-f]{8}(\b|$)/);
    expect(lines[0]).toMatch(/\bchain_head_fp=[0-9a-f]{8}(\b|$)/);
    expect(lines[0]).toMatch(/\breceipt_fp=[0-9a-f]{8}(\b|$)/);
    expect(lines[0]).toMatch(/\bsig_fp=[0-9a-f]{8}(\b|$)/);
    expect(lines[0]).not.toContain(artifact.chain_head);
    expect(lines[0]).not.toContain(artifact.contributor_sig);
  });

  it('writes extraction-unlock.json with required shape and emits gstv.extraction.unlock catalog fields', async () => {
    const f = fixture('gstv-unlock-artifact');
    await seedHead(f);
    writeManifestHead(f.goalDir, ['src/final-green.ts']);

    await observe(f.goal, closeEvent('trace-b', 'session-b'), f.root);

    const unlockPath = path.join(f.goalDir, 'extraction-unlock.json');
    expect(fs.existsSync(unlockPath)).toBe(true);
    const unlock = JSON.parse(fs.readFileSync(unlockPath, 'utf8')) as Record<string, unknown>;

    expect(unlock.v).toBe('gstv-unlock-v1');
    expect(unlock.goal_id).toBe(f.goalId);
    expect(typeof unlock.links).toBe('number');
    expect(typeof unlock.gaps).toBe('number');
    expect(unlock.chain_head).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(unlock.episodes)).toBe(true);
    expect(typeof unlock.receipts).toBe('object');
    expect(unlock.attempts_to_green).toBe(1);
    expect(unlock.sessions).toBe(1);
    expect(unlock.red_boundaries).toBe(0);
    expect(['parsed', 'raw', 'mixed', 'absent']).toContain(unlock.signal_key_mode as string);

    const tier = unlock.tier_upgrade as { from?: string; to?: string } | null;
    expect(tier).toEqual({ from: 'T0', to: 'T1', basis: 'predicate_receipt' });

    const lines = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.extraction.unlock').filter((line) =>
      line.includes('trace=trace-b') && line.includes(`goal_id=${f.goalId}`),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('op=gstv.extraction.unlock');
    expect(lines[0]).toContain('trace=trace-b');
    expect(lines[0]).toContain('session_id=session-b');
    expect(lines[0]).toContain(`goal_id=${f.goalId}`);
    expect(lines[0]).toContain('links=');
    expect(lines[0]).toContain('gaps=');
    expect(lines[0]).toContain('episodes=0');
    expect(lines[0]).toContain('receipts_predicate=1');
    expect(lines[0]).toContain('attempts_to_green=1');
    expect(lines[0]).toContain('sessions=1');
    expect(lines[0]).toContain('red_boundaries=0');
    expect(lines[0]).toContain('status=ok');
    expect(lines[0]).toMatch(/\bunlock_fp=[0-9a-f]{8}(\b|$)/);
  });

  it('negative receipts: writes exactly one for absent cited files, skips present cited files, discloses skipped basis', async () => {
    const f = fixture('gstv-unlock-negative');
    await seedHead(f);
    writeManifestHead(f.goalDir, ['src/present.ts']);

    const episodes = [
      {
        ts: '2026-07-26T12:00:40.000Z',
        session_id: 'session-neg',
        episode_id: 'ep-absent',
        signal_key: 'test:src/x.test.ts::x',
        signal_key_mode: 'parsed',
        framework: 'vitest',
        source: 'test_failure',
        outcome: 'unresolved',
        attempt_diff_fp: 'abcddcba',
        attempt_diff_basis: 'edit-refs',
        edits: 1,
        coincidental_flip: false,
        cited_files: ['src/absent.ts'],
        cited_state_hash: '3'.repeat(64),
        secret_material: SECRET_SENTINEL,
      },
      {
        ts: '2026-07-26T12:00:41.000Z',
        session_id: 'session-neg',
        episode_id: 'ep-present',
        signal_key: 'test:src/y.test.ts::y',
        signal_key_mode: 'parsed',
        framework: 'vitest',
        source: 'test_failure',
        outcome: 'unresolved',
        attempt_diff_fp: '12344321',
        attempt_diff_basis: 'edit-refs',
        edits: 1,
        coincidental_flip: false,
        cited_files: ['src/present.ts'],
        cited_state_hash: '4'.repeat(64),
      },
    ];
    fs.writeFileSync(path.join(f.goalDir, 'episodes.jsonl'), `${episodes.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');

    await observe(f.goal, closeEvent('trace-c', 'session-c'), f.root);

    const receiptFiles = fs.readdirSync(path.join(f.goalDir, 'receipts')).filter((name) => name.endsWith('.json'));
    const negative = receiptFiles
      .map((name) => JSON.parse(fs.readFileSync(path.join(f.goalDir, 'receipts', name), 'utf8')) as Record<string, unknown>)
      .filter((artifact) => artifact.kind === 'negative');

    expect(negative).toHaveLength(1);
    expect(negative[0]).toMatchObject({
      kind: 'negative',
      semantics: 'not_sufficient_as_tried_then',
      absent_from_final: true,
      bench_mock: true,
    });

    const unlock = JSON.parse(fs.readFileSync(path.join(f.goalDir, 'extraction-unlock.json'), 'utf8')) as {
      gaps_disclosed: string[];
      receipts: { negative_receipt_ids: string[] };
    };
    expect(unlock.receipts.negative_receipt_ids).toHaveLength(1);
    expect(
      unlock.gaps_disclosed.some((item) =>
        item.includes('negative_receipt_skipped_present_in_final_manifest:episode=ep-present')),
    ).toBe(true);
  });

  it('idempotency: second close does not write additional predicate receipt or alter unlock record', async () => {
    const f = fixture('gstv-unlock-idempotent');
    await seedHead(f);
    writeManifestHead(f.goalDir, ['src/final-green.ts']);

    const first = await observe(f.goal, closeEvent('trace-d1', 'session-d1'), f.root);
    expect(first.closed).toBe(true);

    const unlockPath = path.join(f.goalDir, 'extraction-unlock.json');
    const unlockBefore = fs.readFileSync(unlockPath);
    const receiptsBefore = fs
      .readdirSync(path.join(f.goalDir, 'receipts'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(f.goalDir, 'receipts', name), 'utf8')) as Record<string, unknown>)
      .filter((artifact) => artifact.kind === 'predicate');
    expect(receiptsBefore).toHaveLength(1);

    const second = await observe(f.goal, closeEvent('trace-d2', 'session-d2'), f.root);
    expect(second.closed).toBe(false);
    expect(second.alreadyClosed).toBe(true);

    const receiptsAfter = fs
      .readdirSync(path.join(f.goalDir, 'receipts'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(f.goalDir, 'receipts', name), 'utf8')) as Record<string, unknown>)
      .filter((artifact) => artifact.kind === 'predicate');
    expect(receiptsAfter).toHaveLength(1);
    expect(Buffer.compare(unlockBefore, fs.readFileSync(unlockPath))).toBe(0);
  });

  it('receipt-write failure does not break close outcome; closed.json + goal.close still emitted and unlock op marks error', async () => {
    const f = fixture('gstv-unlock-resilience');
    await seedHead(f);
    writeManifestHead(f.goalDir, ['src/final-green.ts']);

    const keyStore = await import('../src/key-store.js');
    keyStore.clearTestStore();

    const out = await observe(f.goal, closeEvent('trace-e', 'session-e'), f.root);
    expect(out.closed).toBe(true);
    expect(fs.existsSync(path.join(f.goalDir, 'closed.json'))).toBe(true);

    const closeLines = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.goal.close').filter((line) =>
      line.includes('trace=trace-e') && line.includes(`goal_id=${f.goalId}`),
    );
    expect(closeLines).toHaveLength(1);
    expect(closeLines[0]).toContain('status=ok');

    const unlockLines = opLines(process.env.WEVIBE_LOG_DIR!, 'gstv.extraction.unlock').filter((line) =>
      line.includes('trace=trace-e') && line.includes(`goal_id=${f.goalId}`),
    );
    expect(unlockLines).toHaveLength(1);
    expect(unlockLines[0]).toContain('status=error');

    const predicateReceiptLines = opLines(process.env.WEVIBE_LOG_DIR!, 'predicate.receipt').filter((line) =>
      line.includes('trace=trace-e') && line.includes(`goal_id=${f.goalId}`),
    );
    expect(predicateReceiptLines).toHaveLength(1);
    expect(predicateReceiptLines[0]).toContain('status=error');
  });

  it('does not leak seed/secret material on op lines', async () => {
    const f = fixture('gstv-unlock-no-secrets');
    await seedHead(f);
    writeManifestHead(f.goalDir, ['src/final-green.ts']);
    fs.writeFileSync(
      path.join(f.goalDir, 'episodes.jsonl'),
      `${JSON.stringify({
        ts: '2026-07-26T12:00:42.000Z',
        session_id: 'session-secret',
        episode_id: 'ep-secret',
        signal_key: 'test:src/z.test.ts::z',
        signal_key_mode: 'parsed',
        framework: 'vitest',
        source: 'test_failure',
        outcome: 'unresolved',
        attempt_diff_fp: 'feedbeef',
        attempt_diff_basis: 'edit-refs',
        edits: 1,
        coincidental_flip: false,
        cited_files: ['src/absent.ts'],
        secret_material: SECRET_SENTINEL,
      })}\n`,
      'utf8',
    );

    await observe(f.goal, closeEvent('trace-f', 'session-f'), f.root);

    const lines = allOpLines(process.env.WEVIBE_LOG_DIR!).filter((line) => line.includes(`goal_id=${f.goalId}`));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(SECRET_SENTINEL);
      expect(line).not.toContain(KNOWN_SEED_HEX);
    }
  });
});
