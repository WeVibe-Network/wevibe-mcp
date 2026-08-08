import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PendingServeRefEntry {
  orgId: string;
  episodeRef: string;
  memoryHashHex: string;
  epoch: number;
  serveRefHex: string;
}

interface ServeRefStoreFile {
  entries: PendingServeRefEntry[];
}

function resolveWevibeDir(): string {
  if (process.env.WEVIBE_SERVE_REF_STORE_DIR && process.env.WEVIBE_SERVE_REF_STORE_DIR.trim().length > 0) {
    return process.env.WEVIBE_SERVE_REF_STORE_DIR;
  }
  if (process.env.WEVIBE_KEYSTORE_PATH && process.env.WEVIBE_KEYSTORE_PATH.trim().length > 0) {
    return dirname(process.env.WEVIBE_KEYSTORE_PATH);
  }
  if (process.env.WEVIBE_KEYSTORE_TEST === '1') {
    return join(tmpdir(), `wevibe-mcp-serve-refs-test-${process.pid}`);
  }
  return join(homedir(), '.wevibe');
}

function storePath(): string {
  return join(resolveWevibeDir(), 'pending-serve-refs.json');
}

function _ensureStoreDir(): void {
  const dir = resolveWevibeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function _readStore(): PendingServeRefEntry[] {
  _ensureStoreDir();
  const path = storePath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ServeRefStoreFile> | PendingServeRefEntry[];
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    console.warn('wevibe-mcp: pending-serve-refs.json corrupt, resetting store');
    return [];
  }
}

function _writeStore(entries: PendingServeRefEntry[]): void {
  _ensureStoreDir();
  const path = storePath();
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ entries }, null, 2));
  renameSync(tmpPath, path);
}

function keyMatches(entry: PendingServeRefEntry, orgId: string, episodeRef: string): boolean {
  return entry.orgId === orgId && entry.episodeRef === episodeRef;
}

/**
 * Durable memo for serves awaiting an outcome, keyed by episode. Stores only
 * non-content-bearing pairing identifiers: org id, episode ref, memory hash
 * hex, epoch, and serve_ref hex.
 */
export function recordServeRef(entry: PendingServeRefEntry): void {
  const entries = _readStore();
  const existingIndex = entries.findIndex(candidate => keyMatches(candidate, entry.orgId, entry.episodeRef));
  if (existingIndex === -1) {
    entries.push(entry);
  } else if (entry.epoch >= entries[existingIndex].epoch) {
    entries[existingIndex] = entry;
  }
  _writeStore(entries);
}

export function consumeServeRef(orgId: string, episodeRef: string): { epoch: number; serveRefHex: string } | undefined {
  const entries = _readStore();
  const existingIndex = entries.findIndex(candidate => keyMatches(candidate, orgId, episodeRef));
  if (existingIndex === -1) {
    return undefined;
  }
  const [entry] = entries.splice(existingIndex, 1);
  _writeStore(entries);
  return { epoch: entry.epoch, serveRefHex: entry.serveRefHex };
}

export function peekServeRef(orgId: string, episodeRef: string): { epoch: number; serveRefHex: string } | undefined {
  const entry = _readStore().find(candidate => keyMatches(candidate, orgId, episodeRef));
  return entry ? { epoch: entry.epoch, serveRefHex: entry.serveRefHex } : undefined;
}
