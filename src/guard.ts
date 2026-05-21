import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WeVibeGuardDetection {
  field: string;
  scanner: string;
  rule: string;
  matched: string;
}

export interface WeVibeGuardResult {
  passed: boolean;
  detections: WeVibeGuardDetection[];
  flags: string[] | null;
}

export function getGuardBin(): string {
  if (process.env.WEVIBE_GUARD_BIN) {
    return process.env.WEVIBE_GUARD_BIN;
  }
  const releasePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../wevibe-guard/target/release/wevibe-guard'
  );
  if (existsSync(releasePath)) return releasePath;
  return 'wevibe-guard';
}

export function runWeVibeGuard(
  text: string,
  keywords: string[],
  metadata: Record<string, string>,
  options?: { includeFlags?: boolean; stack?: string[] },
): WeVibeGuardResult {
  const guardBin = getGuardBin();
  const input = {
    memory: { text, keywords, metadata },
    stack: options?.stack ?? [],
    include_flags: options?.includeFlags ?? false,
  };
  const result = spawnSync(guardBin, [], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`wevibe-guard unavailable: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout) as WeVibeGuardResult;
}
