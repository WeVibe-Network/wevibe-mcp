import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeFingerprint,
  normalizeGitUrl,
  resolveRoot,
  writeMarker,
  type OrgMarker,
} from '../src/cli/bind.js';

const cleanupPaths: string[] = [];
const testFilePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(testFilePath), '..');
const bindCliPath = path.join(repoRoot, 'src', 'cli', 'bind.ts');
const keyStorePath = path.join(repoRoot, 'src', 'key-store.ts');

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

const expectedGitignore = '*\n!.gitignore\n!org.json\n';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGitRepo(originUrl?: string): string {
  const repo = makeTempDir('wevibe-bind-repo-');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'bind-test@wevibe.local']);
  git(repo, ['config', 'user.name', 'WeVibe Bind Test']);

  writeFileSync(path.join(repo, 'README.md'), '# bind test\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);

  if (originUrl) {
    git(repo, ['remote', 'add', 'origin', originUrl]);
  }

  return repo;
}

afterEach(() => {
  for (const target of [...cleanupPaths].sort((a, b) => b.length - a.length)) {
    rmSync(target, { recursive: true, force: true });
  }
  cleanupPaths.length = 0;
});

describe('bind CLI helper functions', () => {
  it('normalizes git URLs to one canonical host/path form', () => {
    const cases: Array<{ input: string; expected: string }> = [
      { input: 'https://github.com/Org/Repo.git', expected: 'github.com/Org/Repo' },
      { input: 'git@github.com:Org/Repo.git', expected: 'github.com/Org/Repo' },
      { input: 'https://user:token@github.com/Org/Repo', expected: 'github.com/Org/Repo' },
      { input: 'ssh://git@github.com:22/Org/Repo.git', expected: 'github.com/Org/Repo' },
      { input: 'https://GitHub.com/Org/Repo', expected: 'github.com/Org/Repo' },
    ];

    for (const entry of cases) {
      expect(normalizeGitUrl(entry.input)).toBe(entry.expected);
    }

    const fingerprints = cases.map(entry => sha256Hex(normalizeGitUrl(entry.input)));
    expect(new Set(fingerprints).size).toBe(1);
  });

  it('produces identical origin-based fingerprint across worktrees and propagates committed marker', () => {
    const repo = initGitRepo('https://github.com/Test/Repo.git');
    const mainFingerprint = computeFingerprint(repo, true);
    expect(mainFingerprint.source).toBe('origin');
    expect(mainFingerprint.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const worktreeOne = path.join(tmpdir(), `wevibe-bind-worktree-${randomUUID()}`);
    cleanupPaths.push(worktreeOne);
    git(repo, ['worktree', 'add', '--detach', worktreeOne]);

    const worktreeFingerprint = computeFingerprint(worktreeOne, true);
    expect(worktreeFingerprint.source).toBe('origin');
    expect(worktreeFingerprint.fingerprint).toBe(mainFingerprint.fingerprint);

    const marker: OrgMarker = {
      mc_version: 1,
      org_id: 'org-test',
      project_fingerprint: mainFingerprint.fingerprint,
      fingerprint_source: mainFingerprint.source,
      bound_at: new Date().toISOString(),
    };
    writeMarker(repo, marker, false);
    git(repo, ['add', '.wevibe/org.json']);
    git(repo, ['commit', '-m', 'add marker']);

    const worktreeTwo = path.join(tmpdir(), `wevibe-bind-worktree-${randomUUID()}`);
    cleanupPaths.push(worktreeTwo);
    git(repo, ['worktree', 'add', '--detach', worktreeTwo]);

    const propagatedMarkerRaw = readFileSync(path.join(worktreeTwo, '.wevibe', 'org.json'), 'utf8');
    const propagatedMarker = JSON.parse(propagatedMarkerRaw) as OrgMarker;
    expect(propagatedMarker.project_fingerprint).toBe(marker.project_fingerprint);
    expect(propagatedMarker.org_id).toBe(marker.org_id);
  });

  it('falls back to realpath fingerprint when origin is missing or directory is non-git', () => {
    const gitRepoWithoutOrigin = initGitRepo();
    const fallbackFromGit = computeFingerprint(gitRepoWithoutOrigin, true);

    expect(fallbackFromGit.source).toBe('realpath');
    expect(fallbackFromGit.fingerprint).toBe(sha256Hex(realpathSync(gitRepoWithoutOrigin)));

    const plainDir = makeTempDir('wevibe-bind-non-git-');
    const resolved = resolveRoot(plainDir);
    expect(resolved.isGit).toBe(false);

    const fallbackFromNonGit = computeFingerprint(resolved.root, resolved.isGit);
    expect(fallbackFromNonGit.source).toBe('realpath');
    expect(fallbackFromNonGit.fingerprint).toBe(sha256Hex(resolved.root));
  });

  it('runs bind CLI end-to-end for --org benchmark under test keystore mode', () => {
    const repo = initGitRepo('https://github.com/Test/Bench.git');
    const require = createRequire(import.meta.url);
    const tsxLoaderPath = require.resolve('tsx');

    const bootstrapScript = `
import { clearTestStore, storeIdentitySeed, generateIdentitySeed } from ${JSON.stringify(pathToFileURL(keyStorePath).href)};
clearTestStore();
await storeIdentitySeed(generateIdentitySeed());
const bindModulePath = ${JSON.stringify(bindCliPath)};
const bindModuleUrl = ${JSON.stringify(pathToFileURL(bindCliPath).href)};
process.argv = [process.execPath, bindModulePath, 'bind', '--org', 'wevibe-org-bench'];
await import(bindModuleUrl);
`;

    execFileSync(process.execPath, ['--import', tsxLoaderPath, '--input-type=module', '-e', bootstrapScript], {
      cwd: repo,
      env: {
        ...process.env,
        WEVIBE_KEYSTORE_TEST: '1',
      },
      stdio: 'pipe',
    });

    const markerPath = path.join(repo, '.wevibe', 'org.json');
    const markerRaw = readFileSync(markerPath, 'utf8');
    const marker = JSON.parse(markerRaw) as OrgMarker;

    expect(marker.org_id).toBe('wevibe-org-bench');
    expect(marker.mc_version).toBe(1);
    expect(marker.fingerprint_source).toBe('origin');
    expect(marker.project_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writeMarker default bind writes org.json and canonical .wevibe/.gitignore', () => {
    const root = makeTempDir('wevibe-bind-default-marker-');
    const marker: OrgMarker = {
      mc_version: 1,
      org_id: 'org-default',
      project_fingerprint: sha256Hex('marker-test'),
      fingerprint_source: 'realpath',
      bound_at: new Date().toISOString(),
    };

    const outPath = writeMarker(root, marker, false);
    expect(outPath).toBe(path.join(realpathSync(root), '.wevibe', 'org.json'));
    expect(existsSync(path.join(root, '.wevibe', 'org.json'))).toBe(true);

    const gitignorePath = path.join(root, '.wevibe', '.gitignore');
    expect(readFileSync(gitignorePath, 'utf8')).toBe(expectedGitignore);
  });

  it('writeMarker with --local writes org.local.json and same canonical .wevibe/.gitignore', () => {
    const root = makeTempDir('wevibe-bind-local-marker-');
    const marker: OrgMarker = {
      mc_version: 1,
      org_id: 'org-local',
      project_fingerprint: sha256Hex('marker-test-local'),
      fingerprint_source: 'realpath',
      bound_at: new Date().toISOString(),
    };

    const outPath = writeMarker(root, marker, true);
    expect(outPath).toBe(path.join(realpathSync(root), '.wevibe', 'org.local.json'));
    expect(existsSync(path.join(root, '.wevibe', 'org.local.json'))).toBe(true);

    const gitignorePath = path.join(root, '.wevibe', '.gitignore');
    const gitignore = readFileSync(gitignorePath, 'utf8');
    expect(gitignore).toBe(expectedGitignore);
    expect(gitignore).not.toContain('org.local.json');
  });

  it('writeMarker keeps .wevibe/.gitignore byte-identical on re-bind', () => {
    const root = makeTempDir('wevibe-bind-idempotent-');
    const marker: OrgMarker = {
      mc_version: 1,
      org_id: 'org-idempotent',
      project_fingerprint: sha256Hex('marker-test-idempotent'),
      fingerprint_source: 'realpath',
      bound_at: new Date().toISOString(),
    };

    writeMarker(root, marker, false);
    const gitignorePath = path.join(root, '.wevibe', '.gitignore');
    const before = readFileSync(gitignorePath);

    writeMarker(root, marker, false);
    const after = readFileSync(gitignorePath);

    expect(after.equals(before)).toBe(true);
    expect(after.toString('utf8')).toBe(expectedGitignore);
  });

  it('writeMarker leaves org.json and .gitignore coexisting under .wevibe/', () => {
    const root = makeTempDir('wevibe-bind-coexistence-');
    const marker: OrgMarker = {
      mc_version: 1,
      org_id: 'org-coexist',
      project_fingerprint: sha256Hex('marker-test-coexist'),
      fingerprint_source: 'realpath',
      bound_at: new Date().toISOString(),
    };

    writeMarker(root, marker, false);

    const entries = new Set(readdirSync(path.join(root, '.wevibe')));
    expect(entries.has('org.json')).toBe(true);
    expect(entries.has('.gitignore')).toBe(true);
  });
});
