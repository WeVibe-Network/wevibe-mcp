import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpoolConsumer } from '../src/gstv/spool.js';
import { SPOOL_EVENT, type SpoolEnvelope } from '../src/gstv/types.js';

const SPOOL_FILE_NAME = 'spool-v1.jsonl';

function makeEnvelope(seq: number, event = SPOOL_EVENT.SESSION_CREATED): SpoolEnvelope {
  return {
    v: 'spool-v1',
    seq,
    ts: `2026-07-25T00:00:0${seq}.000Z`,
    session_id: 'sess-1',
    trace_id: null,
    event,
    payload: {},
  };
}

function makeTmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('gstv/spool consumer', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a single spool file and delivers events in file order', async () => {
    const root = makeTmpDir('gstv-spool-basic-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);
    const offsetsFile = path.join(root, 'offsets.json');

    const lines = [makeEnvelope(1), makeEnvelope(2), makeEnvelope(3)].map((value) => JSON.stringify(value));
    writeFileSync(spoolFile, `${lines.join('\n')}\n`, 'utf8');

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({ spoolDirs: [spoolDir], offsetsFile, onEvent: (e) => received.push(e) });

    const result = await consumer.pollOnce();
    expect(result).toEqual({ read: 3, skipped: 0 });
    expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('holds trailing partial line until completed on next poll', async () => {
    const root = makeTmpDir('gstv-spool-partial-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);

    const first = JSON.stringify(makeEnvelope(1));
    const second = JSON.stringify(makeEnvelope(2));
    const splitAt = Math.floor(second.length / 2);

    writeFileSync(spoolFile, `${first}\n${second.slice(0, splitAt)}`, 'utf8');

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({
      spoolDirs: [spoolDir],
      offsetsFile: path.join(root, 'offsets.json'),
      onEvent: (e) => received.push(e),
    });

    expect(await consumer.pollOnce()).toEqual({ read: 1, skipped: 0 });
    expect(received.map((e) => e.seq)).toEqual([1]);

    writeFileSync(spoolFile, `${first}\n${second}\n`, 'utf8');
    expect(await consumer.pollOnce()).toEqual({ read: 1, skipped: 0 });
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('resumes from persisted offsets across consumer instances', async () => {
    const root = makeTmpDir('gstv-spool-resume-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);
    const offsetsFile = path.join(root, 'offsets.json');

    const firstTwo = [makeEnvelope(1), makeEnvelope(2)].map((value) => JSON.stringify(value));
    writeFileSync(spoolFile, `${firstTwo.join('\n')}\n`, 'utf8');

    const received1: SpoolEnvelope[] = [];
    const consumer1 = new SpoolConsumer({ spoolDirs: [spoolDir], offsetsFile, onEvent: (e) => received1.push(e) });
    expect(await consumer1.pollOnce()).toEqual({ read: 2, skipped: 0 });
    expect(received1.map((e) => e.seq)).toEqual([1, 2]);

    const allThree = [makeEnvelope(1), makeEnvelope(2), makeEnvelope(3)].map((value) => JSON.stringify(value));
    writeFileSync(spoolFile, `${allThree.join('\n')}\n`, 'utf8');

    const received2: SpoolEnvelope[] = [];
    const consumer2 = new SpoolConsumer({ spoolDirs: [spoolDir], offsetsFile, onEvent: (e) => received2.push(e) });
    expect(await consumer2.pollOnce()).toEqual({ read: 1, skipped: 0 });
    expect(received2.map((e) => e.seq)).toEqual([3]);
  });

  it('resets offset on truncation and re-reads from start of smaller file', async () => {
    const root = makeTmpDir('gstv-spool-truncate-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);
    const offsetsFile = path.join(root, 'offsets.json');

    const first = JSON.stringify({ ...makeEnvelope(1), payload: { long: 'x'.repeat(200) } });
    writeFileSync(spoolFile, `${first}\n`, 'utf8');

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({ spoolDirs: [spoolDir], offsetsFile, onEvent: (e) => received.push(e) });
    expect(await consumer.pollOnce()).toEqual({ read: 1, skipped: 0 });

    const second = JSON.stringify(makeEnvelope(2));
    writeFileSync(spoolFile, `${second}\n`, 'utf8');

    expect(await consumer.pollOnce()).toEqual({ read: 1, skipped: 0 });
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('skips malformed lines while delivering valid lines around them', async () => {
    const root = makeTmpDir('gstv-spool-malformed-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);

    const fileText = [JSON.stringify(makeEnvelope(1)), '{not-json', JSON.stringify(makeEnvelope(2))].join('\n');
    writeFileSync(spoolFile, `${fileText}\n`, 'utf8');

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({
      spoolDirs: [spoolDir],
      offsetsFile: path.join(root, 'offsets.json'),
      onEvent: (e) => received.push(e),
    });

    expect(await consumer.pollOnce()).toEqual({ read: 2, skipped: 1 });
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('skips lines with wrong envelope version', async () => {
    const root = makeTmpDir('gstv-spool-wrong-v-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);

    const wrong = { ...makeEnvelope(2), v: 'spool-v0' };
    writeFileSync(spoolFile, `${JSON.stringify(makeEnvelope(1))}\n${JSON.stringify(wrong)}\n`, 'utf8');

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({
      spoolDirs: [spoolDir],
      offsetsFile: path.join(root, 'offsets.json'),
      onEvent: (e) => received.push(e),
    });

    expect(await consumer.pollOnce()).toEqual({ read: 1, skipped: 1 });
    expect(received.map((e) => e.seq)).toEqual([1]);
  });

  it('tolerates missing spool file', async () => {
    const root = makeTmpDir('gstv-spool-missing-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({
      spoolDirs: [spoolDir],
      offsetsFile: path.join(root, 'offsets.json'),
      onEvent: (e) => received.push(e),
    });

    expect(await consumer.pollOnce()).toEqual({ read: 0, skipped: 0 });
    expect(received).toEqual([]);
  });

  it('consumes from multiple spool directories', async () => {
    const root = makeTmpDir('gstv-spool-multi-dir-');
    cleanupDirs.push(root);

    const spoolDirA = path.join(root, 'spool-a');
    const spoolDirB = path.join(root, 'spool-b');
    mkdirSync(spoolDirA, { recursive: true });
    mkdirSync(spoolDirB, { recursive: true });

    writeFileSync(path.join(spoolDirA, SPOOL_FILE_NAME), `${JSON.stringify(makeEnvelope(1))}\n`, 'utf8');
    writeFileSync(path.join(spoolDirB, SPOOL_FILE_NAME), `${JSON.stringify(makeEnvelope(2))}\n`, 'utf8');

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({
      spoolDirs: [spoolDirA, spoolDirB],
      offsetsFile: path.join(root, 'offsets.json'),
      onEvent: (e) => received.push(e),
    });

    expect(await consumer.pollOnce()).toEqual({ read: 2, skipped: 0 });
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('persists offsets JSON in expected shape', async () => {
    const root = makeTmpDir('gstv-spool-offsets-shape-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);
    const offsetsFile = path.join(root, 'offsets.json');
    writeFileSync(spoolFile, `${JSON.stringify(makeEnvelope(1))}\n`, 'utf8');

    const consumer = new SpoolConsumer({ spoolDirs: [spoolDir], offsetsFile, onEvent: () => {} });
    expect(await consumer.pollOnce()).toEqual({ read: 1, skipped: 0 });

    const parsed = JSON.parse(readFileSync(offsetsFile, 'utf8')) as {
      v: number;
      files: Record<string, { offset: number; size: number }>;
    };

    expect(parsed.v).toBe(1);
    expect(parsed.files).toHaveProperty(spoolFile);
    expect(parsed.files[spoolFile].offset).toBeGreaterThan(0);
    expect(parsed.files[spoolFile].size).toBeGreaterThan(0);
  });

  it('start/stop timer polling works', async () => {
    const root = makeTmpDir('gstv-spool-timer-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);
    const offsetsFile = path.join(root, 'offsets.json');

    writeFileSync(spoolFile, `${JSON.stringify(makeEnvelope(1))}\n`, 'utf8');

    const received: SpoolEnvelope[] = [];
    const consumer = new SpoolConsumer({
      spoolDirs: [spoolDir],
      offsetsFile,
      onEvent: (e) => received.push(e),
      intervalMs: 25,
    });

    consumer.start();
    await vi.waitFor(() => {
      expect(received.map((e) => e.seq)).toEqual([1]);
    });

    consumer.stop();
    writeFileSync(spoolFile, `${JSON.stringify(makeEnvelope(1))}\n${JSON.stringify(makeEnvelope(2))}\n`, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.map((e) => e.seq)).toEqual([1]);
  });
});
