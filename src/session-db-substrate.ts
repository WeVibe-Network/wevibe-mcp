import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { SubstrateEvent } from './session-substrate.js';

/**
 * `node:sqlite` is loaded through a runtime require rather than a static
 * import: it is newer than the builtin-module list bundlers ship with, so a
 * static import gets rewritten to a bare `sqlite` specifier and fails to
 * resolve under the test runner. Resolving it at call time keeps the real
 * builtin in play and adds no dependency.
 */
type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDb;

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

let cachedDatabaseSync: DatabaseSyncCtor | null = null;

function getDatabaseSync(): DatabaseSyncCtor {
  if (cachedDatabaseSync) {
    return cachedDatabaseSync;
  }

  const require = createRequire(import.meta.url);
  const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
  cachedDatabaseSync = mod.DatabaseSync;
  return cachedDatabaseSync;
}

/**
 * Project an OpenCode session database (`message` + `part` rows) into the
 * canonical substrate event stream.
 *
 * D-SESSION-SUBSTRATE: the canonical extraction substrate is the full local
 * session event stream the plugin already captures. The session DB is where
 * that stream is durably persisted, so it — not a side-written JSONL — is the
 * substrate source of truth. This module is the ONE projection the product
 * owns; callers (dashboard Extract, benchmark harness) consume it rather than
 * re-implementing it, so benchmark extraction equals production extraction.
 *
 * Uses the Node builtin `node:sqlite` deliberately: the reader must add no
 * native dependency to a server that is otherwise dependency-light.
 */

interface SessionRow {
  directory: string;
}

interface PartRow {
  pdata: string;
  mdata: string;
  part_time_created: number | string | null;
  message_time_created: number | string | null;
}

const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
const PATCH_TARGET_PREFIXES = ['*** Update File:', '*** Add File:', '*** Delete File:'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableNormalize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry, seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const obj = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      normalized[key] = stableNormalize(obj[key], seen);
    }

    seen.delete(value);
    return normalized;
  }

  return value;
}

function stableSerialize(value: unknown): string {
  try {
    const normalized = stableNormalize(value, new WeakSet<object>());
    const serialized = JSON.stringify(normalized);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return '';
  }
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return parsed;
}

function resolveEventTime(partTime: unknown, messageTime: unknown): number {
  return toEpochMs(partTime) ?? toEpochMs(messageTime) ?? 0;
}

function extractRole(messageData: Record<string, unknown> | null): string | undefined {
  if (!messageData) {
    return undefined;
  }

  const role = messageData.role;
  if (typeof role !== 'string') {
    return undefined;
  }

  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function extractExitCode(state: Record<string, unknown>): number | null | undefined {
  const candidateKeys = ['exit', 'exit_code', 'exitCode'];
  for (const key of candidateKeys) {
    if (!hasOwn(state, key)) {
      continue;
    }

    const value = state[key];
    if (value === null) {
      return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }

    break;
  }

  return undefined;
}

function extractPatchTarget(patchText: string): string | undefined {
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    for (const prefix of PATCH_TARGET_PREFIXES) {
      if (!line.startsWith(prefix)) {
        continue;
      }
      const target = line.slice(prefix.length).trim();
      if (target.length > 0) {
        return target;
      }
    }
  }

  return undefined;
}

function extractEditFilePath(input: unknown): string | undefined {
  if (isRecord(input)) {
    const keys = ['filePath', 'path', 'file', 'filepath', 'file_path', 'targetPath'];
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    const patchKeys = ['patchText', 'patch', 'diff'];
    for (const patchKey of patchKeys) {
      const patchText = input[patchKey];
      if (typeof patchText !== 'string' || patchText.length === 0) {
        continue;
      }

      const patchTarget = extractPatchTarget(patchText);
      if (patchTarget) {
        return patchTarget;
      }
    }

    return undefined;
  }

  if (typeof input === 'string') {
    return extractPatchTarget(input);
  }

  return undefined;
}

function relativizeToSessionDir(filePath: string, sessionDirectory: string): string {
  const trimmedFilePath = filePath.trim();
  if (trimmedFilePath.length === 0) {
    return trimmedFilePath;
  }

  const trimmedSessionDirectory = sessionDirectory.trim();
  if (trimmedSessionDirectory.length === 0) {
    return trimmedFilePath;
  }

  if (!isAbsolute(trimmedFilePath) || !isAbsolute(trimmedSessionDirectory)) {
    return trimmedFilePath;
  }

  const normalizedFilePath = resolve(trimmedFilePath);
  const normalizedSessionDirectory = resolve(trimmedSessionDirectory);
  const relativePath = relative(normalizedSessionDirectory, normalizedFilePath);
  if (
    relativePath.length > 0
    && !relativePath.startsWith('..')
    && !isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return trimmedFilePath;
}

function serializeToolOutput(state: Record<string, unknown>): string | undefined {
  if (!hasOwn(state, 'output')) {
    return undefined;
  }

  const output = state.output;
  if (typeof output === 'string') {
    return output;
  }

  const serialized = stableSerialize(output);
  return serialized.length > 0 ? serialized : undefined;
}

function mapPartRowToEvent(row: PartRow, sessionDirectory: string, seq: number): SubstrateEvent | null {
  const partData = parseJsonRecord(row.pdata);
  if (!partData) {
    return null;
  }

  const messageData = parseJsonRecord(row.mdata);
  const role = extractRole(messageData);
  const time = resolveEventTime(row.part_time_created, row.message_time_created);

  if (partData.type === 'text') {
    if (typeof partData.text !== 'string') {
      return null;
    }

    if (role === 'user') {
      return {
        kind: 'user',
        time,
        seq,
        role: 'user',
        text: partData.text,
      };
    }

    return {
      kind: 'assistant',
      time,
      seq,
      role: 'assistant',
      text: partData.text,
    };
  }

  if (partData.type === 'reasoning') {
    if (typeof partData.text !== 'string') {
      return null;
    }

    return {
      kind: 'reasoning',
      time,
      seq,
      ...(role ? { role } : {}),
      text: partData.text,
    };
  }

  if (partData.type !== 'tool') {
    return null;
  }

  const toolName =
    typeof partData.tool === 'string'
      ? (partData.tool.trim().length > 0 ? partData.tool : 'tool')
      : partData.tool !== undefined && partData.tool !== null
        ? String(partData.tool)
        : 'tool';
  const state = isRecord(partData.state) ? partData.state : {};
  const input = state.input;

  if (EDIT_TOOL_NAMES.has(toolName.toLowerCase())) {
    const detail = stableSerialize(input);
    const event: SubstrateEvent = {
      kind: 'edit',
      time,
      seq,
      name: toolName,
    };

    const sourcePath = extractEditFilePath(input);
    if (sourcePath) {
      event.file = relativizeToSessionDir(sourcePath, sessionDirectory);
    }

    if (detail.length > 0) {
      event.detail = detail;
    }

    return event;
  }

  const toolEvent: SubstrateEvent = {
    kind: 'tool',
    time,
    seq,
    name: toolName,
  };

  const serializedInput = stableSerialize(input);
  if (serializedInput.length > 0) {
    toolEvent.input = serializedInput;
  }

  const serializedOutput = serializeToolOutput(state);
  if (typeof serializedOutput === 'string') {
    toolEvent.output = serializedOutput;
  }

  const exit = extractExitCode(state);
  if (exit !== undefined) {
    toolEvent.exit = exit;
  }

  if (typeof state.status === 'string') {
    toolEvent.status = state.status;
  }

  if (typeof state.error === 'string') {
    toolEvent.error = state.error;
  }

  return toolEvent;
}

export class SessionSubstrateReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionSubstrateReadError';
    this.code = code;
  }
}

/**
 * Resolve the single session id in a session DB.
 *
 * The benchmark drives one cell per database, so exactly one session is the
 * normal case. Zero and many are BOTH hard errors: guessing which session a
 * memory came from would misattribute it, and attribution is a custody
 * property, not a convenience.
 */
export function resolveSoleSessionId(sessionDbPath: string): string {
  const db = openSessionDb(sessionDbPath);
  try {
    const rows = db.prepare('SELECT id FROM session ORDER BY id ASC').all() as { id: string }[];
    if (rows.length === 0) {
      throw new SessionSubstrateReadError(
        'session_db_empty',
        `session database contains no sessions: ${sessionDbPath}`,
      );
    }
    if (rows.length > 1) {
      const ids = rows.map((row) => row.id).join(',');
      throw new SessionSubstrateReadError(
        'session_db_ambiguous',
        `session database contains ${rows.length} sessions (${ids}); pass session_id explicitly`,
      );
    }
    return rows[0].id;
  } finally {
    db.close();
  }
}

function openSessionDb(sessionDbPath: string): SqliteDb {
  const trimmed = sessionDbPath.trim();
  if (trimmed.length === 0) {
    throw new SessionSubstrateReadError('session_db_path_empty', 'session_db_path must be a non-empty path');
  }

  const resolved = resolve(trimmed);
  if (!existsSync(resolved)) {
    throw new SessionSubstrateReadError(
      'session_db_not_found',
      `session database not found: ${resolved}`,
    );
  }

  try {
    const DatabaseSync = getDatabaseSync();
    return new DatabaseSync(resolved, { readOnly: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionSubstrateReadError(
      'session_db_open_failed',
      `unable to open session database ${resolved}: ${detail}`,
    );
  }
}

/**
 * Read a session's substrate events from an OpenCode session database.
 *
 * Throws `SessionSubstrateReadError` rather than returning an empty array when
 * the substrate cannot be read: an empty extraction and an unreadable
 * substrate are different outcomes, and collapsing them lets a broken reader
 * masquerade as a session with nothing to say.
 */
export function readSessionEventsFromDb(
  sessionDbPath: string,
  sessionId: string,
): SubstrateEvent[] {
  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.length === 0) {
    throw new SessionSubstrateReadError('session_id_empty', 'session_id must be a non-empty string');
  }

  const db = openSessionDb(sessionDbPath);
  try {
    const session = db
      .prepare("SELECT COALESCE(directory, '') AS directory FROM session WHERE id = ?")
      .get(normalizedSessionId) as SessionRow | undefined;

    if (!session) {
      throw new SessionSubstrateReadError(
        'session_not_found',
        `session ${normalizedSessionId} not found in ${sessionDbPath}`,
      );
    }

    const rows = db
      .prepare(
        `SELECT
          p.data AS pdata,
          m.data AS mdata,
          p.time_created AS part_time_created,
          m.time_created AS message_time_created
         FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ?
         ORDER BY m.time_created ASC, m.rowid ASC, p.time_created ASC, p.rowid ASC`,
      )
      .all(normalizedSessionId) as unknown as PartRow[];

    const events: SubstrateEvent[] = [];
    rows.forEach((row, seq) => {
      const mapped = mapPartRowToEvent(row, session.directory, seq);
      if (mapped) {
        events.push(mapped);
      }
    });

    return events;
  } finally {
    db.close();
  }
}
