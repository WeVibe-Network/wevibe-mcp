import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { initCrypto, encryptSymmetric, decryptSymmetric } from './crypto.js';
import { getDeviceKey } from './key-store.js';

const VAULT_DIR = join(homedir(), '.wevibe', 'pending_vault');

let _cryptoInit = false;

async function _ensureCrypto(): Promise<void> {
  if (!_cryptoInit) {
    await initCrypto();
    _cryptoInit = true;
  }
}

export interface PendingEntry {
  submissionHash: string;
  orgId: string;
  epochId: number;
  encryptedDekB64: string;
  taskPreview: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'denied';
}

async function _encryptEntry(entry: PendingEntry): Promise<Buffer> {
  const plaintext = Buffer.from(JSON.stringify(entry), 'utf-8');
  const deviceKey = await getDeviceKey();
  const encrypted = encryptSymmetric(new Uint8Array(plaintext), deviceKey);
  return Buffer.from(encrypted);
}

async function _decryptEntry(path: string): Promise<PendingEntry | null> {
  try {
    const blob = readFileSync(path);
    const deviceKey = await getDeviceKey();
    const decrypted = decryptSymmetric(new Uint8Array(blob), deviceKey);
    return JSON.parse(Buffer.from(decrypted).toString('utf-8')) as PendingEntry;
  } catch {
    return null;
  }
}

async function _ensureVaultDir(): Promise<void> {
  if (!existsSync(VAULT_DIR)) {
    mkdirSync(VAULT_DIR, { recursive: true });
  }
}

function _getEntryPath(submissionHash: string): string {
  return join(VAULT_DIR, `${submissionHash}.bin`);
}

export async function storePendingDek(
  submissionHash: string,
  orgId: string,
  epochId: number,
  dek: Uint8Array,
  taskPreview: string,
): Promise<void> {
  await _ensureCrypto();
  await _ensureVaultDir();

  const deviceKey = await getDeviceKey();
  const encryptedDek = encryptSymmetric(dek, deviceKey);
  const encryptedDekB64 = Buffer.from(encryptedDek).toString('base64');

  const entry: PendingEntry = {
    submissionHash,
    orgId,
    epochId,
    encryptedDekB64,
    taskPreview: taskPreview.slice(0, 100),
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  const path = _getEntryPath(submissionHash);
  const tmpPath = path + '.tmp';
  const encrypted = await _encryptEntry(entry);
  writeFileSync(tmpPath, encrypted);
  renameSync(tmpPath, path);
}

export async function loadPendingDek(submissionHash: string): Promise<Uint8Array | null> {
  await _ensureCrypto();
  const path = _getEntryPath(submissionHash);

  if (!existsSync(path)) {
    return null;
  }

  const entry = await _decryptEntry(path);
  if (!entry) return null;

  const deviceKey = await getDeviceKey();
  const encryptedDekBytes = Buffer.from(entry.encryptedDekB64, 'base64');
  const dek = decryptSymmetric(new Uint8Array(encryptedDekBytes), deviceKey);
  return dek;
}

export async function listPending(orgId?: string): Promise<PendingEntry[]> {
  await _ensureCrypto();
  await _ensureVaultDir();
  const entries: PendingEntry[] = [];

  let files: string[];
  try {
    files = readdirSync(VAULT_DIR).filter((f) => f.endsWith('.bin'));
  } catch {
    return [];
  }

  for (const f of files) {
    const entry = await _decryptEntry(join(VAULT_DIR, f));
    if (!entry) continue;
    if (orgId === undefined || entry.orgId === orgId) {
      entries.push(entry);
    }
  }

  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function updateStatus(submissionHash: string, status: 'pending' | 'approved' | 'denied'): Promise<void> {
  await _ensureCrypto();
  const path = _getEntryPath(submissionHash);

  if (!existsSync(path)) {
    return;
  }

  const entry = await _decryptEntry(path);
  if (!entry) return;

  entry.status = status;
  const tmpPath = path + '.tmp';
  const encrypted = await _encryptEntry(entry);
  writeFileSync(tmpPath, encrypted);
  renameSync(tmpPath, path);
}
