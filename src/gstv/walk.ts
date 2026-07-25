import fs from 'node:fs';
import path from 'node:path';

import { walkCachePath } from './paths.js';
import { sha256Hex } from './types.js';
import { loadIgnoreMatcher } from './gitignore.js';

export interface WalkResult {
  alg: 'walk-v1';
  files: Array<{ path: string; sha256: string }>;
  manifest_hash: string;
  stats: { total: number; reused: number; recomputed: number };
}

interface CacheFile {
  v: 1;
  repos: Record<string, Record<string, { sha256: string; mtimeMs: number; size: number }>>;
}

/**
 * Canonical manifest form for walk-v1:
 * sha256Hex(files.map(f => f.path + '\n' + f.sha256).join('\n'))
 *
 * Input MUST already be repo-relative, `/`-separated, and byte-wise path sorted.
 */
export function manifestHashFor(files: Array<{ path: string; sha256: string }>): string {
  return sha256Hex(files.map((entry) => `${entry.path}\n${entry.sha256}`).join('\n'));
}

function normalizeRelPath(absPath: string, repoRoot: string): string {
  return path.relative(repoRoot, absPath).replaceAll(path.sep, '/');
}

function readCache(cacheFile: string): CacheFile | undefined {
  if (!fs.existsSync(cacheFile)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1 ||
      typeof (parsed as { repos?: unknown }).repos !== 'object' ||
      (parsed as { repos?: unknown }).repos === null
    ) {
      return undefined;
    }
    return parsed as CacheFile;
  } catch {
    return undefined;
  }
}

function writeCacheAtomic(cacheFile: string, payload: CacheFile): void {
  const dir = path.dirname(cacheFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmpPath, cacheFile);
}

/**
 * walk-v1 performs a full stat-based directory scan each call, then hashes only changed files.
 * Incremental hashing cost is therefore O(changed files) while scan cost remains O(total entries).
 * Symlinks are never followed and never hashed.
 */
export async function walkManifest(
  repoRoot: string,
  opts?: { cacheFile?: string; useCache?: boolean },
): Promise<WalkResult> {
  const rootAbs = path.resolve(repoRoot);
  const cachePath = opts?.cacheFile ?? walkCachePath(rootAbs);
  const cacheAbs = path.resolve(cachePath);
  const useCache = opts?.useCache ?? true;
  const repoCacheKey = rootAbs;

  const ignore = loadIgnoreMatcher(rootAbs);

  const existing = useCache ? readCache(cachePath) : undefined;
  const cacheDoc: CacheFile = existing ?? { v: 1, repos: {} };
  const priorRepoCache = cacheDoc.repos[repoCacheKey] ?? {};
  const nextRepoCache: Record<string, { sha256: string; mtimeMs: number; size: number }> = {};

  const files: Array<{ path: string; sha256: string }> = [];
  let reused = 0;
  let recomputed = 0;

  const walkDir = (absDir: string): void => {
    const dirents = fs.readdirSync(absDir, { withFileTypes: true });
    dirents.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));

    for (const dirent of dirents) {
      const absPath = path.join(absDir, dirent.name);
      const relPath = normalizeRelPath(absPath, rootAbs);
      const lst = fs.lstatSync(absPath);

      if (lst.isSymbolicLink()) {
        continue;
      }

      if (lst.isDirectory()) {
        if (ignore(relPath, true)) {
          continue;
        }
        walkDir(absPath);
        continue;
      }

      if (!lst.isFile()) {
        continue;
      }

      if (path.resolve(absPath) === cacheAbs) {
        continue;
      }

      if (ignore(relPath, false)) {
        continue;
      }

      const prior = priorRepoCache[relPath];
      let digest: string;
      if (prior !== undefined && prior.mtimeMs === lst.mtimeMs && prior.size === lst.size) {
        digest = prior.sha256;
        reused += 1;
      } else {
        digest = sha256Hex(fs.readFileSync(absPath));
        recomputed += 1;
      }

      files.push({ path: relPath, sha256: digest });
      nextRepoCache[relPath] = { sha256: digest, mtimeMs: lst.mtimeMs, size: lst.size };
    }
  };

  walkDir(rootAbs);
  files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));

  if (useCache) {
    cacheDoc.repos[repoCacheKey] = nextRepoCache;
    writeCacheAtomic(cachePath, cacheDoc);
  }

  return {
    alg: 'walk-v1',
    files,
    manifest_hash: manifestHashFor(files),
    stats: {
      total: files.length,
      reused,
      recomputed,
    },
  };
}
