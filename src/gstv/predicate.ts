import fs from 'node:fs';
import path from 'node:path';

import { fp } from '../logger.js';
import { logOp } from '../logger.js';
import { observationsPath, walkCachePath } from './paths.js';
import { emitGstvGoalClose, emitGstvPredicateObserve } from './ops.js';
import { readChain } from './chain.js';
import { runGoalCloseMeasurement } from './unlock.js';
import { isGoalClosed, markGoalClosed } from './store.js';
import { canonicalJson, computeEnvFp, sha256Hex, type GoalMeta, type GoalSeal, type PredicateObservation } from './types.js';
import { walkManifest } from './walk.js';

function observationsFilePath(goalDirPath: string): string {
  return path.join(goalDirPath, 'observations.jsonl');
}

function readSealTimestamp(goalDirPath: string): string {
  const sealPath = path.join(goalDirPath, 'seal.json');
  const parsed = JSON.parse(fs.readFileSync(sealPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('seal_corrupt');
  }
  const sealedAt = (parsed as { sealed_at?: unknown }).sealed_at;
  if (typeof sealedAt !== 'string') {
    throw new Error('seal_corrupt');
  }
  return sealedAt;
}

function parseObservationLine(line: string): PredicateObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('observations_corrupt');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('observations_corrupt');
  }

  const candidate = parsed as Partial<PredicateObservation>;
  if (
    typeof candidate.goal_id !== 'string' ||
    typeof candidate.ts !== 'string' ||
    typeof candidate.session_id !== 'string' ||
    (candidate.source !== 'tool' && candidate.source !== 'command' && candidate.source !== 'boundary') ||
    typeof candidate.command !== 'string' ||
    !(typeof candidate.exit === 'number' || candidate.exit === null) ||
    typeof candidate.state_fp !== 'string' ||
    typeof candidate.env_fp !== 'string' ||
    typeof candidate.testfile_match !== 'boolean'
  ) {
    throw new Error('observations_corrupt');
  }

  return candidate as PredicateObservation;
}

/**
 * Exact matcher with whitespace tolerance only at command boundaries:
 * `sealedCommand.trim() === candidate.trim()`.
 * Internal bytes must remain identical.
 */
export function matchesSealedCommand(sealedCommand: string, candidate: string): boolean {
  return sealedCommand.trim() === candidate.trim();
}

export async function readObservations(goalDirPath: string): Promise<PredicateObservation[]> {
  const filePath = observationsFilePath(goalDirPath);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const observations: PredicateObservation[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      throw new Error('observations_corrupt');
    }
    observations.push(parseObservationLine(line));
  }
  return observations;
}

async function testfileMatchFor(meta: GoalMeta): Promise<boolean> {
  for (const sealed of meta.predicate_file_paths) {
    const absPath = path.join(meta.repo_root, sealed.path);
    try {
      const bytes = fs.readFileSync(absPath);
      const currentHash = sha256Hex(bytes);
      if (currentHash !== sealed.sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * D-GSTV-PREDICATE-DEFAULT close rule:
 * - close only when `exit===0 && testfile_match===true && not already closed`
 * - a green command observed against drifted predicate files NEVER closes
 * - if already closed, observation is still appended/emitted, but no re-close
 */
export async function observePredicate(
  goal: { goal_id: string; seal: GoalSeal; meta: GoalMeta; dir: string },
  ev: {
    source: 'tool' | 'command' | 'boundary';
    command: string;
    exit: number | null;
    ts: string;
    session_id: string;
    trace: string;
  },
  opts: { root: string },
): Promise<{ observation: PredicateObservation; closed: boolean; alreadyClosed: boolean }> {
  let observation: PredicateObservation | null = null;
  let emittedObserveOk = false;

  try {
    const testfile_match = await testfileMatchFor(goal.meta);
    const walk = await walkManifest(goal.meta.repo_root, { cacheFile: walkCachePath(opts.root) });
    const state_fp = fp(walk.manifest_hash);
    const env_fp = computeEnvFp();

    observation = {
      goal_id: goal.goal_id,
      ts: ev.ts,
      session_id: ev.session_id,
      source: ev.source,
      command: ev.command,
      exit: ev.exit,
      state_fp,
      env_fp,
      testfile_match,
    };

    const observationsFile = observationsPath(opts.root, goal.goal_id);
    fs.mkdirSync(path.dirname(observationsFile), { recursive: true });
    fs.appendFileSync(observationsFile, `${canonicalJson(observation)}\n`, 'utf8');

    emitGstvPredicateObserve({
      trace: ev.trace,
      session_id: ev.session_id,
      goal_id: goal.goal_id,
      source: ev.source,
      exit: ev.exit,
      state_fp,
      env_fp,
      testfile_match,
      status: 'ok',
    });
    emittedObserveOk = true;

    const alreadyClosed = await isGoalClosed(goal.goal_id, { root: opts.root });
    if (alreadyClosed) {
      return { observation, closed: false, alreadyClosed: true };
    }

    const shouldClose = ev.exit === 0 && testfile_match === true;
    if (!shouldClose) {
      return { observation, closed: false, alreadyClosed: false };
    }

    const closeStartMs = Date.now();
    const allObservations = await readObservations(goal.dir);
    const links = await readChain(goal.dir);

    const sessionSet = new Set(links.map((link) => link.session_id));
    const sessions = sessionSet.size > 0 ? sessionSet.size : 1;

    const closeRecord = {
      closed_at: ev.ts,
      attempts_to_green: allObservations.length,
      sessions,
      links: links.length,
      gaps: links.filter((link) => link.kind === 'gap').length,
      red_boundaries: allObservations.filter((item) => item.source === 'boundary' && item.exit !== 0).length,
    };

    await markGoalClosed(goal.goal_id, closeRecord, { root: opts.root });
    emitGstvGoalClose({
      trace: ev.trace,
      session_id: ev.session_id,
      goal_id: goal.goal_id,
      attempts_to_green: closeRecord.attempts_to_green,
      sessions: closeRecord.sessions,
      links: closeRecord.links,
      gaps: closeRecord.gaps,
      red_boundaries: closeRecord.red_boundaries,
      status: 'ok',
      dur_ms: Date.now() - closeStartMs,
    });

    try {
      await runGoalCloseMeasurement({
        goalDirPath: goal.dir,
        goalId: goal.goal_id,
        trace: ev.trace,
        sessionId: ev.session_id,
        closing: {
          exit: ev.exit ?? 0,
          attempts_to_green: closeRecord.attempts_to_green,
          sessions: closeRecord.sessions,
          red_boundaries: closeRecord.red_boundaries,
        },
      });
    } catch (error) {
      logOp('gstv.goal.close.measurement', 'error', {
        trace: ev.trace,
        session_id: ev.session_id,
        goal_id: goal.goal_id,
        err: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }

    return { observation, closed: true, alreadyClosed: false };
  } catch (error) {
    if (!emittedObserveOk) {
      emitGstvPredicateObserve({
        trace: ev.trace,
        session_id: ev.session_id,
        goal_id: goal.goal_id,
        source: ev.source,
        exit: ev.exit,
        state_fp: observation?.state_fp ?? '-',
        env_fp: observation?.env_fp ?? '-',
        testfile_match: observation?.testfile_match ?? false,
        status: 'err',
        err: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/**
 * D-GSTV-BOUNDARY-STAMP:
 * needs_boundary_run = false IFF newest predicate observation ts is STRICTLY
 * greater than the last state-change ts.
 * Equal timestamps are treated as stale and therefore NEED a run.
 */
export async function boundaryStampDecision(
  goalDirPath: string,
): Promise<{ needs_boundary_run: boolean; boundary_reason: string }> {
  const observations = await readObservations(goalDirPath);
  if (observations.length === 0) {
    return { needs_boundary_run: true, boundary_reason: 'no_observations' };
  }

  const newestObservationTs = observations.reduce((max, item) => (item.ts > max ? item.ts : max), observations[0].ts);
  const links = await readChain(goalDirPath);
  const lastStateChangeTs =
    links.length > 0
      ? links[links.length - 1].ts
      : readSealTimestamp(goalDirPath);

  if (newestObservationTs > lastStateChangeTs) {
    return { needs_boundary_run: false, boundary_reason: 'observation_current' };
  }

  return { needs_boundary_run: true, boundary_reason: 'state_changed_since_last_observation' };
}
