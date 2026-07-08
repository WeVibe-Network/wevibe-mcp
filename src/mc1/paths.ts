import { homedir } from 'node:os';
import { UNIX_ABSOLUTE_PATH_REGEX, WINDOWS_ABSOLUTE_PATH_REGEX } from '../query-scrub.js';

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

function trimTrailingSlashes(path: string): string {
  if (path === '/') {
    return path;
  }
  return path.replace(/\/+$/, '');
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:/.test(path);
}

function relativeFromPrefix(input: string, prefix: string): string | null {
  const normalizedInput = trimTrailingSlashes(normalizeSeparators(input));
  const normalizedPrefix = trimTrailingSlashes(normalizeSeparators(prefix));
  if (normalizedInput.length === 0 || normalizedPrefix.length === 0) {
    return null;
  }

  const caseInsensitive = isWindowsDrivePath(normalizedInput) || isWindowsDrivePath(normalizedPrefix);
  const comparedInput = caseInsensitive ? normalizedInput.toLowerCase() : normalizedInput;
  const comparedPrefix = caseInsensitive ? normalizedPrefix.toLowerCase() : normalizedPrefix;

  if (comparedInput === comparedPrefix) {
    return '';
  }

  const prefixed = `${comparedPrefix}/`;
  if (!comparedInput.startsWith(prefixed)) {
    return null;
  }

  return normalizedInput.slice(normalizedPrefix.length + 1);
}

function stripKnownHomePrefix(input: string): string {
  const patterns = [
    /^\/?Users\/[^/]+\/?(.*)$/,
    /^\/home\/[^/]+\/?(.*)$/i,
    /^\/root\/?(.*)$/i,
    /^[A-Za-z]:\/Users\/[^/]+\/?(.*)$/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      return match[1] ?? '';
    }
  }

  return input;
}

function containsAbsoluteOrIdentityHomePath(input: string): boolean {
  const unixAbsolutePathRegex = new RegExp(UNIX_ABSOLUTE_PATH_REGEX.source);
  if (unixAbsolutePathRegex.test(input)) {
    return true;
  }

  const windowsAbsolutePathRegex = new RegExp(WINDOWS_ABSOLUTE_PATH_REGEX.source);
  if (windowsAbsolutePathRegex.test(input)) {
    return true;
  }

  const windowsStyleInput = input.replace(/\//g, '\\');
  const windowsAbsolutePathFromForwardSlashesRegex = new RegExp(WINDOWS_ABSOLUTE_PATH_REGEX.source);
  return windowsAbsolutePathFromForwardSlashesRegex.test(windowsStyleInput);
}

/** Convert an absolute/local path into an identity-free RELATIVE path.
 *  - If `root` is provided and `input` is under it, return the path relative to root.
 *  - Else strip a leading home/username prefix: `/Users/<name>/`, `/home/<name>/`, `/root/`
 *    (and Windows `C:\Users\<name>\`), leaving the remainder.
 *  - Normalize separators to forward slashes; strip a leading `/`.
 *  - If, AFTER transformation, the result STILL matches an absolute-path/home detection
 *    regex (i.e. could not be made identity-free), return null so the caller drops it (graceful).
 *  - Already-relative inputs (no leading `/` or drive) pass through normalized. */
export function relativizePath(input: string, opts?: { root?: string; homeDir?: string }): string | null {
  const raw = input.trim();
  if (raw.length === 0) {
    return null;
  }

  const normalizedInput = trimTrailingSlashes(normalizeSeparators(raw));

  let candidate = '';
  if (opts?.root && opts.root.trim().length > 0) {
    const rootRelative = relativeFromPrefix(normalizedInput, opts.root.trim());
    if (rootRelative !== null) {
      candidate = rootRelative;
    }
  }

  if (candidate.length === 0) {
    const resolvedHomeDir = opts?.homeDir ?? homedir();
    if (resolvedHomeDir.trim().length > 0) {
      const homeRelative = relativeFromPrefix(normalizedInput, resolvedHomeDir.trim());
      if (homeRelative !== null) {
        candidate = homeRelative;
      }
    }
  }

  if (candidate.length === 0) {
    candidate = stripKnownHomePrefix(normalizedInput);
  }

  candidate = normalizeSeparators(candidate)
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');

  if (candidate.length === 0) {
    return null;
  }

  if (containsAbsoluteOrIdentityHomePath(candidate)) {
    return null;
  }

  return candidate;
}

/** Map relativizePath over a list, drop nulls/empties, dedupe preserving order. */
export function scrubPaths(paths: readonly string[], opts?: { root?: string; homeDir?: string }): string[] {
  const scrubbed: string[] = [];
  const seen = new Set<string>();

  for (const path of paths) {
    const relativized = relativizePath(path, opts);
    if (relativized === null || relativized.length === 0 || seen.has(relativized)) {
      continue;
    }

    seen.add(relativized);
    scrubbed.push(relativized);
  }

  return scrubbed;
}
