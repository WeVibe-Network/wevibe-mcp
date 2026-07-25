import os from 'node:os';
import path from 'node:path';

export function resolveStateDir(): string {
  return process.env.WEVIBE_BENCH_CONSUMER_STATE_DIR ?? path.join(os.homedir(), '.wevibe', 'state');
}

export function resolveGstvRoot(): string {
  return process.env.WEVIBE_GSTV_ROOT ?? path.join(resolveStateDir(), 'gstv');
}

export function resolveSpoolDirs(): string[] {
  const configured = process.env.WEVIBE_GSTV_SPOOL_DIRS;
  if (configured !== undefined) {
    return configured.split(path.delimiter).filter((entry) => entry.length > 0);
  }
  return [path.join(resolveStateDir(), 'spool')];
}

export function goalsDir(root: string): string {
  return path.join(root, 'goals');
}

export function goalDir(root: string, goalId: string): string {
  return path.join(goalsDir(root), goalId);
}

export function sealPath(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), 'seal.json');
}

export function metaPath(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), 'meta.json');
}

export function chainPath(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), 'chain.jsonl');
}

export function observationsPath(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), 'observations.jsonl');
}

export function closedPath(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), 'closed.json');
}

export function receiptsDirPath(goalDirPath: string): string {
  return path.join(goalDirPath, 'receipts');
}

export function receiptPath(goalDirPath: string, receiptId: string): string {
  return path.join(receiptsDirPath(goalDirPath), `${receiptId}.json`);
}

export function episodesIndexPath(goalDirPath: string): string {
  return path.join(goalDirPath, 'episodes.jsonl');
}

export function extractionUnlockPath(goalDirPath: string): string {
  return path.join(goalDirPath, 'extraction-unlock.json');
}

export function offsetsPath(root: string): string {
  return path.join(root, 'spool-offsets.json');
}

export function walkCachePath(root: string): string {
  return path.join(root, 'walk-cache.json');
}
