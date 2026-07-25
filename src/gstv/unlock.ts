import fs from 'node:fs';
import path from 'node:path';

import { readChain, readChainHead } from './chain.js';
import { emitGstvExtractionUnlock } from './ops.js';
import { episodesIndexPath, extractionUnlockPath } from './paths.js';
import { writeNegativeReceipt, writePredicateReceipt } from './receipts.js';
import { signalKeyModeAggregate } from './signal-keys.js';
import { loadGoalById } from './store.js';
import { canonicalJson, sha256Hex } from './types.js';

export interface ExtractionUnlockRecord {
  v: 'gstv-unlock-v1';
  goal_id: string;
  closed_at: string;
  links: number;
  gaps: number;
  chain_head: string;
  episodes: unknown[];
  receipts: { predicate_receipt_id: string | null; negative_receipt_ids: string[] };
  attempts_to_green: number;
  sessions: number;
  red_boundaries: number;
  signal_key_mode: 'parsed' | 'raw' | 'mixed' | 'absent';
  tier_upgrade: { from: 'T0'; to: 'T1'; basis: 'predicate_receipt' } | null;
  gaps_disclosed: string[];
}

interface EpisodeRow {
  episode_id?: unknown;
  outcome?: unknown;
  signal_key_mode?: unknown;
  attempt_diff_fp?: unknown;
  cited_files?: unknown;
  cited_file_paths?: unknown;
  cited_paths?: unknown;
  files?: unknown;
  attempt_files?: unknown;
  cited_file?: unknown;
  cited_path?: unknown;
  file?: unknown;
  cited_state_hash?: unknown;
  state_hash?: unknown;
  validation_state_hash?: unknown;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function disclose(errors: string[], gaps: string[], message: string): void {
  errors.push(message);
  gaps.push(message);
}

function discloseGapOnly(gaps: string[], message: string): void {
  gaps.push(message);
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

function loadEpisodes(goalDirPath: string): { episodes: unknown[]; errors: string[] } {
  const indexPath = episodesIndexPath(goalDirPath);
  if (!fs.existsSync(indexPath)) {
    return { episodes: [], errors: [`episodes_index_missing:${indexPath}`] };
  }

  const errors: string[] = [];
  const episodes: unknown[] = [];
  const lines = fs.readFileSync(indexPath, 'utf8').split('\n').filter((line) => line.length > 0);
  lines.forEach((line, idx) => {
    try {
      episodes.push(JSON.parse(line) as unknown);
    } catch {
      errors.push(`episodes_index_corrupt_line:${idx + 1}`);
    }
  });

  return { episodes, errors };
}

function loadClosingManifestSet(goalDirPath: string): Set<string> {
  const filePath = path.join(goalDirPath, 'manifest-head.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest_head_corrupt');
  }
  const candidate = parsed as { files?: unknown };
  if (!Array.isArray(candidate.files)) {
    throw new Error('manifest_head_corrupt');
  }

  const out = new Set<string>();
  for (const row of candidate.files) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('manifest_head_corrupt');
    }
    const filePathValue = (row as { path?: unknown }).path;
    if (typeof filePathValue !== 'string' || filePathValue.length === 0) {
      throw new Error('manifest_head_corrupt');
    }
    out.add(filePathValue);
  }
  return out;
}

function pickStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function deriveCitedFiles(row: EpisodeRow): { files: string[]; basis: string } {
  const listFields: Array<keyof EpisodeRow> = ['cited_files', 'cited_file_paths', 'cited_paths', 'attempt_files', 'files'];
  for (const field of listFields) {
    const files = pickStringList(row[field]);
    if (files.length > 0) {
      return { files: Array.from(new Set(files)), basis: `episode_${field}` };
    }
  }

  const singleFields: Array<keyof EpisodeRow> = ['cited_file', 'cited_path', 'file'];
  for (const field of singleFields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { files: [value.trim()], basis: `episode_${field}` };
    }
  }

  return { files: [], basis: 'episode_attempt_without_file_detail' };
}

function deriveCitedStateHash(row: EpisodeRow, fallbackStateHash: string): { value: string; basis: string } {
  const fields: Array<keyof EpisodeRow> = ['cited_state_hash', 'validation_state_hash', 'state_hash'];
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string' && value.length > 0) {
      return { value, basis: `episode_${field}` };
    }
  }

  return { value: fallbackStateHash, basis: 'closing_chain_head_state_hash' };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label}_timeout`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function runGoalCloseMeasurement(args: {
  goalDirPath: string;
  goalId: string;
  trace: string;
  sessionId?: string;
  closing: { exit: number; attempts_to_green: number; sessions: number; red_boundaries: number };
}): Promise<{ unlock: ExtractionUnlockRecord | null; errors: string[] }> {
  const errors: string[] = [];
  const gaps_disclosed: string[] = [];

  let links = 0;
  let gaps = 0;
  let chainHeadHash = '-';
  let chainHeadStateHash = '-';

  try {
    const chain = await readChain(args.goalDirPath);
    links = chain.filter((link) => link.kind === 'state').length;
    gaps = chain.filter((link) => link.kind === 'gap').length;
  } catch (error) {
    disclose(errors, gaps_disclosed, `chain_read_failed:${asErrorMessage(error)}`);
  }

  try {
    const head = await readChainHead(args.goalDirPath);
    if (!head) {
      disclose(errors, gaps_disclosed, 'chain_head_missing');
    } else {
      chainHeadHash = head.link_hash;
      chainHeadStateHash = head.state_hash;
    }
  } catch (error) {
    disclose(errors, gaps_disclosed, `chain_head_read_failed:${asErrorMessage(error)}`);
  }

  let predicateReceiptId: string | null = null;
  try {
    const loadedGoal = await loadGoalById(args.goalId, { root: path.dirname(path.dirname(args.goalDirPath)) });
    if (!loadedGoal) {
      disclose(errors, gaps_disclosed, 'goal_lookup_failed_for_receipt');
    } else if (chainHeadHash === '-' || chainHeadStateHash === '-') {
      disclose(errors, gaps_disclosed, 'predicate_receipt_skipped_missing_chain_head');
    } else {
      const wrote = await withTimeout(
        writePredicateReceipt(
          args.goalDirPath,
          {
            goal_id: args.goalId,
            exit: args.closing.exit,
            chain_head: chainHeadHash,
            predicate_hash: loadedGoal.seal.predicate_hash,
            state_hash: chainHeadStateHash,
            attempts_to_green: args.closing.attempts_to_green,
          },
          { trace: args.trace, session_id: args.sessionId },
        ),
        1000,
        'predicate_receipt',
      );
      predicateReceiptId = wrote.receipt_id;
    }
  } catch (error) {
    disclose(errors, gaps_disclosed, `predicate_receipt_failed:${asErrorMessage(error)}`);
  }

  const loadedEpisodes = loadEpisodes(args.goalDirPath);
  for (const issue of loadedEpisodes.errors) {
    if (issue.startsWith('episodes_index_missing:')) {
      discloseGapOnly(gaps_disclosed, issue);
      continue;
    }
    disclose(errors, gaps_disclosed, issue);
  }
  const episodes = loadedEpisodes.episodes;

  let closingFiles: Set<string> | null = null;
  try {
    closingFiles = loadClosingManifestSet(args.goalDirPath);
  } catch (error) {
    discloseGapOnly(gaps_disclosed, `closing_manifest_unavailable:${asErrorMessage(error)}`);
  }

  const negativeReceiptIds: string[] = [];
  if (closingFiles !== null) {
    for (const raw of episodes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue;
      }
      const row = raw as EpisodeRow;
      if (row.outcome !== 'unresolved') {
        continue;
      }

      const episodeId = typeof row.episode_id === 'string' ? row.episode_id : null;
      const cited = deriveCitedFiles(row);
      const attemptDiffFp = typeof row.attempt_diff_fp === 'string' ? row.attempt_diff_fp : '-';
      const citedState = deriveCitedStateHash(row, chainHeadStateHash);

      let shouldWrite = false;
      if (cited.files.length > 0) {
        shouldWrite = cited.files.every((filePath) => !closingFiles!.has(filePath));
        if (!shouldWrite) {
          gaps_disclosed.push(
            `negative_receipt_skipped_present_in_final_manifest:episode=${episodeId ?? '-'} basis=${cited.basis}`,
          );
        }
      } else if (attemptDiffFp !== '-') {
        shouldWrite = true;
        gaps_disclosed.push(
          `negative_receipt_basis_disclosure:episode=${episodeId ?? '-'} basis=episode_attempt_without_file_detail`,
        );
      } else {
        gaps_disclosed.push(
          `negative_receipt_skipped_no_file_detail_no_attempt_diff:episode=${episodeId ?? '-'} basis=episode_attempt_without_file_detail`,
        );
      }

      if (!shouldWrite) {
        continue;
      }

      if (citedState.basis !== 'episode_cited_state_hash' && citedState.basis !== 'episode_validation_state_hash' && citedState.basis !== 'episode_state_hash') {
        gaps_disclosed.push(
          `negative_receipt_cited_state_basis_disclosure:episode=${episodeId ?? '-'} basis=${citedState.basis}`,
        );
      }

      try {
        const out = await withTimeout(
          writeNegativeReceipt(
            args.goalDirPath,
            {
              goal_id: args.goalId,
              cited_state_hash: citedState.value,
              cited_episode_id: episodeId,
            },
            { trace: args.trace, session_id: args.sessionId },
          ),
          1000,
          'negative_receipt',
        );
        negativeReceiptIds.push(out.receipt_id);
      } catch (error) {
        disclose(
          errors,
          gaps_disclosed,
          `negative_receipt_failed:episode=${episodeId ?? '-'}:${asErrorMessage(error)}`,
        );
      }
    }
  }

  const signalModes = episodes
    .map((episode) => (episode && typeof episode === 'object' ? (episode as { signal_key_mode?: unknown }).signal_key_mode : undefined))
    .filter((mode): mode is 'parsed' | 'raw' => mode === 'parsed' || mode === 'raw');

  const unlock: ExtractionUnlockRecord = {
    v: 'gstv-unlock-v1',
    goal_id: args.goalId,
    closed_at: new Date().toISOString(),
    links,
    gaps,
    chain_head: chainHeadHash,
    episodes,
    receipts: {
      predicate_receipt_id: predicateReceiptId,
      negative_receipt_ids: negativeReceiptIds,
    },
    attempts_to_green: args.closing.attempts_to_green,
    sessions: args.closing.sessions,
    red_boundaries: args.closing.red_boundaries,
    signal_key_mode: signalKeyModeAggregate(signalModes),
    tier_upgrade:
      predicateReceiptId === null
        ? null
        : {
            from: 'T0',
            to: 'T1',
            basis: 'predicate_receipt',
          },
    gaps_disclosed,
  };

  try {
    writeJsonAtomic(extractionUnlockPath(args.goalDirPath), unlock);
  } catch (error) {
    disclose(errors, gaps_disclosed, `unlock_write_failed:${asErrorMessage(error)}`);
  }

  emitGstvExtractionUnlock({
    trace: args.trace,
    session_id: args.sessionId ?? '-',
    goal_id: args.goalId,
    links,
    gaps,
    episodes: episodes.length,
    receipts_predicate: predicateReceiptId ? 1 : 0,
    receipts_negative: negativeReceiptIds.length,
    attempts_to_green: args.closing.attempts_to_green,
    sessions: args.closing.sessions,
    red_boundaries: args.closing.red_boundaries,
    unlock_fp: sha256Hex(canonicalJson(unlock)),
    status: errors.length > 0 ? 'error' : 'ok',
  });

  return { unlock, errors };
}
