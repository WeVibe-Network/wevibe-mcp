import { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { BodyReadError, readBody } from '../http-body.js';
import { loadIdentity } from '../key-store.js';
import { fp, logOp } from '../logger.js';
import { GstvEngine } from './engine.js';
import { emitGstvSeal } from './ops.js';
import { resolveGstvRoot } from './paths.js';
import { boundaryStampDecision } from './predicate.js';
import { createGoalSeal, SealError } from './store.js';
import type { GstvGoalRouteResponse, GstvSealRouteResponse } from './types.js';

let engine: GstvEngine | null = null;

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function getRequestTrace(req: IncomingMessage): string {
  const trace = (req as IncomingMessage & { _wevibeTrace?: string })._wevibeTrace;
  return trace ?? '-';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const normalized: string[] = [];
  for (const item of value) {
    const parsed = nonEmptyString(item);
    if (!parsed) {
      return null;
    }
    normalized.push(parsed);
  }
  return normalized;
}

export function getGstvEngine(): GstvEngine {
  if (!engine) {
    engine = new GstvEngine();
  }
  return engine;
}

export async function startGstvRuntime(): Promise<void> {
  try {
    getGstvEngine().start();
  } catch (error) {
    logOp('gstv.runtime', 'error', { trace: '-', err: errorText(error) });
  }
}

export function stopGstvRuntime(): void {
  if (!engine) {
    return;
  }
  engine.stop();
  engine = null;
}

/**
 * Dispatcher guarantees authorization before invoking this handler.
 */
export async function handleGstvGoal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const trace = getRequestTrace(req);
  try {
    const parsedUrl = new URL(req.url ?? '', 'http://127.0.0.1');
    const repoRoot = nonEmptyString(parsedUrl.searchParams.get('repo_root'));
    if (!repoRoot) {
      jsonResponse(res, 400, { status: 'error', code: 'repo_root_required' });
      return;
    }

    const goal = await getGstvEngine().getOpenGoalForRepo(repoRoot);
    if (!goal) {
      const closed: GstvGoalRouteResponse = { open: false };
      jsonResponse(res, 200, closed);
      return;
    }

    const boundary = await boundaryStampDecision(goal.dir);
    const open: GstvGoalRouteResponse = {
      open: true,
      goal_id: goal.goal_id,
      goal_text_fp: goal.meta.goal_text_fp,
      predicate: {
        command: goal.meta.predicate_command,
        file_paths: goal.meta.predicate_file_paths.map((entry) => entry.path),
      },
      needs_boundary_run: boundary.needs_boundary_run,
      boundary_reason: boundary.boundary_reason,
    };
    jsonResponse(res, 200, open);
  } catch (error) {
    const err = errorText(error);
    logOp('gstv.goal.read', 'error', { trace, err });
    jsonResponse(res, 500, { status: 'error', error: err });
  }
}

/**
 * Dispatcher guarantees authorization before invoking this handler.
 */
export async function handleGstvSeal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const trace = getRequestTrace(req);
  const startedAt = Date.now();
  let sessionId = '-';

  try {
    const bodyText = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      jsonResponse(res, 400, { status: 'error', code: 'invalid_json' });
      return;
    }

    const repoRoot = nonEmptyString(body.repo_root);
    if (!repoRoot) {
      jsonResponse(res, 400, { status: 'error', code: 'repo_root_required' });
      return;
    }

    const goalText = nonEmptyString(body.goal_text);
    if (!goalText) {
      jsonResponse(res, 400, { status: 'error', code: 'goal_text_required' });
      return;
    }

    const predicateCommand = nonEmptyString(body.predicate_command);
    if (!predicateCommand) {
      jsonResponse(res, 400, { status: 'error', code: 'predicate_command_required' });
      return;
    }

    const predicateFilePaths = stringArray(body.predicate_file_paths);
    if (!predicateFilePaths) {
      jsonResponse(res, 400, { status: 'error', code: 'predicate_file_paths_required' });
      return;
    }

    const parsedSessionId = nonEmptyString(body.session_id);
    sessionId = parsedSessionId ?? '-';

    const created = await createGoalSeal(
      {
        repo_root: repoRoot,
        goal_text: goalText,
        predicate_command: predicateCommand,
        predicate_file_paths: predicateFilePaths,
      },
      { root: resolveGstvRoot() },
    );

    const identity = await loadIdentity();
    const edPubHex = identity ? Buffer.from(identity.edPubkey).toString('hex') : '-';

    emitGstvSeal({
      trace,
      session_id: sessionId,
      goal_id: created.goal_id,
      goal_text_fp: fp(created.seal.goal_text_hash),
      predicate_fp: fp(created.seal.predicate_hash),
      state0_fp: fp(created.seal.state0_hash),
      repo_fp: fp(created.seal.repo_binding),
      seal_fp: created.seal_fp,
      ed_pub_fp: fp(edPubHex),
      sig_fp: fp(created.seal.contributor_sig),
      status: 'ok',
      dur_ms: Date.now() - startedAt,
    });

    const response: GstvSealRouteResponse = {
      goal_id: created.goal_id,
      seal_fp: created.seal_fp,
    };
    jsonResponse(res, 200, response);
  } catch (error) {
    if (error instanceof BodyReadError) {
      logOp('gstv.seal', 'warn', { trace, phase: 'body_guard', reason: error.code, status: error.status });
      jsonResponse(res, error.status, { status: 'error', code: error.code, error: error.message });
      return;
    }

    if (error instanceof SealError && (error.code === 'repo_not_bound' || error.code === 'predicate_file_missing')) {
      jsonResponse(res, 400, { status: 'error', code: error.code });
      return;
    }

    const err = errorText(error);
    emitGstvSeal({
      trace,
      session_id: sessionId,
      goal_id: '-',
      goal_text_fp: '-',
      predicate_fp: '-',
      state0_fp: '-',
      repo_fp: '-',
      seal_fp: '-',
      ed_pub_fp: '-',
      sig_fp: '-',
      status: 'err',
      dur_ms: Date.now() - startedAt,
      err,
    });
    jsonResponse(res, 500, { status: 'error', error: err });
  }
}
