import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadIgnoreMatcher } from '../src/gstv/gitignore.js';

function makeTempRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeUtf8(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('gstv/gitignore subset matcher', () => {
  it('applies root + nested rules, negation, anchored paths, and .git hard-ignore', () => {
    const repo = makeTempRepo('gstv-ignore-');

    writeUtf8(
      path.join(repo, '.gitignore'),
      ['# comment', '', '*.log', '*.tmp', 'node_modules/', '/build', '!keep.log'].join('\n'),
    );
    writeUtf8(path.join(repo, 'nested', '.gitignore'), ['!keep.tmp', '*.cache'].join('\n'));

    const ignore = loadIgnoreMatcher(repo);

    expect(ignore('error.log', false)).toBe(true);
    expect(ignore('keep.log', false)).toBe(false);

    expect(ignore('node_modules', true)).toBe(true);
    expect(ignore('node_modules/pkg/index.js', false)).toBe(true);

    expect(ignore('build', true)).toBe(true);
    expect(ignore('build/output.js', false)).toBe(true);
    expect(ignore('src/build', true)).toBe(false);

    expect(ignore('nested/file.tmp', false)).toBe(true);
    expect(ignore('nested/keep.tmp', false)).toBe(false);
    expect(ignore('nested/file.cache', false)).toBe(true);

    expect(ignore('.git', true)).toBe(true);
    expect(ignore('.git/config', false)).toBe(true);
  });

  it('supports ?, **, and basename matching at any depth', () => {
    const repo = makeTempRepo('gstv-ignore-glob-');

    writeUtf8(path.join(repo, '.gitignore'), ['?.txt', 'docs/**/draft-*.md', 'coverage'].join('\n'));
    const ignore = loadIgnoreMatcher(repo);

    expect(ignore('a.txt', false)).toBe(true);
    expect(ignore('ab.txt', false)).toBe(false);

    expect(ignore('docs/draft-1.md', false)).toBe(true);
    expect(ignore('docs/sub/deep/draft-final.md', false)).toBe(true);
    expect(ignore('docs/sub/deep/final.md', false)).toBe(false);

    expect(ignore('coverage', true)).toBe(true);
    expect(ignore('reports/coverage', true)).toBe(true);
  });
});
