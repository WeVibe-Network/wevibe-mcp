import { createHash } from 'node:crypto';
import os from 'node:os';

import { fp } from '../logger.js';

export const SPOOL_VERSION = 'spool-v1';
export const WALK_VERSION = 'walk-v1';
export const CHAIN_VERSION = 'gstv-chain-v1';
export const SEAL_STATE_ALG = WALK_VERSION;
export const EXCERPT_MAX_CHARS = 2048;
export const CORRELATION_WINDOW_MS = 2000;

export const SPOOL_EVENT = {
  SESSION_CREATED: 'session.created',
  SESSION_IDLE: 'session.idle',
  SESSION_ERROR: 'session.error',
  TOOL_EXECUTE_BEFORE: 'tool.execute.before',
  TOOL_EXECUTE_AFTER: 'tool.execute.after',
  FILE_EDITED: 'file.edited',
  FILE_WATCHER_UPDATED: 'file.watcher.updated',
  LSP_CLIENT_DIAGNOSTICS: 'lsp.client.diagnostics',
  COMMAND_EXECUTED: 'command.executed',
  GSTV_ATTACH_ATTEMPT: 'gstv.attach.attempt',
  GSTV_BOUNDARY_RUN: 'gstv.boundary.run',
} as const;

export type SpoolEventName =
  | 'session.created'
  | 'session.idle'
  | 'session.error'
  | 'tool.execute.before'
  | 'tool.execute.after'
  | 'file.edited'
  | 'file.watcher.updated'
  | 'lsp.client.diagnostics'
  | 'command.executed'
  | 'gstv.attach.attempt'
  | 'gstv.boundary.run';

// Authoritative payload contract: wevibe-meta/workspace/docs/SPOOL-V1.md.
// Conformance tripwire: tests/gstv-spool-conformance.test.ts against
// tests/fixtures/spool-v1.plugin-produced.jsonl
// (regen in wevibe-opencode-plugin: npx tsx plugins/gen-spool-v1-fixture.ts).

export interface SessionCreated {
  directory: string;
  worktree?: string;
}

export interface SessionIdle {}

export interface SessionError {
  message_excerpt?: string;
}

export interface ToolExecuteBefore {
  call_id: string;
  tool: string;
  args_excerpt?: string;
}

export interface ToolExecuteAfter {
  call_id: string;
  tool: string;
  exit_code?: number;
  duration_ms?: number;
  output_excerpt?: string;
  error_excerpt?: string;
}

export interface FileEdited {
  path: string;
}

export interface FileWatcherUpdated {
  path: string;
}

export interface LspClientDiagnostics {
  path: string;
  serverID: string;
  diagnostics: unknown[];
}

export interface CommandExecuted {
  command: string;
  args_excerpt?: string;
}

export interface GstvAttachAttempt {
  goal_id: string;
}

export interface GstvBoundaryRun {
  goal_id: string;
  command: string;
  exit_code: number;
  duration_ms: number;
}

export type SpoolPayload =
  | SessionCreated
  | SessionIdle
  | SessionError
  | ToolExecuteBefore
  | ToolExecuteAfter
  | FileEdited
  | FileWatcherUpdated
  | LspClientDiagnostics
  | CommandExecuted
  | GstvAttachAttempt
  | GstvBoundaryRun;

export interface SpoolEnvelope {
  v: 'spool-v1';
  seq: number;
  ts: string;
  session_id: string;
  trace_id: string | null;
  event: SpoolEventName;
  payload: SpoolPayload;
}

export interface GoalSeal {
  goal_id: string;
  goal_text_hash: string;
  predicate_hash: string;
  state0_hash: string;
  repo_binding: string;
  sealed_at: string;
  contributor_sig: string;
  chain_anchor: null;
  state_alg: 'walk-v1';
}

export interface GoalMeta {
  repo_root: string;
  predicate_command: string;
  predicate_file_paths: Array<{ path: string; sha256: string }>;
  state_alg: string;
  goal_text_fp: string;
}

export interface ChainLink {
  v: 'gstv-chain-v1';
  index: number;
  prev: string;
  state_hash: string;
  diff_hash: string;
  ts: string;
  session_id: string;
  cause: string;
  kind: 'state' | 'gap';
  detector?: 'watcher' | 'attach_mismatch';
  state_alg: string;
  /**
   * linkᵢ = sha256(prev ‖ state_hash ‖ diff_hash ‖ ts ‖ session_id ‖ cause)
   * over UTF-8 with `‖` as a single `\n` separator byte.
   * For each link hash preimage, `prev` is the previous link's `link_hash`
   * (genesis `prev` is `seal.state0_hash`).
   */
  link_hash: string;
}

export interface PredicateObservation {
  goal_id: string;
  ts: string;
  session_id: string;
  source: 'tool' | 'command' | 'boundary';
  command: string;
  exit: number | null;
  state_fp: string;
  env_fp: string;
  testfile_match: boolean;
}

export const OP = {
  SEAL: 'gstv.seal',
  ATTACH: 'gstv.attach',
  CHAIN_LINK: 'gstv.chain.link',
  GAP: 'gstv.gap',
  PREDICATE_OBSERVE: 'gstv.predicate.observe',
  GOAL_CLOSE: 'gstv.goal.close',
  EPISODE_OPEN: 'episode.open',
  EPISODE_CLOSE: 'episode.close',
  EXTRACTION_UNLOCK: 'gstv.extraction.unlock',
  PREDICATE_RECEIPT: 'predicate.receipt',
  NEGATIVE_RECEIPT: 'negative.receipt',
  RUN_SUMMARY: 'gstv.run_summary',
} as const;

export interface EpisodeOpenInput {
  trace: string;
  session_id: string;
  episode_id: string;
  signal_key: string;
  signal_key_mode: 'parsed' | 'raw';
  source: 'tool_error' | 'command_failure' | 'test_failure' | 'user_feedback';
  status: 'ok' | 'error';
  err?: string;
}

export interface EpisodeCloseInput {
  trace: string;
  session_id: string;
  episode_id: string;
  signal_key: string;
  outcome: 'resolved' | 'unresolved' | 'coincidental';
  attempt_diff_fp: string;
  edits: number;
  coincidental_flip: boolean;
  status: 'ok' | 'error';
  err?: string;
}

export interface GstvExtractionUnlockInput {
  trace: string;
  session_id: string;
  goal_id: string;
  links: number;
  gaps: number;
  episodes: number;
  receipts_predicate: number;
  receipts_negative: number;
  attempts_to_green: number;
  sessions: number;
  red_boundaries: number;
  unlock_fp: string;
  status: 'ok' | 'error';
  err?: string;
}

export interface PredicateReceiptInput {
  trace: string;
  session_id: string;
  goal_id: string;
  exit: number;
  env_fp: string;
  chain_head_fp: string;
  receipt_fp: string;
  sig_fp: string;
  status: 'ok' | 'error';
  err?: string;
}

export interface NegativeReceiptInput {
  trace: string;
  session_id: string;
  goal_id: string;
  cited_state_fp: string;
  receipt_fp: string;
  sig_fp: string;
  status: 'ok' | 'error';
  err?: string;
}

export interface GstvRunSummaryInput {
  trace: string;
  run_id: string;
  goals: number;
  episodes_open: number;
  episodes_closed: number;
  coincidental: number;
  receipts_predicate: number;
  receipts_negative: number;
  unattributed_vector_only: number;
  signal_key_mode: 'parsed' | 'raw' | 'mixed' | 'absent';
  status: 'ok' | 'error';
  err?: string;
}

export type GstvGoalRouteResponse =
  | { open: false }
  | {
      open: true;
      goal_id: string;
      goal_text_fp: string;
      predicate: { command: string; file_paths: string[] };
      needs_boundary_run: boolean;
      boundary_reason: string;
    };

export interface GstvSealRouteResponse {
  goal_id: string;
  seal_fp: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (currentValue === null || Array.isArray(currentValue) || typeof currentValue !== 'object') {
      return currentValue;
    }

    const sorted: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(currentValue as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      sorted[key] = v;
    }
    return sorted;
  });
}

export function goalIdFor(input: {
  repo_binding: string;
  goal_text_hash: string;
  sealed_at: string;
  ed_pubkey_hex: string;
}): string {
  return `gstv-${sha256Hex(canonicalJson(input)).slice(0, 16)}`;
}

/**
 * Test-file content hashing is the anti-goalpost mechanism (D-GSTV-PREDICATE-DEFAULT).
 */
export function computePredicateHash(command: string, fileSha256HexSorted: string[]): string {
  return sha256Hex(`${command}\n${fileSha256HexSorted.join('\n')}`);
}

/**
 * Cheap run-environment fingerprint for GSTV.
 */
export function computeEnvFp(): string {
  const envDescriptor = `${process.version}|${process.platform}-${process.arch}|${os.release()}`;
  return fp(envDescriptor);
}
