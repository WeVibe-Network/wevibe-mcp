import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { walkManifest, manifestHashFor } from '../src/gstv/walk.js';

function makeTempRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeBytes(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data, 'utf8');
}

function forceMtime(filePath: string, unixMs: number): void {
  const when = new Date(unixMs);
  fs.utimesSync(filePath, when, when);
}

describe('gstv/walk walk-v1 manifest hasher', () => {
  it('is deterministic and sorted regardless of creation order', async () => {
    const repoA = makeTempRepo('gstv-walk-det-a-');
    const repoB = makeTempRepo('gstv-walk-det-b-');

    writeBytes(path.join(repoA, 'z.txt'), 'zeta\n');
    writeBytes(path.join(repoA, 'a', 'x.txt'), 'alpha\n');
    writeBytes(path.join(repoA, 'a', 'b.txt'), 'beta\n');

    writeBytes(path.join(repoB, 'a', 'b.txt'), 'beta\n');
    writeBytes(path.join(repoB, 'a', 'x.txt'), 'alpha\n');
    writeBytes(path.join(repoB, 'z.txt'), 'zeta\n');

    const runA = await walkManifest(repoA, { useCache: false });
    const runB = await walkManifest(repoB, { useCache: false });

    expect(runA.files.map((entry) => entry.path)).toEqual(['a/b.txt', 'a/x.txt', 'z.txt']);
    expect(runB.files).toEqual(runA.files);
    expect(runB.manifest_hash).toBe(runA.manifest_hash);
    expect(runA.manifest_hash).toBe(manifestHashFor(runA.files));
  });

  it('matches a known manifest hash vector for a tiny fixed tree', async () => {
    const repo = makeTempRepo('gstv-walk-vector-');
    writeBytes(path.join(repo, 'a.txt'), 'alpha\n');
    writeBytes(path.join(repo, 'dir', 'b.txt'), 'beta\n');

    const result = await walkManifest(repo, { useCache: false });
    expect(result.files).toEqual([
      {
        path: 'a.txt',
        sha256: 'b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060',
      },
      {
        path: 'dir/b.txt',
        sha256: 'f2c82decdd7181cf98945929a62598db7e6b477e11f6e0eb0ae97020eff151ad',
      },
    ]);
    expect(result.manifest_hash).toBe('6efe41a0ce351ba30ab97f723a84eec4157b8318d567f7d9b3f63888b9334bfb');
  });

  it('applies ignore rules and always ignores .git', async () => {
    const repo = makeTempRepo('gstv-walk-ignore-');
    writeBytes(path.join(repo, '.gitignore'), ['*.log', 'node_modules/', '/build', '!keep.log'].join('\n'));
    writeBytes(path.join(repo, 'nested', '.gitignore'), ['*.tmp', '!keep.tmp'].join('\n'));

    writeBytes(path.join(repo, 'keep.log'), 'keep\n');
    writeBytes(path.join(repo, 'drop.log'), 'drop\n');
    writeBytes(path.join(repo, 'build', 'artifact.txt'), 'build\n');
    writeBytes(path.join(repo, 'src', 'build', 'nested-ok.txt'), 'ok\n');
    writeBytes(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module\n');
    writeBytes(path.join(repo, 'nested', 'drop.tmp'), 'tmp\n');
    writeBytes(path.join(repo, 'nested', 'keep.tmp'), 'tmp-keep\n');
    writeBytes(path.join(repo, '.git', 'config'), '[core]\n');

    const result = await walkManifest(repo, { useCache: false });
    expect(result.files.map((entry) => entry.path)).toEqual(['.gitignore', 'keep.log', 'nested/.gitignore', 'nested/keep.tmp', 'src/build/nested-ok.txt']);
  });

  it('skips symlinks instead of following them', async () => {
    const repo = makeTempRepo('gstv-walk-symlink-');
    writeBytes(path.join(repo, 'real.txt'), 'real\n');
    fs.symlinkSync('real.txt', path.join(repo, 'real-link.txt'));

    const result = await walkManifest(repo, { useCache: false });
    expect(result.files.map((entry) => entry.path)).toEqual(['real.txt']);
  });

  it('uses cache, invalidates on single-file change, and preserves hash on mtime-only touch', async () => {
    const repo = makeTempRepo('gstv-walk-cache-');
    const cacheFile = path.join(repo, '.cache', 'walk-cache.json');

    const fileA = path.join(repo, 'a.txt');
    const fileB = path.join(repo, 'b.txt');
    const fileC = path.join(repo, 'c.txt');
    writeBytes(fileA, 'A1\n');
    writeBytes(fileB, 'B1\n');
    writeBytes(fileC, 'C1\n');

    const run1 = await walkManifest(repo, { cacheFile, useCache: true });
    expect(run1.stats.total).toBe(3);
    expect(run1.stats.recomputed).toBe(3);
    expect(run1.stats.reused).toBe(0);

    const run2 = await walkManifest(repo, { cacheFile, useCache: true });
    expect(run2.stats.total).toBe(3);
    expect(run2.stats.reused).toBe(3);
    expect(run2.stats.recomputed).toBe(0);
    expect(run2.files).toEqual(run1.files);
    expect(run2.manifest_hash).toBe(run1.manifest_hash);

    const oldB = run2.files.find((entry) => entry.path === 'b.txt')?.sha256;
    writeBytes(fileB, 'B2\n');
    forceMtime(fileB, Date.now() + 5000);

    const run3 = await walkManifest(repo, { cacheFile, useCache: true });
    expect(run3.stats.total).toBe(3);
    expect(run3.stats.recomputed).toBe(1);
    expect(run3.stats.reused).toBe(2);
    const newB = run3.files.find((entry) => entry.path === 'b.txt')?.sha256;
    expect(newB).toBeDefined();
    expect(newB).not.toBe(oldB);

    const beforeTouchA = run3.files.find((entry) => entry.path === 'a.txt')?.sha256;
    forceMtime(fileA, Date.now() + 10000);
    const run4 = await walkManifest(repo, { cacheFile, useCache: true });
    expect(run4.stats.total).toBe(3);
    expect(run4.stats.recomputed).toBe(1);
    expect(run4.stats.reused).toBe(2);
    const afterTouchA = run4.files.find((entry) => entry.path === 'a.txt')?.sha256;
    expect(afterTouchA).toBe(beforeTouchA);
  });

  it('prunes cache entries for deleted files and supports useCache:false', async () => {
    const repo = makeTempRepo('gstv-walk-prune-');
    const cacheFile = path.join(repo, '.cache', 'walk-cache.json');

    writeBytes(path.join(repo, 'keep.txt'), 'keep\n');
    const removePath = path.join(repo, 'remove.txt');
    writeBytes(removePath, 'remove\n');

    const initial = await walkManifest(repo, { cacheFile, useCache: true });
    expect(initial.stats.total).toBe(2);

    fs.unlinkSync(removePath);
    const afterDelete = await walkManifest(repo, { cacheFile, useCache: true });
    expect(afterDelete.files.map((entry) => entry.path)).toEqual(['keep.txt']);

    const cacheDoc = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
      v: number;
      repos: Record<string, Record<string, { sha256: string; mtimeMs: number; size: number }>>;
    };
    const repoKey = path.resolve(repo);
    expect(cacheDoc.v).toBe(1);
    expect(Object.keys(cacheDoc.repos[repoKey] ?? {}).sort()).toEqual(['keep.txt']);

    const noCacheFile = path.join(repo, '.cache', 'no-cache.json');
    const noCacheA = await walkManifest(repo, { cacheFile: noCacheFile, useCache: false });
    const noCacheB = await walkManifest(repo, { cacheFile: noCacheFile, useCache: false });
    expect(noCacheA.stats.recomputed).toBe(noCacheA.stats.total);
    expect(noCacheB.stats.recomputed).toBe(noCacheB.stats.total);
    expect(fs.existsSync(noCacheFile)).toBe(false);
  });
});
