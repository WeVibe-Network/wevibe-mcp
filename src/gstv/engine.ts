import fs from 'node:fs';
import path from 'node:path';

import { fp, logOp } from '../logger.js';
import { appendLink, diffHashFor, readChainHead } from './chain.js';
import { emitGstvAttach, emitGstvChainLink, emitGstvGap } from './ops.js';
import { loadOpenGoal, loadGoalById } from './store.js';
import { goalDir, offsetsPath, resolveGstvRoot, resolveSpoolDirs, walkCachePath } from './paths.js';
import { matchesSealedCommand, observePredicate } from './predicate.js';
import { SpoolConsumer } from './spool.js';
import {
  CORRELATION_WINDOW_MS,
  SPOOL_EVENT,
  type FileEdited,
  type FileWatcherUpdated,
  type GstvAttachAttempt,
  type GstvBoundaryRun,
  type SpoolEnvelope,
  type ToolExecuteAfter,
  type CommandExecuted,
} from './types.js';
import { walkManifest } from './walk.js';

interface EngineOpts {
  root?: string;
  spoolDirs?: string[];
  now?: () => number;
}

interface ManifestHead {
  alg: 'walk-v1';
  files: Array<{ path: string; sha256: string }>;
  updated_at: string;
}

/**
 * GSTV engine dispatch rules:
 * - All event handlers are serialized through a single promise queue (single-writer)
 *   so chain.jsonl and observations.jsonl updates cannot race.
 * - gstv.attach.attempt: attaches session->goal and performs head check.
 *   - match => append state link cause=attach
 *   - mismatch => append gap link detector=attach_mismatch cause=attach
 *   - gap links emit BOTH gstv.chain.link(kind=gap) and gstv.gap
 * - tool.execute.after: for attached session append state link cause=call_id;
 *   then predicate-observe only when tool string matches sealed command.
 * - command.executed: for attached session predicate-observe only on sealed-command match.
 * - gstv.boundary.run: goal-addressed (by payload.goal_id, not attachment), always appends
 *   boundary state link and always observes boundary with payload command verbatim.
 * - file.edited: attached sessions only. Correlated within CORRELATION_WINDOW_MS from recent
 *   tool.execute.after are skipped (tool link captured/will capture state).
 * - file.watcher.updated: attached sessions only. Correlated within window from recent tool/edit
 *   are skipped; otherwise append watcher gap link and emit both chain.link+gap ops.
 * - session.created/session.idle/session.error/tool.execute.before/lsp.client.diagnostics are
 *   consumed but inert (no ops spam).
 *
 * manifest-head.json is engine-maintained and atomically rewritten after every appended link.
 * It is the diff base for the next link. If missing while a chain head exists (e.g. crash between
 * append and head write), we fall back prevFiles=null (all-added diff) and warn reason=head_manifest_missing.
 */
export class GstvEngine {
  private readonly root: string;
  private readonly spoolDirs: string[];
  private readonly now: () => number;

  readonly attachments = new Map<string, string>();
  readonly recentTool = new Map<string, { ts: number }>();
  readonly recentEdit = new Map<string, { ts: number }>();

  private queue: Promise<void> = Promise.resolve();
  private consumer: SpoolConsumer | null = null;

  constructor(opts: EngineOpts = {}) {
    this.root = opts.root ?? resolveGstvRoot();
    this.spoolDirs = opts.spoolDirs ?? resolveSpoolDirs();
    this.now = opts.now ?? (() => Date.now());
  }

  async ingest(e: SpoolEnvelope): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await this.dispatch(e);
      } catch (error) {
        logOp('gstv.engine', 'error', {
          trace: e.trace_id ?? '-',
          session_id: e.session_id,
          event: e.event,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return this.queue;
  }

  start(): void {
    this.ensureConsumer().start();
  }

  stop(): void {
    if (!this.consumer) {
      return;
    }
    this.consumer.stop();
    this.consumer = null;
  }

  async pollOnce(): Promise<{ read: number; skipped: number }> {
    const result = await this.ensureConsumer().pollOnce();
    await this.queue;
    return result;
  }

  async getOpenGoalForRepo(repoRoot: string) {
    return loadOpenGoal(repoRoot, { root: this.root });
  }

  async attachSession(sessionId: string, goalId: string): Promise<boolean> {
    return this.attachFlow({ sessionId, goalId, trace: '-', ts: new Date().toISOString() });
  }

  goalDirForSession(sessionId: string): string | null {
    const goalId = this.attachments.get(sessionId);
    if (!goalId) {
      return null;
    }
    return goalDir(this.root, goalId);
  }

  private ensureConsumer(): SpoolConsumer {
    if (this.consumer) {
      return this.consumer;
    }

    this.consumer = new SpoolConsumer({
      spoolDirs: this.spoolDirs,
      offsetsFile: offsetsPath(this.root),
      onEvent: (event) => {
        void this.ingest(event);
      },
    });
    return this.consumer;
  }

  private async dispatch(e: SpoolEnvelope): Promise<void> {
    const trace = e.trace_id ?? '-';

    switch (e.event) {
      case SPOOL_EVENT.GSTV_ATTACH_ATTEMPT: {
        const payload = e.payload as Partial<GstvAttachAttempt>;
        if (typeof payload.goal_id !== 'string') {
          return;
        }
        await this.attachFlow({ sessionId: e.session_id, goalId: payload.goal_id, trace, ts: e.ts });
        return;
      }

      case SPOOL_EVENT.TOOL_EXECUTE_AFTER: {
        const payload = e.payload as Partial<ToolExecuteAfter>;
        if (typeof payload.call_id !== 'string' || typeof payload.tool !== 'string') {
          return;
        }
        await this.handleToolExecuteAfter(e, payload as ToolExecuteAfter);
        return;
      }

      case SPOOL_EVENT.COMMAND_EXECUTED: {
        const payload = e.payload as Partial<CommandExecuted>;
        if (typeof payload.command !== 'string') {
          return;
        }
        await this.handleCommandExecuted(e, payload as CommandExecuted);
        return;
      }

      case SPOOL_EVENT.GSTV_BOUNDARY_RUN: {
        const payload = e.payload as Partial<GstvBoundaryRun>;
        if (
          typeof payload.goal_id !== 'string' ||
          typeof payload.command !== 'string' ||
          typeof payload.exit_code !== 'number' ||
          typeof payload.duration_ms !== 'number'
        ) {
          return;
        }
        await this.handleBoundaryRun(e, payload as GstvBoundaryRun);
        return;
      }

      case SPOOL_EVENT.FILE_EDITED: {
        const payload = e.payload as Partial<FileEdited>;
        if (typeof payload.path !== 'string') {
          return;
        }
        await this.handleFileEdited(e, payload as FileEdited);
        return;
      }

      case SPOOL_EVENT.FILE_WATCHER_UPDATED: {
        const payload = e.payload as Partial<FileWatcherUpdated>;
        if (typeof payload.path !== 'string') {
          return;
        }
        await this.handleWatcherUpdated(e, payload as FileWatcherUpdated);
        return;
      }

      case SPOOL_EVENT.SESSION_CREATED:
      case SPOOL_EVENT.SESSION_IDLE:
      case SPOOL_EVENT.SESSION_ERROR:
      case SPOOL_EVENT.TOOL_EXECUTE_BEFORE:
      case SPOOL_EVENT.LSP_CLIENT_DIAGNOSTICS:
        return;
    }
  }

  private async attachFlow(input: {
    sessionId: string;
    goalId: string;
    trace: string;
    ts: string;
  }): Promise<boolean> {
    const goal = await loadGoalById(input.goalId, { root: this.root });
    if (!goal) {
      logOp('gstv.engine', 'warn', {
        trace: input.trace,
        session_id: input.sessionId,
        event: SPOOL_EVENT.GSTV_ATTACH_ATTEMPT,
        reason: 'attach_unknown_goal',
        goal_id: input.goalId,
      });
      return false;
    }

    this.attachments.set(input.sessionId, input.goalId);

    const head = await readChainHead(goal.dir);
    const current = await walkManifest(goal.meta.repo_root, { cacheFile: walkCachePath(this.root) });
    const headState = head?.state_hash ?? goal.seal.state0_hash;
    const match = current.manifest_hash === headState;
    const manifestHead = this.readManifestHead(goal.dir);

    if (match) {
      const prevFiles = manifestHead?.files ?? current.files;
      const link = await appendLink(goal.dir, goal.seal, {
        ts: input.ts,
        session_id: input.sessionId,
        cause: 'attach',
        kind: 'state',
        state_hash: current.manifest_hash,
        diff_hash: diffHashFor(prevFiles, current.files),
      });
      this.writeManifestHead(goal.dir, current.files, input.ts);
      emitGstvChainLink({
        trace: input.trace,
        session_id: input.sessionId,
        goal_id: goal.goal_id,
        index: link.index,
        kind: 'state',
        cause: 'attach',
        state_fp: fp(link.state_hash),
        diff_fp: fp(link.diff_hash),
        link_fp: fp(link.link_hash),
        prev_fp: fp(link.prev),
        status: 'ok',
      });
    } else {
      const prevFiles = manifestHead?.files ?? this.fallbackMissingManifest(head, input.trace, input.sessionId, goal.goal_id);
      const link = await appendLink(goal.dir, goal.seal, {
        ts: input.ts,
        session_id: input.sessionId,
        cause: 'attach',
        kind: 'gap',
        detector: 'attach_mismatch',
        state_hash: current.manifest_hash,
        diff_hash: diffHashFor(prevFiles, current.files),
      });
      this.writeManifestHead(goal.dir, current.files, input.ts);
      this.emitGapLinkOps({
        trace: input.trace,
        sessionId: input.sessionId,
        goalId: goal.goal_id,
        link,
        path: '-',
        detector: 'attach_mismatch',
        cause: 'attach',
      });
    }

    emitGstvAttach({
      trace: input.trace,
      session_id: input.sessionId,
      goal_id: goal.goal_id,
      match,
      head_fp: fp(headState),
      state_fp: fp(current.manifest_hash),
      status: 'ok',
    });

    return true;
  }

  private async handleToolExecuteAfter(e: SpoolEnvelope, payload: ToolExecuteAfter): Promise<void> {
    const goal = await this.getAttachedGoal(e.session_id);
    if (!goal) {
      return;
    }

    const trace = e.trace_id ?? '-';
    const walk = await walkManifest(goal.meta.repo_root, { cacheFile: walkCachePath(this.root) });
    const prevFiles = this.readManifestHead(goal.dir)?.files ?? this.warnAndFallbackHead(trace, e.session_id, goal.goal_id);
    const link = await appendLink(goal.dir, goal.seal, {
      ts: e.ts,
      session_id: e.session_id,
      cause: payload.call_id,
      kind: 'state',
      state_hash: walk.manifest_hash,
      diff_hash: diffHashFor(prevFiles, walk.files),
    });
    this.writeManifestHead(goal.dir, walk.files, e.ts);

    emitGstvChainLink({
      trace,
      session_id: e.session_id,
      goal_id: goal.goal_id,
      index: link.index,
      kind: 'state',
      cause: payload.call_id,
      state_fp: fp(link.state_hash),
      diff_fp: fp(link.diff_hash),
      link_fp: fp(link.link_hash),
      prev_fp: fp(link.prev),
      status: 'ok',
    });

    this.recentTool.set(e.session_id, { ts: this.now() });

    if (matchesSealedCommand(goal.meta.predicate_command, payload.tool)) {
      await observePredicate(
        goal,
        {
          source: 'tool',
          command: payload.tool,
          exit: payload.exit_code ?? null,
          ts: e.ts,
          session_id: e.session_id,
          trace,
        },
        { root: this.root },
      );
    }
  }

  private async handleCommandExecuted(e: SpoolEnvelope, payload: CommandExecuted): Promise<void> {
    const goal = await this.getAttachedGoal(e.session_id);
    if (!goal) {
      return;
    }
    if (!matchesSealedCommand(goal.meta.predicate_command, payload.command)) {
      return;
    }

    await observePredicate(
      goal,
      {
        source: 'command',
        command: payload.command,
        // SPOOL-V1.md §3: command.executed carries no exit_code (honest absence).
        // Command-source observations therefore cannot satisfy exit===0 close rule;
        // non-contract fields are ignored, not consumed.
        exit: null,
        ts: e.ts,
        session_id: e.session_id,
        trace: e.trace_id ?? '-',
      },
      { root: this.root },
    );
  }

  private async handleBoundaryRun(e: SpoolEnvelope, payload: GstvBoundaryRun): Promise<void> {
    const trace = e.trace_id ?? '-';
    const goal = await loadGoalById(payload.goal_id, { root: this.root });
    if (!goal) {
      logOp('gstv.engine', 'warn', {
        trace,
        session_id: e.session_id,
        event: SPOOL_EVENT.GSTV_BOUNDARY_RUN,
        reason: 'boundary_unknown_goal',
        goal_id: payload.goal_id,
      });
      return;
    }

    const walk = await walkManifest(goal.meta.repo_root, { cacheFile: walkCachePath(this.root) });
    const prevFiles = this.readManifestHead(goal.dir)?.files ?? this.warnAndFallbackHead(trace, e.session_id, goal.goal_id);
    const link = await appendLink(goal.dir, goal.seal, {
      ts: e.ts,
      session_id: e.session_id,
      cause: 'boundary',
      kind: 'state',
      state_hash: walk.manifest_hash,
      diff_hash: diffHashFor(prevFiles, walk.files),
    });
    this.writeManifestHead(goal.dir, walk.files, e.ts);

    emitGstvChainLink({
      trace,
      session_id: e.session_id,
      goal_id: goal.goal_id,
      index: link.index,
      kind: 'state',
      cause: 'boundary',
      state_fp: fp(link.state_hash),
      diff_fp: fp(link.diff_hash),
      link_fp: fp(link.link_hash),
      prev_fp: fp(link.prev),
      status: 'ok',
    });

    await observePredicate(
      goal,
      {
        source: 'boundary',
        command: payload.command,
        exit: payload.exit_code,
        ts: e.ts,
        session_id: e.session_id,
        trace,
      },
      { root: this.root },
    );
  }

  private async handleFileEdited(e: SpoolEnvelope, payload: FileEdited): Promise<void> {
    const goal = await this.getAttachedGoal(e.session_id);
    if (!goal) {
      return;
    }

    const nowTs = this.now();
    const trace = e.trace_id ?? '-';

    if (this.isCorrelated(this.recentTool.get(e.session_id))) {
      this.recentEdit.set(e.session_id, { ts: nowTs });
      return;
    }

    const walk = await walkManifest(goal.meta.repo_root, { cacheFile: walkCachePath(this.root) });
    const prevFiles = this.readManifestHead(goal.dir)?.files ?? this.warnAndFallbackHead(trace, e.session_id, goal.goal_id);
    const link = await appendLink(goal.dir, goal.seal, {
      ts: e.ts,
      session_id: e.session_id,
      cause: 'external',
      kind: 'state',
      state_hash: walk.manifest_hash,
      diff_hash: diffHashFor(prevFiles, walk.files),
    });
    this.writeManifestHead(goal.dir, walk.files, e.ts);

    emitGstvChainLink({
      trace,
      session_id: e.session_id,
      goal_id: goal.goal_id,
      index: link.index,
      kind: 'state',
      cause: 'external',
      state_fp: fp(link.state_hash),
      diff_fp: fp(link.diff_hash),
      link_fp: fp(link.link_hash),
      prev_fp: fp(link.prev),
      status: 'ok',
    });

    this.recentEdit.set(e.session_id, { ts: nowTs });
    void payload.path;
  }

  private async handleWatcherUpdated(e: SpoolEnvelope, payload: FileWatcherUpdated): Promise<void> {
    const goal = await this.getAttachedGoal(e.session_id);
    if (!goal) {
      return;
    }

    if (this.isCorrelated(this.recentTool.get(e.session_id)) || this.isCorrelated(this.recentEdit.get(e.session_id))) {
      return;
    }

    const trace = e.trace_id ?? '-';
    const walk = await walkManifest(goal.meta.repo_root, { cacheFile: walkCachePath(this.root) });
    const prevFiles = this.readManifestHead(goal.dir)?.files ?? this.fallbackMissingManifest(await readChainHead(goal.dir), trace, e.session_id, goal.goal_id);
    const link = await appendLink(goal.dir, goal.seal, {
      ts: e.ts,
      session_id: e.session_id,
      cause: 'external',
      kind: 'gap',
      detector: 'watcher',
      state_hash: walk.manifest_hash,
      diff_hash: diffHashFor(prevFiles, walk.files),
    });
    this.writeManifestHead(goal.dir, walk.files, e.ts);

    this.emitGapLinkOps({
      trace,
      sessionId: e.session_id,
      goalId: goal.goal_id,
      link,
      path: payload.path,
      detector: 'watcher',
      cause: 'external',
    });
  }

  private emitGapLinkOps(input: {
    trace: string;
    sessionId: string;
    goalId: string;
    link: Awaited<ReturnType<typeof appendLink>>;
    path: string;
    detector: 'watcher' | 'attach_mismatch';
    cause: string;
  }): void {
    emitGstvChainLink({
      trace: input.trace,
      session_id: input.sessionId,
      goal_id: input.goalId,
      index: input.link.index,
      kind: 'gap',
      cause: input.cause,
      state_fp: fp(input.link.state_hash),
      diff_fp: fp(input.link.diff_hash),
      link_fp: fp(input.link.link_hash),
      prev_fp: fp(input.link.prev),
      status: 'ok',
    });

    emitGstvGap({
      trace: input.trace,
      session_id: input.sessionId,
      goal_id: input.goalId,
      detector: input.detector,
      path: input.path,
      index: input.link.index,
      link_fp: fp(input.link.link_hash),
      status: 'ok',
    });
  }

  private async getAttachedGoal(sessionId: string) {
    const goalId = this.attachments.get(sessionId);
    if (!goalId) {
      return null;
    }
    return loadGoalById(goalId, { root: this.root });
  }

  private isCorrelated(entry: { ts: number } | undefined): boolean {
    if (!entry) {
      return false;
    }
    const delta = this.now() - entry.ts;
    return delta >= 0 && delta <= CORRELATION_WINDOW_MS;
  }

  private readManifestHead(goalDirPath: string): ManifestHead | null {
    const filePath = path.join(goalDirPath, 'manifest-head.json');
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }

      const candidate = parsed as Partial<ManifestHead>;
      if (candidate.alg !== 'walk-v1' || !Array.isArray(candidate.files) || typeof candidate.updated_at !== 'string') {
        return null;
      }

      for (const row of candidate.files) {
        if (!row || typeof row !== 'object') {
          return null;
        }
        const entry = row as { path?: unknown; sha256?: unknown };
        if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
          return null;
        }
      }

      return candidate as ManifestHead;
    } catch {
      return null;
    }
  }

  private writeManifestHead(goalDirPath: string, files: Array<{ path: string; sha256: string }>, updatedAt: string): void {
    const target = path.join(goalDirPath, 'manifest-head.json');
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const payload: ManifestHead = {
      alg: 'walk-v1',
      files,
      updated_at: updatedAt,
    };

    fs.mkdirSync(goalDirPath, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  }

  private warnAndFallbackHead(trace: string, sessionId: string, goalId: string) {
    logOp('gstv.engine', 'warn', {
      trace,
      session_id: sessionId,
      goal_id: goalId,
      reason: 'head_manifest_missing',
    });
    return null;
  }

  private fallbackMissingManifest(
    chainHead: Awaited<ReturnType<typeof readChainHead>>,
    trace: string,
    sessionId: string,
    goalId: string,
  ) {
    if (chainHead !== null) {
      return this.warnAndFallbackHead(trace, sessionId, goalId);
    }
    return null;
  }
}
