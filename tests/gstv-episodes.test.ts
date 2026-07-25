import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { segmentFailureEpisodes } from '../src/failure-episodes.js';
import {
  appendGoalEpisodeIndex,
  emitEpisodeOps,
  enrichEpisodes,
  episodeIndexRecord,
} from '../src/gstv/episodes.js';
import { OP } from '../src/gstv/types.js';
import type { SubstrateEvent } from '../src/session-substrate.js';

const FP8_HEX = /^[0-9a-f]{8}$/;
const FP8_OR_DASH = /^([0-9a-f]{8}|-)$/;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function readOpLines(logDir: string, op: string): string[] {
  const filePath = path.join(logDir, 'ops', `${op}-${utcDay()}.log`);
  const content = readFileSync(filePath, 'utf8');
  return content.split('\n').filter((line) => line.length > 0);
}

describe('gstv episode enrichment + indexing', () => {
  let prevLogDir: string | undefined;
  let logDir: string;

  beforeEach(() => {
    prevLogDir = process.env.WEVIBE_LOG_DIR;
    logDir = mkdtempSync(path.join(os.tmpdir(), 'gstv-episodes-log-'));
    process.env.WEVIBE_LOG_DIR = logDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevLogDir === undefined) {
      delete process.env.WEVIBE_LOG_DIR;
    } else {
      process.env.WEVIBE_LOG_DIR = prevLogDir;
    }
    vi.resetModules();
  });

  it('enriches resolved/unresolved/coincidental with parsed/raw keys and disclosed diff basis', () => {
    const resolvedEvents: SubstrateEvent[] = [
      {
        kind: 'tool',
        time: 1,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'FAIL src/math.test.ts > adds two numbers',
        exit: 1,
        status: 'completed',
      },
      {
        kind: 'edit',
        time: 2,
        seq: 0,
        file: 'src/math.ts',
        detail: 'SECRET_PATCH_CONTENT replace plus with minus',
      },
      {
        kind: 'tool',
        time: 3,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'PASS src/math.test.ts',
        exit: 0,
        status: 'completed',
      },
    ];

    const unresolvedEvents: SubstrateEvent[] = [
      {
        kind: 'tool',
        time: 10,
        seq: 0,
        name: 'bash',
        input: 'go build ./...',
        output: 'build is broken',
        exit: 1,
        status: 'completed',
      },
      {
        kind: 'edit',
        time: 11,
        seq: 0,
        file: 'src/main.go',
      },
    ];

    const coincidentalEvents: SubstrateEvent[] = [
      {
        kind: 'tool',
        time: 20,
        seq: 0,
        name: 'bash',
        input: 'make test',
        output: 'FAILURES! broken',
        exit: 2,
        status: 'completed',
      },
      {
        kind: 'tool',
        time: 21,
        seq: 0,
        name: 'bash',
        input: 'make test',
        output: 'all good',
        exit: 0,
        status: 'completed',
      },
    ];

    const rawEvents: SubstrateEvent[] = [
      {
        kind: 'tool',
        time: 30,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'failing but unrecognized format from custom runner',
        exit: 1,
        status: 'completed',
      },
    ];

    const resolvedEnriched = enrichEpisodes(segmentFailureEpisodes(resolvedEvents), resolvedEvents);
    const unresolvedEnriched = enrichEpisodes(segmentFailureEpisodes(unresolvedEvents), unresolvedEvents);
    const coincidentalEnriched = enrichEpisodes(segmentFailureEpisodes(coincidentalEvents), coincidentalEvents);
    const rawEnriched = enrichEpisodes(segmentFailureEpisodes(rawEvents), rawEvents);

    expect(resolvedEnriched).toHaveLength(1);
    expect(resolvedEnriched[0]).toMatchObject({
      signal_key: 'test:src/math.test.ts::adds two numbers',
      signal_key_mode: 'parsed',
      framework: 'vitest',
      outcome: 'resolved',
      attempt_diff_basis: 'edit-content',
      edits: 1,
      coincidental_flip: false,
    });
    expect(resolvedEnriched[0]!.attempt_diff_fp).toMatch(FP8_HEX);

    expect(unresolvedEnriched).toHaveLength(1);
    expect(unresolvedEnriched[0]).toMatchObject({
      outcome: 'unresolved',
      attempt_diff_basis: 'edit-refs',
      edits: 1,
    });
    expect(unresolvedEnriched[0]!.attempt_diff_fp).toMatch(FP8_HEX);

    expect(coincidentalEnriched).toHaveLength(1);
    expect(coincidentalEnriched[0]).toMatchObject({
      outcome: 'coincidental',
      coincidental_flip: true,
      attempt_diff_basis: 'none',
      attempt_diff_fp: '-',
      edits: 0,
    });

    expect(rawEnriched).toHaveLength(1);
    expect(rawEnriched[0]).toMatchObject({
      signal_key_mode: 'raw',
      signal_key: 'test:npm test',
    });
  });

  it('emits episode.open + episode.close ops with exact catalog fields and no secret material', () => {
    const events: SubstrateEvent[] = [
      {
        kind: 'tool',
        time: 1,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'FAIL src/app.test.ts > red path',
        exit: 1,
        status: 'completed',
      },
      {
        kind: 'edit',
        time: 2,
        seq: 0,
        file: 'src/app.ts',
        detail: 'SUPER_SECRET_EDIT_CONTENT_DO_NOT_LOG',
      },
      {
        kind: 'tool',
        time: 3,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'PASS src/app.test.ts',
        exit: 0,
        status: 'completed',
      },
    ];

    const episodes = segmentFailureEpisodes(events);
    const enriched = enrichEpisodes(episodes, events);
    emitEpisodeOps(enriched, { trace: 'trace-ep', session_id: 'session-ep' });

    const openLines = readOpLines(logDir, OP.EPISODE_OPEN);
    const closeLines = readOpLines(logDir, OP.EPISODE_CLOSE);
    expect(openLines).toHaveLength(enriched.length);
    expect(closeLines).toHaveLength(enriched.length);

    for (const line of openLines) {
      expect(line).toContain('trace=trace-ep');
      expect(line).toContain('session_id=session-ep');
      expect(line).toContain('episode_id=');
      expect(line).toContain('signal_key=');
      expect(line).toContain('signal_key_mode=');
      expect(line).toContain('source=');
      expect(line).toContain('status=ok');
      expect(line).not.toContain('SUPER_SECRET_EDIT_CONTENT_DO_NOT_LOG');
    }

    for (const line of closeLines) {
      expect(line).toContain('trace=trace-ep');
      expect(line).toContain('session_id=session-ep');
      expect(line).toContain('episode_id=');
      expect(line).toContain('signal_key=');
      expect(line).toContain('outcome=');
      expect(line).toContain('attempt_diff_fp=');
      expect(line).toContain('edits=');
      expect(line).toContain('coincidental_flip=');
      expect(line).toContain('status=ok');
      const fpMatch = line.match(/\battempt_diff_fp=([^\s]+)/);
      expect(fpMatch?.[1] ?? '').toMatch(FP8_OR_DASH);
      expect(line).not.toContain('SUPER_SECRET_EDIT_CONTENT_DO_NOT_LOG');
    }
  });

  it('appends episodes.jsonl index records with enrichment fields including attempt_diff_basis', async () => {
    const goalDirPath = mkdtempSync(path.join(os.tmpdir(), 'gstv-episodes-index-'));
    const events: SubstrateEvent[] = [
      {
        kind: 'tool',
        time: 1,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'FAIL src/index.test.ts > appends index',
        exit: 1,
        status: 'completed',
      },
      {
        kind: 'edit',
        time: 2,
        seq: 0,
        file: 'src/index.ts',
        detail: 'new index content',
      },
      {
        kind: 'tool',
        time: 3,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'PASS src/index.test.ts',
        exit: 0,
        status: 'completed',
      },
    ];

    const enriched = enrichEpisodes(segmentFailureEpisodes(events), events);
    const records = enriched.map((episode) =>
      episodeIndexRecord(episode, 'session-index', '2026-07-26T12:05:00.000Z'));

    await appendGoalEpisodeIndex(goalDirPath, records);
    await appendGoalEpisodeIndex(goalDirPath, records);

    const indexPath = path.join(goalDirPath, 'episodes.jsonl');
    const lines = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(records.length * 2);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.ts).toBe('2026-07-26T12:05:00.000Z');
      expect(parsed.session_id).toBe('session-index');
      expect(typeof parsed.episode_id).toBe('string');
      expect(typeof parsed.signal_key).toBe('string');
      expect(parsed.signal_key_mode === 'parsed' || parsed.signal_key_mode === 'raw').toBe(true);
      expect(typeof parsed.framework).toBe('string');
      expect(typeof parsed.source).toBe('string');
      expect(typeof parsed.outcome).toBe('string');
      expect(typeof parsed.attempt_diff_fp).toBe('string');
      expect(parsed.attempt_diff_basis === 'edit-content'
        || parsed.attempt_diff_basis === 'edit-refs'
        || parsed.attempt_diff_basis === 'none').toBe(true);
      expect(typeof parsed.edits).toBe('number');
      expect(typeof parsed.coincidental_flip).toBe('boolean');
    }
  });

  it('is read-only over segmented episodes (purity pin) and preserves zero-progress gating counts', () => {
    const events: SubstrateEvent[] = [
      {
        kind: 'tool',
        time: 1,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'FAIL src/gate.test.ts > gate works',
        exit: 1,
        status: 'completed',
      },
      {
        kind: 'edit',
        time: 2,
        seq: 0,
        file: 'src/gate.ts',
      },
      {
        kind: 'tool',
        time: 3,
        seq: 0,
        name: 'npm test',
        input: 'npm test',
        output: 'PASS src/gate.test.ts',
        exit: 0,
        status: 'completed',
      },
    ];

    const episodes = segmentFailureEpisodes(events);
    const before = structuredClone(episodes);
    const resolvedBefore = episodes.filter((episode) => episode.resolution === 'resolved').length;

    void enrichEpisodes(episodes, events);

    const resolvedAfter = episodes.filter((episode) => episode.resolution === 'resolved').length;
    expect(episodes).toEqual(before);
    expect(resolvedAfter).toBe(resolvedBefore);
  });
});
