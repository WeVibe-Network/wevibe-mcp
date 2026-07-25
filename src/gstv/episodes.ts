import fs from 'node:fs/promises';

import type { FailureEpisode } from '../failure-episodes.js';
import type { SubstrateEvent } from '../session-substrate.js';
import { emitEpisodeClose, emitEpisodeOpen } from './ops.js';
import { episodesIndexPath } from './paths.js';
import { canonicalizeSignalKey } from './signal-keys.js';
import { canonicalJson, sha256Hex } from './types.js';

export interface EpisodeEnrichment {
  episode_id: string;
  signal_key: string;
  signal_key_mode: 'parsed' | 'raw';
  framework: string;
  source: 'tool_error' | 'command_failure' | 'test_failure' | 'user_feedback';
  outcome: 'resolved' | 'unresolved' | 'coincidental';
  attempt_diff_fp: string;
  attempt_diff_basis: 'edit-content' | 'edit-refs' | 'none';
  edits: number;
  coincidental_flip: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeFile(file: unknown): string {
  return asString(file).trim();
}

function orderEvents(events: SubstrateEvent[]): SubstrateEvent[] {
  return (Array.isArray(events) ? events : [])
    .map((event, inputOrder) => ({ event, inputOrder }))
    .sort((left, right) => {
      if (left.event.time !== right.event.time) {
        return left.event.time - right.event.time;
      }
      if (left.event.seq !== right.event.seq) {
        return left.event.seq - right.event.seq;
      }
      return left.inputOrder - right.inputOrder;
    })
    .map(({ event }) => event);
}

function attemptDiff(episode: FailureEpisode, orderedEvents: SubstrateEvent[]): {
  attempt_diff_fp: string;
  attempt_diff_basis: 'edit-content' | 'edit-refs' | 'none';
} {
  if (episode.attemptEdits.length === 0) {
    return { attempt_diff_fp: '-', attempt_diff_basis: 'none' };
  }

  const editsWithEvent = episode.attemptEdits.map((attempt) => {
    const event = orderedEvents[attempt.eventIndex];
    const file = normalizeFile(attempt.file ?? event?.file);
    const content = asString(event?.detail);
    return {
      eventIndex: attempt.eventIndex,
      file,
      content,
    };
  });

  const hasContent = editsWithEvent.some((edit) => edit.content.length > 0);
  if (hasContent) {
    const doc = editsWithEvent.map((edit) => ({
      eventIndex: edit.eventIndex,
      file: edit.file,
      content: edit.content,
    }));
    return {
      attempt_diff_fp: sha256Hex(canonicalJson(doc)).slice(0, 8),
      attempt_diff_basis: 'edit-content',
    };
  }

  const doc = editsWithEvent.map((edit) => ({
    eventIndex: edit.eventIndex,
    file: edit.file,
  }));
  return {
    attempt_diff_fp: sha256Hex(canonicalJson(doc)).slice(0, 8),
    attempt_diff_basis: 'edit-refs',
  };
}

export function enrichEpisodes(episodes: FailureEpisode[], events: SubstrateEvent[]): EpisodeEnrichment[] {
  const orderedEvents = orderEvents(events);

  return episodes.map((episode) => {
    const canonical = canonicalizeSignalKey({
      kind: episode.signal.kind,
      label: episode.signal.label,
      excerpt: episode.signal.excerpt || episode.validationExcerpt,
    });
    const diff = attemptDiff(episode, orderedEvents);

    return {
      episode_id: episode.id,
      signal_key: canonical.key,
      signal_key_mode: canonical.mode,
      framework: canonical.framework,
      source: episode.signal.kind,
      outcome: episode.resolution,
      attempt_diff_fp: diff.attempt_diff_fp,
      attempt_diff_basis: diff.attempt_diff_basis,
      edits: episode.attemptEdits.length,
      coincidental_flip: episode.resolution === 'coincidental',
    };
  });
}

export function episodeIndexRecord(e: EpisodeEnrichment, sessionId: string, ts: string): Record<string, unknown> {
  return {
    ts,
    session_id: sessionId,
    episode_id: e.episode_id,
    signal_key: e.signal_key,
    signal_key_mode: e.signal_key_mode,
    framework: e.framework,
    source: e.source,
    outcome: e.outcome,
    attempt_diff_fp: e.attempt_diff_fp,
    attempt_diff_basis: e.attempt_diff_basis,
    edits: e.edits,
    coincidental_flip: e.coincidental_flip,
  };
}

export async function appendGoalEpisodeIndex(goalDirPath: string, records: Record<string, unknown>[]): Promise<void> {
  if (records.length === 0) {
    return;
  }

  await fs.mkdir(goalDirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(goalDirPath, 0o700);
  } catch {
    // best-effort on non-POSIX platforms
  }

  const target = episodesIndexPath(goalDirPath);
  const payload = `${records.map((record) => canonicalJson(record)).join('\n')}\n`;
  await fs.appendFile(target, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(target, 0o600);
  } catch {
    // best-effort on non-POSIX platforms
  }
}

export function emitEpisodeOps(enriched: EpisodeEnrichment[], ctx: { trace: string; session_id?: string }): void {
  const sessionId = ctx.session_id ?? '-';
  for (const episode of enriched) {
    emitEpisodeOpen({
      trace: ctx.trace,
      session_id: sessionId,
      episode_id: episode.episode_id,
      signal_key: episode.signal_key,
      signal_key_mode: episode.signal_key_mode,
      source: episode.source,
      status: 'ok',
    });
    emitEpisodeClose({
      trace: ctx.trace,
      session_id: sessionId,
      episode_id: episode.episode_id,
      signal_key: episode.signal_key,
      outcome: episode.outcome,
      attempt_diff_fp: episode.attempt_diff_fp,
      edits: episode.edits,
      coincidental_flip: episode.coincidental_flip,
      status: 'ok',
    });
  }
}
