import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpoolConsumer } from '../src/gstv/spool.js';

type SpoolRecord = {
  v: string;
  seq: number;
  ts: string;
  session_id: string;
  trace_id: string | null;
  event: string;
  payload: Record<string, unknown>;
};

const FIXTURE_PATH = path.resolve(process.cwd(), 'tests/fixtures/spool-v1.plugin-produced.jsonl');
const EXPECTED_KEYS_IN_ORDER = ['v', 'seq', 'ts', 'session_id', 'trace_id', 'event', 'payload'] as const;

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseFixtureRecords(): { rawLines: string[]; records: SpoolRecord[] } {
  const fileText = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const rawLines = fileText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const records = rawLines.map((line) => JSON.parse(line) as SpoolRecord);
  return { rawLines, records };
}

function payloadKeys(record: SpoolRecord): string[] {
  return Object.keys(record.payload);
}

function expectSubsetKeys(actual: string[], allowed: string[]): void {
  actual.forEach((key) => {
    expect(allowed.includes(key)).toBe(true);
  });
}

describe('gstv/spool conformance tripwire (plugin-produced fixture)', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fixture sanity: 13 ordered spool-v1 envelopes with all event kinds and expected trace_id shape', () => {
    // Authoritative spec: wevibe-meta/workspace/docs/SPOOL-V1.md
    // Fixture bytes are REAL plugin output (regen in wevibe-opencode-plugin:
    // npx tsx plugins/gen-spool-v1-fixture.ts).
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);

    const { rawLines, records } = parseFixtureRecords();
    expect(rawLines).toHaveLength(13);
    expect(records).toHaveLength(13);

    records.forEach((record, index) => {
      expect(Object.keys(record)).toEqual([...EXPECTED_KEYS_IN_ORDER]);
      expect(record.v).toBe('spool-v1');
      expect(record.seq).toBe(index);
    });

    const kinds = new Set(records.map((r) => r.event));
    expect(kinds).toEqual(
      new Set([
        'session.created',
        'session.idle',
        'session.error',
        'tool.execute.before',
        'tool.execute.after',
        'file.edited',
        'file.watcher.updated',
        'lsp.client.diagnostics',
        'command.executed',
        'gstv.attach.attempt',
        'gstv.boundary.run',
      ]),
    );

    records.forEach((record) => {
      if (record.event === 'gstv.attach.attempt' || record.event === 'gstv.boundary.run') {
        expect(typeof record.trace_id).toBe('string');
        expect((record.trace_id as string).length).toBeGreaterThan(0);
        return;
      }
      expect(record.trace_id).toBeNull();
    });
  });

  it('real consumer parse: pollOnce reads all fixture lines in file order', async () => {
    const { rawLines, records } = parseFixtureRecords();
    const root = makeTmpDir('gstv-spool-conformance-');
    cleanupDirs.push(root);

    const spoolDir = path.join(root, 'spool');
    fs.mkdirSync(spoolDir, { recursive: true });
    fs.writeFileSync(path.join(spoolDir, 'spool-v1.jsonl'), `${rawLines.join('\n')}\n`, 'utf8');

    const delivered: SpoolRecord[] = [];
    const consumer = new SpoolConsumer({
      spoolDirs: [spoolDir],
      offsetsFile: path.join(root, 'offsets.json'),
      onEvent: (event) => delivered.push(event as SpoolRecord),
    });

    expect(await consumer.pollOnce()).toEqual({ read: 13, skipped: 0 });
    expect(delivered).toHaveLength(13);
    expect(delivered.map((e) => e.seq)).toEqual(records.map((r) => r.seq));
  });

  it('per-event payload shape guards + truncation and omission pins', () => {
    const { records } = parseFixtureRecords();

    const excerpts: string[] = [];
    records.forEach((record) => {
      const payload = record.payload;
      Object.entries(payload).forEach(([key, value]) => {
        if (key.endsWith('_excerpt') && typeof value === 'string') {
          excerpts.push(value);
        }
      });

      switch (record.event) {
        case 'session.created': {
          const keys = payloadKeys(record);
          expectSubsetKeys(keys, ['directory', 'worktree']);
          expect(typeof payload.directory).toBe('string');
          expect((payload.directory as string).length).toBeGreaterThan(0);
          if (payload.worktree !== undefined) {
            expect(typeof payload.worktree).toBe('string');
          }
          break;
        }

        case 'session.error': {
          expectSubsetKeys(payloadKeys(record), ['message_excerpt']);
          if (payload.message_excerpt !== undefined) {
            expect(typeof payload.message_excerpt).toBe('string');
          }
          break;
        }

        case 'tool.execute.before': {
          expectSubsetKeys(payloadKeys(record), ['call_id', 'tool', 'args_excerpt']);
          expect(typeof payload.call_id).toBe('string');
          expect((payload.call_id as string).length).toBeGreaterThan(0);
          expect(typeof payload.tool).toBe('string');
          expect((payload.tool as string).length).toBeGreaterThan(0);
          if (payload.args_excerpt !== undefined) {
            expect(typeof payload.args_excerpt).toBe('string');
          }
          break;
        }

        case 'tool.execute.after': {
          expectSubsetKeys(payloadKeys(record), ['call_id', 'tool', 'exit_code', 'duration_ms', 'output_excerpt', 'error_excerpt']);
          expect(typeof payload.call_id).toBe('string');
          expect((payload.call_id as string).length).toBeGreaterThan(0);
          expect(typeof payload.tool).toBe('string');
          expect((payload.tool as string).length).toBeGreaterThan(0);
          if (payload.exit_code !== undefined) {
            expect(typeof payload.exit_code).toBe('number');
          }
          if (payload.duration_ms !== undefined) {
            expect(typeof payload.duration_ms).toBe('number');
          }
          if (payload.output_excerpt !== undefined) {
            expect(typeof payload.output_excerpt).toBe('string');
          }
          if (payload.error_excerpt !== undefined) {
            expect(typeof payload.error_excerpt).toBe('string');
          }
          break;
        }

        case 'file.edited': {
          expect(payloadKeys(record)).toEqual(['path']);
          expect(typeof payload.path).toBe('string');
          break;
        }

        case 'file.watcher.updated': {
          expect(payloadKeys(record)).toEqual(['path']);
          expect(typeof payload.path).toBe('string');
          break;
        }

        case 'lsp.client.diagnostics': {
          expectSubsetKeys(payloadKeys(record), ['path', 'serverID', 'diagnostics']);
          expect(typeof payload.path).toBe('string');
          expect((payload.path as string).length).toBeGreaterThan(0);
          expect(typeof payload.serverID).toBe('string');
          expect((payload.serverID as string).length).toBeGreaterThan(0);
          expect(Array.isArray(payload.diagnostics)).toBe(true);
          break;
        }

        case 'command.executed': {
          expectSubsetKeys(payloadKeys(record), ['command', 'args_excerpt']);
          expect(typeof payload.command).toBe('string');
          expect((payload.command as string).length).toBeGreaterThan(0);
          expect('exit_code' in payload).toBe(false);
          if (payload.args_excerpt !== undefined) {
            expect(typeof payload.args_excerpt).toBe('string');
          }
          break;
        }

        case 'gstv.attach.attempt': {
          expect(payloadKeys(record)).toEqual(['goal_id']);
          expect(typeof payload.goal_id).toBe('string');
          expect((payload.goal_id as string).length).toBeGreaterThan(0);
          break;
        }

        case 'gstv.boundary.run': {
          expect(payloadKeys(record)).toEqual(['goal_id', 'command', 'exit_code', 'duration_ms']);
          expect(typeof payload.goal_id).toBe('string');
          expect(typeof payload.command).toBe('string');
          expect(typeof payload.exit_code).toBe('number');
          expect(typeof payload.duration_ms).toBe('number');
          break;
        }

        case 'session.idle': {
          expect(payloadKeys(record)).toEqual([]);
          break;
        }

        default:
          throw new Error(`unexpected event ${record.event}`);
      }
    });

    expect(excerpts.some((excerpt) => excerpt.length === 2060 && excerpt.endsWith('…[truncated]'))).toBe(true);

    const sessionErrorEmptyPayload = records.some((record) => record.event === 'session.error' && payloadKeys(record).length === 0);
    expect(sessionErrorEmptyPayload).toBe(true);
  });
});
