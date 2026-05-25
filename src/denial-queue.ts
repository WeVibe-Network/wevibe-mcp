import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const WEVIBE_DIR = join(homedir(), '.wevibe');
const QUEUE_PATH = join(WEVIBE_DIR, 'pending-denials.json');

function _ensureQueueDir(): void {
  if (!existsSync(WEVIBE_DIR)) {
    mkdirSync(WEVIBE_DIR, { recursive: true });
  }
}

export interface PendingDenial {
  id: string;
  org_id: string;
  memory_hash: string;
  reason?: string;
  created_at: string;
}

function _readQueue(): PendingDenial[] {
  _ensureQueueDir();
  if (!existsSync(QUEUE_PATH)) {
    return [];
  }
  try {
    const data = readFileSync(QUEUE_PATH, 'utf-8');
    return JSON.parse(data) as PendingDenial[];
  } catch {
    console.warn('wevibe-mcp: pending-denials.json corrupt, resetting queue');
    return [];
  }
}

function _writeQueue(denials: PendingDenial[]): void {
  _ensureQueueDir();
  const tmpPath = QUEUE_PATH + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(denials, null, 2));
  renameSync(tmpPath, QUEUE_PATH);
}

export function addDenial(denial: Omit<PendingDenial, 'id' | 'created_at'>): void {
  const denials = _readQueue();
  denials.push({
    ...denial,
    id: randomUUID(),
    created_at: new Date().toISOString(),
  });
  _writeQueue(denials);
}

export function getPendingDenials(): PendingDenial[] {
  return _readQueue();
}

export function removeDenials(ids: string[]): void {
  const denials = _readQueue();
  const filtered = denials.filter(d => !ids.includes(d.id));
  _writeQueue(filtered);
}

export function getPendingCount(): number {
  return _readQueue().length;
}

const HUB_URL = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';

export async function flushDenials(): Promise<{ flushed: number; failed: number }> {
  const denials = getPendingDenials();
  if (denials.length === 0) {
    return { flushed: 0, failed: 0 };
  }

  const successIds: string[] = [];
  const failedIds: string[] = [];

  for (const denial of denials) {
    let authResult: { pubkeyHex: string; headers: Record<string, string> };
    try {
      const { buildWeVibeSignedAuth } = await import('./auth.js');
      authResult = await buildWeVibeSignedAuth();
    } catch {
      failedIds.push(denial.id);
      continue;
    }

    let hubResp: Response;
    try {
      hubResp = await fetch(`${HUB_URL}/v1/orgs/${denial.org_id}/denials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authResult.headers,
        },
        body: JSON.stringify({
          memory_hash: denial.memory_hash,
          nullifier: denial.id,
          reason: denial.reason ?? '',
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      failedIds.push(denial.id);
      continue;
    }

    // 2xx: hub accepted the denial. 4xx: client error — don't retry, remove from queue.
    // 5xx or network failure: leave in queue for next flush cycle.
    if (hubResp.status >= 200 && hubResp.status < 300) {
      successIds.push(denial.id);
    } else if (hubResp.status >= 400 && hubResp.status < 500) {
      successIds.push(denial.id);
    } else {
      failedIds.push(denial.id);
    }
  }

  if (successIds.length > 0) {
    removeDenials(successIds);
  }

  return { flushed: successIds.length, failed: failedIds.length };
}