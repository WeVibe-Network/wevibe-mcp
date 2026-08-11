/**
 * Regression coverage for the session-DB substrate reader.
 *
 * WHY THIS FILE EXISTS: benchmark extraction silently broke for days because
 * the substrate SOURCE diverged from the substrate READER. The serve-driven
 * pivot stopped writing the `*.events.jsonl` files a separate bench-side
 * projection still read, so extraction died before reaching the extractor.
 *
 * D-SESSION-SUBSTRATE §2 requires ONE builder shared by the dashboard Extract
 * path and the benchmark harness. These tests pin that builder against a real
 * `node:sqlite` database so a future change to the projection fails loudly here
 * instead of silently emptying the benchmark's substrate.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SessionSubstrateReadError,
  readSessionEventsFromDb,
  resolveSoleSessionId,
} from '../src/session-db-substrate.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};

let tempDir: string;
let dbPath: string;

const SESSION_ID = 'ses_test_0001';
const SESSION_DIR = '/workspace/project';

function createDb(): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);
  db.close();
}

function insertMessage(id: string, role: string, timeCreated: number): void {
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run(id, SESSION_ID, timeCreated, JSON.stringify({ role }));
  db.close();
}

function insertPart(id: string, messageId: string, timeCreated: number, data: unknown): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, messageId, SESSION_ID, timeCreated, timeCreated, JSON.stringify(data));
  db.close();
}

function insertSession(id: string = SESSION_ID): void {
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run(id, SESSION_DIR);
  db.close();
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wevibe-session-db-'));
  dbPath = join(tempDir, 'opencode.db');
  createDb();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('readSessionEventsFromDb', () => {
  it('projects user, assistant, reasoning, tool and edit parts into substrate events', () => {
    insertSession();
    insertMessage('msg-user', 'user', 1000);
    insertMessage('msg-assistant', 'assistant', 2000);

    insertPart('p1', 'msg-user', 1001, { type: 'text', text: 'fix the failing test' });
    insertPart('p2', 'msg-assistant', 2001, { type: 'reasoning', text: 'the import path is wrong' });
    insertPart('p3', 'msg-assistant', 2002, { type: 'text', text: 'I will correct the import.' });
    insertPart('p4', 'msg-assistant', 2003, {
      type: 'tool',
      tool: 'bash',
      state: { input: { command: 'npm test' }, output: '1 failing', exit: 1, status: 'completed' },
    });
    insertPart('p5', 'msg-assistant', 2004, {
      type: 'tool',
      tool: 'edit',
      state: { input: { filePath: `${SESSION_DIR}/src/index.ts`, oldString: 'a', newString: 'b' } },
    });

    const events = readSessionEventsFromDb(dbPath, SESSION_ID);

    expect(events.map((event) => event.kind)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'tool',
      'edit',
    ]);

    // Reasoning is the signal the pre-pivot JSONL path could not carry on a
    // local transport (it read an OpenRouter-only metadata key), which is the
    // whole reason the substrate source moved to the session DB.
    const reasoning = events.find((event) => event.kind === 'reasoning');
    expect(reasoning?.text).toBe('the import path is wrong');

    const tool = events.find((event) => event.kind === 'tool');
    expect(tool?.name).toBe('bash');
    expect(tool?.exit).toBe(1);
    expect(tool?.status).toBe('completed');
    expect(tool?.output).toBe('1 failing');

    // Edit paths are relativized to the session directory so extracted memories
    // never carry an absolute host path.
    const edit = events.find((event) => event.kind === 'edit');
    expect(edit?.file).toBe('src/index.ts');
  });

  it('orders events by message then part time and assigns dense sequence numbers', () => {
    insertSession();
    insertMessage('msg-b', 'assistant', 5000);
    insertMessage('msg-a', 'user', 1000);
    insertPart('p-late', 'msg-b', 5001, { type: 'text', text: 'second' });
    insertPart('p-early', 'msg-a', 1001, { type: 'text', text: 'first' });

    const events = readSessionEventsFromDb(dbPath, SESSION_ID);

    expect(events.map((event) => event.text)).toEqual(['first', 'second']);
    expect(events.map((event) => event.seq)).toEqual([0, 1]);
  });

  it('throws a typed error when the session id is absent rather than returning an empty stream', () => {
    insertSession();

    // An unreadable substrate and a session with nothing to say are DIFFERENT
    // outcomes. Collapsing them lets a broken reader masquerade as an empty
    // session — exactly the silent failure this WO had to diagnose by hand.
    expect(() => readSessionEventsFromDb(dbPath, 'ses_missing')).toThrowError(SessionSubstrateReadError);
    try {
      readSessionEventsFromDb(dbPath, 'ses_missing');
    } catch (error) {
      expect((error as SessionSubstrateReadError).code).toBe('session_not_found');
    }
  });

  it('throws a typed error when the database file does not exist', () => {
    try {
      readSessionEventsFromDb(join(tempDir, 'absent.db'), SESSION_ID);
      throw new Error('expected a SessionSubstrateReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionSubstrateReadError);
      expect((error as SessionSubstrateReadError).code).toBe('session_db_not_found');
    }
  });

  it('skips parts that carry no substrate signal instead of emitting malformed events', () => {
    insertSession();
    insertMessage('msg-assistant', 'assistant', 1000);
    insertPart('p-step', 'msg-assistant', 1001, { type: 'step-start' });
    insertPart('p-finish', 'msg-assistant', 1002, { type: 'step-finish' });
    insertPart('p-text', 'msg-assistant', 1003, { type: 'text', text: 'kept' });

    const events = readSessionEventsFromDb(dbPath, SESSION_ID);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('assistant');
  });
});

describe('resolveSoleSessionId', () => {
  it('returns the only session id in the database', () => {
    insertSession();
    expect(resolveSoleSessionId(dbPath)).toBe(SESSION_ID);
  });

  it('refuses to guess when the database holds several sessions', () => {
    insertSession('ses_one');
    insertSession('ses_two');

    // Attribution is a custody property: guessing which session a memory came
    // from would misattribute it to the wrong contributor.
    try {
      resolveSoleSessionId(dbPath);
      throw new Error('expected a SessionSubstrateReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionSubstrateReadError);
      expect((error as SessionSubstrateReadError).code).toBe('session_db_ambiguous');
    }
  });

  it('reports an empty database rather than returning a blank id', () => {
    try {
      resolveSoleSessionId(dbPath);
      throw new Error('expected a SessionSubstrateReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionSubstrateReadError);
      expect((error as SessionSubstrateReadError).code).toBe('session_db_empty');
    }
  });
});
