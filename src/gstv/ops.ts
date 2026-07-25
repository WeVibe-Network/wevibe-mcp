import { fp, logOp, type LogLevel } from '../logger.js';
import {
  OP,
  type EpisodeCloseInput,
  type EpisodeOpenInput,
  type GstvExtractionUnlockInput,
  type GstvRunSummaryInput,
  type NegativeReceiptInput,
  type PredicateReceiptInput,
} from './types.js';

const FP8_HEX = /^[0-9a-f]{8}$/;

function ensureFp(value: string): string {
  if (value === '-' || value.length === 0) {
    return '-';
  }
  return FP8_HEX.test(value) ? value : fp(value);
}

export interface GstvSealInput {
  trace: string;
  session_id: string;
  goal_id: string;
  goal_text_fp: string;
  predicate_fp: string;
  state0_fp: string;
  repo_fp: string;
  seal_fp: string;
  ed_pub_fp: string;
  sig_fp: string;
  status: 'ok' | 'err';
  dur_ms: number;
  err?: string;
}

export interface GstvAttachInput {
  trace: string;
  session_id: string;
  goal_id: string;
  match: boolean;
  head_fp: string;
  state_fp: string;
  status: 'ok' | 'err';
  err?: string;
}

export interface GstvChainLinkInput {
  trace: string;
  session_id: string;
  goal_id: string;
  index: number;
  kind: 'state' | 'gap';
  cause: string;
  state_fp: string;
  diff_fp: string;
  link_fp: string;
  prev_fp: string;
  status: 'ok' | 'err';
  err?: string;
}

export interface GstvGapInput {
  trace: string;
  session_id: string;
  goal_id: string;
  detector: 'watcher' | 'attach_mismatch';
  path: string;
  index: number;
  link_fp: string;
  status: 'ok' | 'err';
  err?: string;
}

export interface GstvPredicateObserveInput {
  trace: string;
  session_id: string;
  goal_id: string;
  source: 'tool' | 'command' | 'boundary';
  exit: number | null;
  state_fp: string;
  env_fp: string;
  testfile_match: boolean;
  status: 'ok' | 'err';
  err?: string;
}

export interface GstvGoalCloseInput {
  trace: string;
  session_id: string;
  goal_id: string;
  attempts_to_green: number;
  sessions: number;
  links: number;
  gaps: number;
  red_boundaries: number;
  status: 'ok' | 'err';
  dur_ms: number;
  err?: string;
}

export function emitGstvSeal(f: GstvSealInput): void {
  const level: LogLevel = f.status === 'err' ? 'error' : 'info';
  logOp(OP.SEAL, level, {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    goal_text_fp: ensureFp(f.goal_text_fp),
    predicate_fp: ensureFp(f.predicate_fp),
    state0_fp: ensureFp(f.state0_fp),
    repo_fp: ensureFp(f.repo_fp),
    seal_fp: ensureFp(f.seal_fp),
    ed_pub_fp: ensureFp(f.ed_pub_fp),
    sig_fp: ensureFp(f.sig_fp),
    status: f.status,
    dur_ms: f.dur_ms,
  });
}

export function emitGstvAttach(f: GstvAttachInput): void {
  const level: LogLevel = f.match === false ? 'warn' : 'info';
  logOp(OP.ATTACH, level, {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    match: f.match,
    head_fp: ensureFp(f.head_fp),
    state_fp: ensureFp(f.state_fp),
    status: f.status,
  });
}

export function emitGstvChainLink(f: GstvChainLinkInput): void {
  const level: LogLevel = f.kind === 'gap' ? 'warn' : 'info';
  logOp(OP.CHAIN_LINK, level, {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    index: f.index,
    kind: f.kind,
    cause: f.cause,
    state_fp: ensureFp(f.state_fp),
    diff_fp: ensureFp(f.diff_fp),
    link_fp: ensureFp(f.link_fp),
    prev_fp: ensureFp(f.prev_fp),
    status: f.status,
  });
}

export function emitGstvGap(f: GstvGapInput): void {
  logOp(OP.GAP, 'warn', {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    detector: f.detector,
    path: f.path,
    index: f.index,
    link_fp: ensureFp(f.link_fp),
    status: f.status,
  });
}

export function emitGstvPredicateObserve(f: GstvPredicateObserveInput): void {
  const level: LogLevel = f.testfile_match === false ? 'warn' : 'info';
  logOp(OP.PREDICATE_OBSERVE, level, {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    source: f.source,
    exit: f.exit,
    state_fp: ensureFp(f.state_fp),
    env_fp: ensureFp(f.env_fp),
    testfile_match: f.testfile_match,
    status: f.status,
  });
}

/**
 * attempts_to_green = count of predicate observations up to and including the
 * closing green. In D-GSTV-PREDICATE-DEFAULT context, drifted greens are
 * observations but never close.
 */
export function emitGstvGoalClose(f: GstvGoalCloseInput): void {
  logOp(OP.GOAL_CLOSE, 'info', {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    attempts_to_green: f.attempts_to_green,
    sessions: f.sessions,
    links: f.links,
    gaps: f.gaps,
    red_boundaries: f.red_boundaries,
    status: f.status,
    dur_ms: f.dur_ms,
  });
}

export function emitEpisodeOpen(f: EpisodeOpenInput): void {
  logOp(OP.EPISODE_OPEN, 'info', {
    trace: f.trace,
    session_id: f.session_id,
    episode_id: f.episode_id,
    signal_key: f.signal_key,
    signal_key_mode: f.signal_key_mode,
    source: f.source,
    status: f.status,
  });
}

export function emitEpisodeClose(f: EpisodeCloseInput): void {
  logOp(OP.EPISODE_CLOSE, 'info', {
    trace: f.trace,
    session_id: f.session_id,
    episode_id: f.episode_id,
    signal_key: f.signal_key,
    outcome: f.outcome,
    attempt_diff_fp: ensureFp(f.attempt_diff_fp),
    edits: f.edits,
    coincidental_flip: f.coincidental_flip,
    status: f.status,
  });
}

export function emitGstvExtractionUnlock(f: GstvExtractionUnlockInput): void {
  logOp(OP.EXTRACTION_UNLOCK, 'info', {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    links: f.links,
    gaps: f.gaps,
    episodes: f.episodes,
    receipts_predicate: f.receipts_predicate,
    receipts_negative: f.receipts_negative,
    attempts_to_green: f.attempts_to_green,
    sessions: f.sessions,
    red_boundaries: f.red_boundaries,
    unlock_fp: ensureFp(f.unlock_fp),
    status: f.status,
  });
}

export function emitPredicateReceipt(f: PredicateReceiptInput): void {
  logOp(OP.PREDICATE_RECEIPT, 'info', {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    exit: f.exit,
    env_fp: ensureFp(f.env_fp),
    chain_head_fp: ensureFp(f.chain_head_fp),
    receipt_fp: ensureFp(f.receipt_fp),
    sig_fp: ensureFp(f.sig_fp),
    status: f.status,
  });
}

export function emitNegativeReceipt(f: NegativeReceiptInput): void {
  logOp(OP.NEGATIVE_RECEIPT, 'info', {
    trace: f.trace,
    session_id: f.session_id,
    goal_id: f.goal_id,
    cited_state_fp: ensureFp(f.cited_state_fp),
    receipt_fp: ensureFp(f.receipt_fp),
    sig_fp: ensureFp(f.sig_fp),
    status: f.status,
  });
}

export function emitGstvRunSummary(f: GstvRunSummaryInput): void {
  logOp(OP.RUN_SUMMARY, 'info', {
    trace: f.trace,
    run_id: f.run_id,
    goals: f.goals,
    episodes_open: f.episodes_open,
    episodes_closed: f.episodes_closed,
    coincidental: f.coincidental,
    receipts_predicate: f.receipts_predicate,
    receipts_negative: f.receipts_negative,
    unattributed_vector_only: f.unattributed_vector_only,
    signal_key_mode: f.signal_key_mode,
    status: f.status,
  });
}
