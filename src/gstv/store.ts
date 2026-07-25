import fs from 'node:fs';
import path from 'node:path';

import { sign } from '../crypto.js';
import { ensureCrypto } from '../crypto-utils.js';
import { fp, logOp } from '../logger.js';
import { loadIdentity } from '../key-store.js';
import {
  closedPath,
  goalDir,
  goalsDir,
  metaPath,
  resolveGstvRoot,
  sealPath,
  walkCachePath,
} from './paths.js';
import {
  canonicalJson,
  computePredicateHash,
  goalIdFor,
  type GoalMeta,
  type GoalSeal,
  sha256Hex,
} from './types.js';
import { walkManifest } from './walk.js';

type SealErrorCode = 'repo_not_bound' | 'predicate_file_missing' | 'goal_not_found';

export class SealError extends Error {
  readonly code: SealErrorCode;

  constructor(code: SealErrorCode, message: string) {
    super(message);
    this.name = 'SealError';
    this.code = code;
  }
}

interface OrgMarker {
  mc_version: 1;
  org_id: string;
  project_fingerprint: string;
  fingerprint_source: 'origin' | 'realpath';
  bound_at: string;
}

function resolveRoot(root?: string): string {
  return root ?? resolveGstvRoot();
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort on non-POSIX platforms
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on non-POSIX platforms
  }
}

function parseGoalSeal(value: unknown): GoalSeal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('seal_not_object');
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.goal_id !== 'string' ||
    typeof candidate.goal_text_hash !== 'string' ||
    typeof candidate.predicate_hash !== 'string' ||
    typeof candidate.state0_hash !== 'string' ||
    typeof candidate.repo_binding !== 'string' ||
    typeof candidate.sealed_at !== 'string' ||
    typeof candidate.contributor_sig !== 'string' ||
    candidate.chain_anchor !== null ||
    candidate.state_alg !== 'walk-v1'
  ) {
    throw new Error('seal_shape_invalid');
  }

  return candidate as unknown as GoalSeal;
}

function parseGoalMeta(value: unknown): GoalMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('meta_not_object');
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.repo_root !== 'string' ||
    typeof candidate.predicate_command !== 'string' ||
    !Array.isArray(candidate.predicate_file_paths) ||
    typeof candidate.state_alg !== 'string' ||
    typeof candidate.goal_text_fp !== 'string'
  ) {
    throw new Error('meta_shape_invalid');
  }

  return candidate as unknown as GoalMeta;
}

function loadGoalFromDisk(root: string, goalId: string): { goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string } {
  const dir = goalDir(root, goalId);
  const seal = parseGoalSeal(JSON.parse(fs.readFileSync(sealPath(root, goalId), 'utf8')) as unknown);
  const meta = parseGoalMeta(JSON.parse(fs.readFileSync(metaPath(root, goalId), 'utf8')) as unknown);
  return {
    goal_id: goalId,
    seal,
    meta,
    dir,
  };
}

/**
 * repo_binding definition: `${org_id}:${project_fingerprint}` from `<repoRoot>/.wevibe/org.json`.
 */
export async function readRepoBinding(repoRoot: string): Promise<string> {
  const markerFile = path.join(repoRoot, '.wevibe', 'org.json');
  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as unknown;
  } catch {
    throw new SealError('repo_not_bound', `missing or unreadable repo binding marker: ${markerFile}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SealError('repo_not_bound', `malformed repo binding marker: ${markerFile}`);
  }

  const marker = parsed as Partial<OrgMarker>;
  if (
    marker.mc_version !== 1 ||
    typeof marker.org_id !== 'string' ||
    marker.org_id.trim() === '' ||
    typeof marker.project_fingerprint !== 'string' ||
    marker.project_fingerprint.trim() === ''
  ) {
    throw new SealError('repo_not_bound', `invalid repo binding marker shape: ${markerFile}`);
  }

  return `${marker.org_id}:${marker.project_fingerprint}`;
}

export async function createGoalSeal(
  input: {
    repo_root: string;
    goal_text: string;
    predicate_command: string;
    predicate_file_paths: string[];
  },
  opts: { root?: string },
): Promise<{ goal_id: string; seal_fp: string; seal: GoalSeal; meta: GoalMeta }> {
  const root = resolveRoot(opts.root);
  const repoBinding = await readRepoBinding(input.repo_root);
  const goalTextHash = sha256Hex(input.goal_text);

  const predicatePathsWithHashes = await Promise.all(
    input.predicate_file_paths.map(async (filePath) => {
      const abs = path.join(input.repo_root, filePath);
      try {
        const bytes = fs.readFileSync(abs);
        return { path: filePath, sha256: sha256Hex(bytes) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new SealError('predicate_file_missing', `predicate file missing: ${filePath}`);
        }
        throw error;
      }
    }),
  );

  predicatePathsWithHashes.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const predicateHash = computePredicateHash(
    input.predicate_command,
    predicatePathsWithHashes.map((entry) => entry.sha256),
  );

  const walk = await walkManifest(input.repo_root, { cacheFile: walkCachePath(root) });
  const sealedAt = new Date().toISOString();

  await ensureCrypto();
  const identity = await loadIdentity();
  if (!identity) {
    throw new Error('No WeVibe identity found. Create your identity first, then retry.');
  }
  const edPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');

  const goalId = goalIdFor({
    repo_binding: repoBinding,
    goal_text_hash: goalTextHash,
    sealed_at: sealedAt,
    ed_pubkey_hex: edPubkeyHex,
  });

  const sealWithoutSig: Omit<GoalSeal, 'contributor_sig'> = {
    goal_id: goalId,
    goal_text_hash: goalTextHash,
    predicate_hash: predicateHash,
    state0_hash: walk.manifest_hash,
    repo_binding: repoBinding,
    sealed_at: sealedAt,
    chain_anchor: null,
    state_alg: walk.alg,
  };

  /**
   * Signature preimage = UTF-8 bytes of canonicalJson(sealWithoutSig), where
   * sealWithoutSig contains all GoalSeal fields EXCEPT contributor_sig.
   */
  const preimage = new TextEncoder().encode(canonicalJson(sealWithoutSig));
  const contributorSig = Buffer.from(sign(identity.edPrivkey, preimage)).toString('hex');

  const seal: GoalSeal = {
    ...sealWithoutSig,
    contributor_sig: contributorSig,
  };

  const meta: GoalMeta = {
    repo_root: input.repo_root,
    predicate_command: input.predicate_command,
    predicate_file_paths: predicatePathsWithHashes,
    state_alg: walk.alg,
    goal_text_fp: fp(input.goal_text),
  };

  fs.mkdirSync(goalDir(root, goalId), { recursive: true });
  writeJsonAtomic(sealPath(root, goalId), seal);
  writeJsonAtomic(metaPath(root, goalId), meta);

  const sealFp = fp(sha256Hex(canonicalJson(seal)));
  return {
    goal_id: goalId,
    seal_fp: sealFp,
    seal,
    meta,
  };
}

/**
 * If multiple unclosed seals match repo binding, newest sealed_at wins.
 * Abandonment = newer seal supersedes older seal without mutating old artifacts.
 */
export async function loadOpenGoal(
  repoRoot: string,
  opts: { root?: string },
): Promise<{ goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string } | null> {
  let repoBinding: string;
  try {
    repoBinding = await readRepoBinding(repoRoot);
  } catch (error) {
    if (error instanceof SealError && error.code === 'repo_not_bound') {
      return null;
    }
    throw error;
  }

  const root = resolveRoot(opts.root);
  const goalsRoot = goalsDir(root);
  if (!fs.existsSync(goalsRoot)) {
    return null;
  }

  const entries = fs.readdirSync(goalsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  let best: { goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string } | null = null;

  for (const entry of entries) {
    const goalId = entry.name;
    if (fs.existsSync(closedPath(root, goalId))) {
      continue;
    }

    try {
      const candidate = loadGoalFromDisk(root, goalId);
      if (candidate.seal.repo_binding !== repoBinding) {
        continue;
      }

      const candidateTs = Date.parse(candidate.seal.sealed_at);
      if (!Number.isFinite(candidateTs)) {
        throw new Error('sealed_at_invalid');
      }

      if (!best) {
        best = candidate;
        continue;
      }

      const bestTs = Date.parse(best.seal.sealed_at);
      if (candidateTs > bestTs) {
        best = candidate;
      }
    } catch (error) {
      logOp('gstv.store', 'warn', {
        trace: '-',
        reason: 'corrupt_goal_subdir_skipped',
        goal_id: goalId,
        goal_dir_fp: fp(goalDir(root, goalId)),
        seal_path_fp: fp(sealPath(root, goalId)),
        meta_path_fp: fp(metaPath(root, goalId)),
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return best;
}

export async function loadGoalById(
  goalId: string,
  opts: { root?: string },
): Promise<{ goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string } | null> {
  const root = resolveRoot(opts.root);
  if (!fs.existsSync(sealPath(root, goalId)) || !fs.existsSync(metaPath(root, goalId))) {
    return null;
  }

  try {
    return loadGoalFromDisk(root, goalId);
  } catch {
    return null;
  }
}

export async function markGoalClosed(
  goalId: string,
  record: {
    closed_at: string;
    attempts_to_green: number;
    sessions: number;
    links: number;
    gaps: number;
    red_boundaries: number;
  },
  opts: { root?: string },
): Promise<void> {
  const root = resolveRoot(opts.root);
  if (!fs.existsSync(sealPath(root, goalId)) || !fs.existsSync(metaPath(root, goalId))) {
    throw new SealError('goal_not_found', `goal not found: ${goalId}`);
  }
  writeJsonAtomic(closedPath(root, goalId), record);
}

export async function isGoalClosed(goalId: string, opts: { root?: string }): Promise<boolean> {
  const root = resolveRoot(opts.root);
  return fs.existsSync(closedPath(root, goalId));
}
