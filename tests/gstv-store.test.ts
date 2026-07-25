process.env.WEVIBE_KEYSTORE_TEST = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verify } from '../src/crypto.js';
import { ensureCrypto } from '../src/crypto-utils.js';
import { fp } from '../src/logger.js';
import {
  canonicalJson,
  type GoalSeal,
  goalIdFor,
  sha256Hex,
} from '../src/gstv/types.js';
import {
  createGoalSeal,
  isGoalClosed,
  loadGoalById,
  loadOpenGoal,
  markGoalClosed,
  readRepoBinding,
  SealError,
} from '../src/gstv/store.js';
import { closedPath, goalDir, metaPath, sealPath } from '../src/gstv/paths.js';
import { clearTestStore, storeIdentitySeed } from '../src/key-store.js';

const KNOWN_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupFixtureRepo(prefix: string): { repoRoot: string; markerPath: string } {
  const repoRoot = makeTempDir(prefix);
  const markerDir = path.join(repoRoot, '.wevibe');
  fs.mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, 'org.json');
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        mc_version: 1,
        org_id: 'org-test',
        project_fingerprint: 'abc123fingerprint',
        fingerprint_source: 'realpath',
        bound_at: '2026-07-25T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { repoRoot, markerPath };
}

function writeRepoFile(repoRoot: string, relPath: string, data: string): void {
  const absPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, data, 'utf8');
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('gstv/store goal-seal store', () => {
  beforeEach(async () => {
    clearTestStore();
    await storeIdentitySeed(Buffer.from(KNOWN_SEED_HEX, 'hex'));
    vi.restoreAllMocks();
    await ensureCrypto();
  });

  it('readRepoBinding returns `${org_id}:${project_fingerprint}` and repo_not_bound when marker missing', async () => {
    const { repoRoot } = setupFixtureRepo('gstv-store-read-binding-');
    await expect(readRepoBinding(repoRoot)).resolves.toBe('org-test:abc123fingerprint');

    const missingRepo = makeTempDir('gstv-store-no-binding-');
    await expect(readRepoBinding(missingRepo)).rejects.toMatchObject({
      code: 'repo_not_bound',
    });
  });

  it('creates seal/meta, computes goal_id/seal_fp, and signature verifies over canonical sealWithoutSig preimage', async () => {
    const gstvRoot = makeTempDir('gstv-store-root-happy-');
    const { repoRoot } = setupFixtureRepo('gstv-store-repo-happy-');
    writeRepoFile(repoRoot, 'tests/a.test.ts', 'expect(true).toBe(true);\n');
    writeRepoFile(repoRoot, 'tests/b.test.ts', 'expect(1 + 1).toBe(2);\n');

    const created = await createGoalSeal(
      {
        repo_root: repoRoot,
        goal_text: 'make tests green',
        predicate_command: 'npx vitest run tests/a.test.ts tests/b.test.ts',
        predicate_file_paths: ['tests/b.test.ts', 'tests/a.test.ts'],
      },
      { root: gstvRoot },
    );

    expect(created.goal_id).toMatch(/^gstv-[0-9a-f]{16}$/);
    expect(created.seal_fp).toMatch(/^[0-9a-f]{8}$/);
    expect(created.seal.chain_anchor).toBeNull();
    expect(created.seal.state_alg).toBe('walk-v1');

    expect(Object.keys(created.seal).sort()).toEqual([
      'chain_anchor',
      'contributor_sig',
      'goal_id',
      'goal_text_hash',
      'predicate_hash',
      'repo_binding',
      'sealed_at',
      'state0_hash',
      'state_alg',
    ]);

    const { loadIdentity } = await import('../src/key-store.js');
    const identity = await loadIdentity();
    expect(identity).not.toBeNull();
    const recomputedGoalId = goalIdFor({
      repo_binding: created.seal.repo_binding,
      goal_text_hash: created.seal.goal_text_hash,
      sealed_at: created.seal.sealed_at,
      ed_pubkey_hex: Buffer.from(identity!.edPubkey).toString('hex'),
    });
    expect(created.goal_id).toBe(recomputedGoalId);

    const sealWithoutSig: Omit<GoalSeal, 'contributor_sig'> = {
      goal_id: created.seal.goal_id,
      goal_text_hash: created.seal.goal_text_hash,
      predicate_hash: created.seal.predicate_hash,
      state0_hash: created.seal.state0_hash,
      repo_binding: created.seal.repo_binding,
      sealed_at: created.seal.sealed_at,
      chain_anchor: created.seal.chain_anchor,
      state_alg: created.seal.state_alg,
    };
    const preimage = new TextEncoder().encode(canonicalJson(sealWithoutSig));
    const sigBytes = Buffer.from(created.seal.contributor_sig, 'hex');
    expect(sigBytes.length).toBe(64);
    expect(verify(identity!.edPubkey, sigBytes, preimage)).toBe(true);

    const expectedSealFp = fp(sha256Hex(canonicalJson(created.seal)));
    expect(created.seal_fp).toBe(expectedSealFp);

    const sealFromDisk = JSON.parse(readUtf8(sealPath(gstvRoot, created.goal_id))) as GoalSeal;
    expect(sealFromDisk).toEqual(created.seal);
    const metaFromDisk = JSON.parse(readUtf8(metaPath(gstvRoot, created.goal_id))) as {
      predicate_file_paths: Array<{ path: string; sha256: string }>;
      state_alg: string;
    };
    expect(metaFromDisk.state_alg).toBe('walk-v1');
    expect(metaFromDisk.predicate_file_paths.map((entry) => entry.path)).toEqual([
      'tests/a.test.ts',
      'tests/b.test.ts',
    ]);
  });

  it('changes predicate_hash when predicate file content changes (anti-goalpost)', async () => {
    const gstvRoot = makeTempDir('gstv-store-root-anti-goalpost-');
    const { repoRoot } = setupFixtureRepo('gstv-store-repo-anti-goalpost-');
    writeRepoFile(repoRoot, 'tests/goalpost.test.ts', 'expect(true).toBe(true);\n');

    const first = await createGoalSeal(
      {
        repo_root: repoRoot,
        goal_text: 'keep predicate stable',
        predicate_command: 'npx vitest run tests/goalpost.test.ts',
        predicate_file_paths: ['tests/goalpost.test.ts'],
      },
      { root: gstvRoot },
    );

    writeRepoFile(repoRoot, 'tests/goalpost.test.ts', 'expect(false).toBe(false);\n');

    const second = await createGoalSeal(
      {
        repo_root: repoRoot,
        goal_text: 'keep predicate stable',
        predicate_command: 'npx vitest run tests/goalpost.test.ts',
        predicate_file_paths: ['tests/goalpost.test.ts'],
      },
      { root: gstvRoot },
    );

    expect(second.seal.predicate_hash).not.toBe(first.seal.predicate_hash);
  });

  it('throws specific errors for missing marker and missing predicate file', async () => {
    const gstvRoot = makeTempDir('gstv-store-root-errors-');

    const unboundRepo = makeTempDir('gstv-store-repo-unbound-');
    await expect(
      createGoalSeal(
        {
          repo_root: unboundRepo,
          goal_text: 'x',
          predicate_command: 'npx vitest run',
          predicate_file_paths: ['tests/missing.test.ts'],
        },
        { root: gstvRoot },
      ),
    ).rejects.toMatchObject({ code: 'repo_not_bound' } satisfies Partial<SealError>);

    const { repoRoot } = setupFixtureRepo('gstv-store-repo-missing-predicate-');
    await expect(
      createGoalSeal(
        {
          repo_root: repoRoot,
          goal_text: 'x',
          predicate_command: 'npx vitest run tests/missing.test.ts',
          predicate_file_paths: ['tests/missing.test.ts'],
        },
        { root: gstvRoot },
      ),
    ).rejects.toMatchObject({ code: 'predicate_file_missing' } satisfies Partial<SealError>);
  });

  it('loadOpenGoal resolves open goal, closed goals drop out, newer unclosed seal wins, and artifacts remain immutable', async () => {
    const gstvRoot = makeTempDir('gstv-store-root-open-');
    const { repoRoot } = setupFixtureRepo('gstv-store-repo-open-');
    writeRepoFile(repoRoot, 'tests/flow.test.ts', 'expect(true).toBe(true);\n');

    const first = await createGoalSeal(
      {
        repo_root: repoRoot,
        goal_text: 'first goal text',
        predicate_command: 'npx vitest run tests/flow.test.ts',
        predicate_file_paths: ['tests/flow.test.ts'],
      },
      { root: gstvRoot },
    );

    const firstSealPath = sealPath(gstvRoot, first.goal_id);
    const firstMetaPath = metaPath(gstvRoot, first.goal_id);
    const firstSealBytesBeforeClose = readUtf8(firstSealPath);
    const firstMetaBytesBeforeClose = readUtf8(firstMetaPath);

    const open1 = await loadOpenGoal(repoRoot, { root: gstvRoot });
    expect(open1?.goal_id).toBe(first.goal_id);

    await markGoalClosed(
      first.goal_id,
      {
        closed_at: '2026-07-26T10:00:00.000Z',
        attempts_to_green: 3,
        sessions: 2,
        links: 5,
        gaps: 1,
        red_boundaries: 1,
      },
      { root: gstvRoot },
    );

    expect(readUtf8(firstSealPath)).toBe(firstSealBytesBeforeClose);
    expect(readUtf8(firstMetaPath)).toBe(firstMetaBytesBeforeClose);

    const openAfterClose = await loadOpenGoal(repoRoot, { root: gstvRoot });
    expect(openAfterClose).toBeNull();
    expect(await isGoalClosed(first.goal_id, { root: gstvRoot })).toBe(true);

    writeRepoFile(repoRoot, 'tests/flow.test.ts', 'expect(2 + 2).toBe(4);\n');
    const second = await createGoalSeal(
      {
        repo_root: repoRoot,
        goal_text: 'second goal text',
        predicate_command: 'npx vitest run tests/flow.test.ts',
        predicate_file_paths: ['tests/flow.test.ts'],
      },
      { root: gstvRoot },
    );

    // First goal artifacts remain byte-identical after second seal creation.
    expect(readUtf8(firstSealPath)).toBe(firstSealBytesBeforeClose);
    expect(readUtf8(firstMetaPath)).toBe(firstMetaBytesBeforeClose);

    const open2 = await loadOpenGoal(repoRoot, { root: gstvRoot });
    expect(open2).not.toBeNull();
    expect(open2!.goal_id).toBe(second.goal_id);

    const closedRecord = {
      closed_at: '2026-07-26T10:00:00.000Z',
      attempts_to_green: 3,
      sessions: 2,
      links: 5,
      gaps: 1,
      red_boundaries: 1,
    };
    expect(JSON.parse(readUtf8(closedPath(gstvRoot, first.goal_id)))).toEqual(closedRecord);
  });

  it('loadGoalById and isGoalClosed work, and corrupt subdir is skipped with warn log', async () => {
    const gstvRoot = makeTempDir('gstv-store-root-load-by-id-');
    const { repoRoot } = setupFixtureRepo('gstv-store-repo-load-by-id-');
    writeRepoFile(repoRoot, 'tests/lookup.test.ts', 'expect(true).toBe(true);\n');

    const created = await createGoalSeal(
      {
        repo_root: repoRoot,
        goal_text: 'lookup goal',
        predicate_command: 'npx vitest run tests/lookup.test.ts',
        predicate_file_paths: ['tests/lookup.test.ts'],
      },
      { root: gstvRoot },
    );

    const loaded = await loadGoalById(created.goal_id, { root: gstvRoot });
    expect(loaded?.goal_id).toBe(created.goal_id);
    expect(loaded?.seal).toEqual(created.seal);
    expect(await loadGoalById('gstv-ffffffffffffffff', { root: gstvRoot })).toBeNull();

    expect(await isGoalClosed(created.goal_id, { root: gstvRoot })).toBe(false);
    await markGoalClosed(
      created.goal_id,
      {
        closed_at: '2026-07-26T10:15:00.000Z',
        attempts_to_green: 1,
        sessions: 1,
        links: 1,
        gaps: 0,
        red_boundaries: 0,
      },
      { root: gstvRoot },
    );
    expect(await isGoalClosed(created.goal_id, { root: gstvRoot })).toBe(true);

    const badDir = goalDir(gstvRoot, 'gstv-corrupt-entry');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'seal.json'), '{not-json', 'utf8');
    fs.writeFileSync(path.join(badDir, 'meta.json'), '{not-json', 'utf8');

    await expect(loadOpenGoal(repoRoot, { root: gstvRoot })).resolves.toBeNull();
  });
});
