import fs from 'node:fs';
import path from 'node:path';

/**
 * Dependency-free `.gitignore` subset matcher for GSTV walk-v1.
 *
 * Supported subset:
 * - Blank lines and `#` comments
 * - Trailing `/` directory-only patterns
 * - Leading `/` anchored patterns (anchored to the directory containing that `.gitignore`)
 * - `!` negation (later rules override earlier; deeper `.gitignore` files override shallower)
 * - `*` and `?` single-segment wildcards
 * - `**` wildcards in leading/trailing/middle positions
 * - Patterns without `/` match BASENAME at any depth beneath the `.gitignore` directory
 * - `.git` is always ignored regardless of rules
 *
 * Deliberate non-goals in this subset:
 * - Escaped `#` / `!` handling and other backslash escape edge-cases
 * - Full git pathspec compatibility beyond the subset above
 */

interface IgnoreRule {
  baseDirRel: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
  pattern: string;
  segments: string[];
}

function normalizeRelPath(relPath: string): string {
  return relPath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '');
}

function splitSegments(relPath: string): string[] {
  const normalized = normalizeRelPath(relPath);
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split('/').filter((segment) => segment.length > 0);
}

function segmentMatches(patternSegment: string, valueSegment: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starPatternIndex = -1;
  let starValueIndex = -1;

  while (valueIndex < valueSegment.length) {
    if (patternIndex < patternSegment.length) {
      const patternChar = patternSegment[patternIndex];
      if (patternChar === '?' || patternChar === valueSegment[valueIndex]) {
        patternIndex += 1;
        valueIndex += 1;
        continue;
      }
      if (patternChar === '*') {
        starPatternIndex = patternIndex;
        starValueIndex = valueIndex;
        patternIndex += 1;
        continue;
      }
    }

    if (starPatternIndex !== -1) {
      patternIndex = starPatternIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
      continue;
    }

    return false;
  }

  while (patternIndex < patternSegment.length && patternSegment[patternIndex] === '*') {
    patternIndex += 1;
  }
  return patternIndex === patternSegment.length;
}

function matchSegmentList(patternSegments: string[], valueSegments: string[]): boolean {
  const memo = new Map<string, boolean>();

  const visit = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    if (patternIndex === patternSegments.length) {
      const done = valueIndex === valueSegments.length;
      memo.set(key, done);
      return done;
    }

    const segment = patternSegments[patternIndex];
    if (segment === '**') {
      if (visit(patternIndex + 1, valueIndex)) {
        memo.set(key, true);
        return true;
      }
      if (valueIndex < valueSegments.length && visit(patternIndex, valueIndex + 1)) {
        memo.set(key, true);
        return true;
      }
      memo.set(key, false);
      return false;
    }

    if (valueIndex >= valueSegments.length) {
      memo.set(key, false);
      return false;
    }

    const result = segmentMatches(segment, valueSegments[valueIndex]) && visit(patternIndex + 1, valueIndex + 1);
    memo.set(key, result);
    return result;
  };

  return visit(0, 0);
}

function matchesRuleForSegments(rule: IgnoreRule, valueSegments: string[]): boolean {
  if (!rule.hasSlash) {
    const basename = valueSegments[valueSegments.length - 1];
    return basename !== undefined && segmentMatches(rule.pattern, basename);
  }

  if (rule.anchored) {
    return matchSegmentList(rule.segments, valueSegments);
  }

  for (let start = 0; start <= valueSegments.length; start += 1) {
    if (matchSegmentList(rule.segments, valueSegments.slice(start))) {
      return true;
    }
  }
  return false;
}

function ruleMatches(rule: IgnoreRule, relPathFromBase: string, isDir: boolean): boolean {
  const segments = splitSegments(relPathFromBase);

  if (rule.dirOnly) {
    const maxPrefixLength = isDir ? segments.length : segments.length - 1;
    for (let prefixLength = 1; prefixLength <= maxPrefixLength; prefixLength += 1) {
      const prefix = segments.slice(0, prefixLength);
      if (matchesRuleForSegments(rule, prefix)) {
        return true;
      }
    }
    return false;
  }

  if (!rule.hasSlash) {
    if (rule.anchored) {
      const head = segments[0];
      return head !== undefined && segmentMatches(rule.pattern, head);
    }
    return segments.some((segment) => segmentMatches(rule.pattern, segment));
  }

  if (matchesRuleForSegments(rule, segments)) {
    return true;
  }

  for (let prefixLength = 1; prefixLength < segments.length; prefixLength += 1) {
    if (matchesRuleForSegments(rule, segments.slice(0, prefixLength))) {
      return true;
    }
  }

  return false;
}

function parseGitignoreFile(repoRoot: string, baseDirRel: string): IgnoreRule[] {
  const baseAbs = baseDirRel.length > 0 ? path.join(repoRoot, baseDirRel) : repoRoot;
  const gitignorePath = path.join(baseAbs, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return [];
  }

  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const rules: IgnoreRule[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    let working = line;
    let negated = false;
    if (working.startsWith('!')) {
      negated = true;
      working = working.slice(1);
    }

    if (working.length === 0) {
      continue;
    }

    const dirOnly = working.endsWith('/');
    if (dirOnly) {
      working = working.slice(0, -1);
    }

    if (working.length === 0) {
      continue;
    }

    const anchored = working.startsWith('/');
    if (anchored) {
      working = working.slice(1);
    }

    if (working.length === 0) {
      continue;
    }

    const normalizedPattern = normalizeRelPath(working);
    if (normalizedPattern.length === 0) {
      continue;
    }

    rules.push({
      baseDirRel,
      negated,
      dirOnly,
      anchored,
      hasSlash: normalizedPattern.includes('/'),
      pattern: normalizedPattern,
      segments: normalizedPattern.split('/'),
    });
  }

  return rules;
}

function ancestorsFor(relPath: string, isDir: boolean): string[] {
  const segments = splitSegments(relPath);
  const parentDepth = segments.length - 1;
  const dirs = [''];

  let acc: string[] = [];
  for (let index = 0; index < parentDepth; index += 1) {
    acc = [...acc, segments[index]];
    dirs.push(acc.join('/'));
  }

  return dirs;
}

export function loadIgnoreMatcher(repoRoot: string): (relPath: string, isDir: boolean) => boolean {
  const rootAbs = path.resolve(repoRoot);
  const loadedByDir = new Map<string, IgnoreRule[]>();

  const loadRulesForDir = (baseDirRel: string): IgnoreRule[] => {
    const key = normalizeRelPath(baseDirRel);
    const existing = loadedByDir.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const parsed = parseGitignoreFile(rootAbs, key);
    loadedByDir.set(key, parsed);
    return parsed;
  };

  return (relPath: string, isDir: boolean): boolean => {
    const normalizedRel = normalizeRelPath(relPath);
    if (normalizedRel.length === 0) {
      return false;
    }

    const segments = splitSegments(normalizedRel);
    if (segments[0] === '.git') {
      return true;
    }

    const ancestorDirs = ancestorsFor(normalizedRel, isDir);
    let ignored = false;

    for (const baseDirRel of ancestorDirs) {
      const rules = loadRulesForDir(baseDirRel);
      if (rules.length === 0) {
        continue;
      }

      const relFromBase = baseDirRel.length > 0 && normalizedRel.startsWith(`${baseDirRel}/`)
        ? normalizedRel.slice(baseDirRel.length + 1)
        : normalizedRel;

      for (const rule of rules) {
        if (!ruleMatches(rule, relFromBase, isDir)) {
          continue;
        }
        ignored = !rule.negated;
      }
    }

    return ignored;
  };
}
