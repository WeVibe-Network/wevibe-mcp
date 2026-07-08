#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWeVibeSignedAuth } from '../auth.js';
import { HUB_URL } from '../config.js';
import { logOp, newTraceId, fp } from '../logger.js';
import { loadMemberships } from '../org-client.js';

function parseArgs(): { command: string; flags: Record<string, string> } {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1] ?? '';
      if (!value.startsWith('--')) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }

  return { command, flags };
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function requireFlag(flags: Record<string, string>, key: string): string {
  if (!flags[key]) die(`--${key} is required`);
  return flags[key];
}

function hasFlag(flags: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key) && flags[key] !== 'false';
}

function printHelp(): void {
  console.log(`wevibe — bind a project to an org

Usage:
  wevibe bind [--org <org_id>] [--local] [--force]

Flags:
  --org <org_id>  Bind to this org id directly (skips hub auto-detect)
  --local         Write .wevibe/org.local.json (and gitignore it)
  --force         Overwrite existing marker file

Environment:
  WEVIBE_HUB_URL  Hub URL (default: ${HUB_URL})
`);
}

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(argv1) === realpathSync(selfPath);
  } catch {
    return path.resolve(argv1) === path.resolve(selfPath);
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeRepoPath(input: string): string {
  let repoPath = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  repoPath = repoPath.replace(/\.git$/i, '');
  return repoPath;
}

export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.includes('://')) {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const repoPath = normalizeRepoPath(parsed.pathname);
    return repoPath ? `${host}/${repoPath}` : host;
  }

  const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.*)$/);
  if (scpMatch) {
    const host = scpMatch[1].toLowerCase();
    const repoPath = normalizeRepoPath(scpMatch[2]);
    return repoPath ? `${host}/${repoPath}` : host;
  }

  const withoutUser = trimmed.replace(/^[^@/\s]+@/, '');
  const slashIdx = withoutUser.indexOf('/');
  const hostPart = slashIdx === -1 ? withoutUser : withoutUser.slice(0, slashIdx);
  const repoPath = slashIdx === -1 ? '' : withoutUser.slice(slashIdx + 1);
  const host = hostPart.split(':')[0].toLowerCase();
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  return normalizedRepoPath ? `${host}/${normalizedRepoPath}` : host;
}

export function resolveRoot(cwd: string): { root: string; isGit: boolean } {
  const resolvedCwd = realpathSync(cwd);
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!gitRoot) {
      return { root: resolvedCwd, isGit: false };
    }

    return { root: realpathSync(gitRoot), isGit: true };
  } catch {
    return { root: resolvedCwd, isGit: false };
  }
}

export function computeFingerprint(root: string, isGit: boolean): { fingerprint: string; source: 'origin' | 'realpath' } {
  const resolvedRoot = realpathSync(root);

  if (isGit) {
    try {
      const originUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: resolvedRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (originUrl.length > 0) {
        return {
          fingerprint: sha256Hex(normalizeGitUrl(originUrl)),
          source: 'origin',
        };
      }
    } catch {
      // fall through to realpath fingerprint
    }
  }

  return {
    fingerprint: sha256Hex(realpathSync(resolvedRoot)),
    source: 'realpath',
  };
}

export interface OrgMarker {
  mc_version: 1;
  org_id: string;
  project_fingerprint: string;
  fingerprint_source: 'origin' | 'realpath';
  bound_at: string;
}

function markerPath(root: string, local: boolean): string {
  return path.join(root, '.wevibe', local ? 'org.local.json' : 'org.json');
}

export function writeMarker(root: string, marker: OrgMarker, local: boolean): string {
  const resolvedRoot = realpathSync(root);
  const wevibeDir = path.join(resolvedRoot, '.wevibe');
  mkdirSync(wevibeDir, { recursive: true });

  const outPath = markerPath(resolvedRoot, local);
  writeFileSync(outPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  const gitignorePath = path.join(wevibeDir, '.gitignore');
  const desiredGitignore = '*\n!.gitignore\n!org.json\n';
  const currentGitignore = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, 'utf8').replace(/\r\n/g, '\n')
    : '';

  if (currentGitignore !== desiredGitignore) {
    writeFileSync(gitignorePath, desiredGitignore, 'utf8');
  }

  return outPath;
}

function failBind(trace: string, message: string): never {
  logOp('bind', 'error', {
    trace,
    phase: 'outcome',
    status: 'err',
    err: message,
  });
  die(message);
}

async function main() {
  const trace = newTraceId();
  const { command, flags } = parseArgs();

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command !== 'bind') {
    logOp('bind', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      err: `unknown command: ${command}`,
    });
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const local = hasFlag(flags, 'local');
  const force = hasFlag(flags, 'force');
  const { root, isGit } = resolveRoot(process.cwd());

  logOp('bind', 'info', {
    trace,
    phase: 'entry',
    root,
    is_git: isGit,
    local,
    force,
  });

  try {
    const { pubkeyHex } = await buildWeVibeSignedAuth();
    logOp('bind', 'info', {
      trace,
      phase: 'auth',
      member_fp: fp(pubkeyHex),
    });

    let orgId: string;
    if (hasFlag(flags, 'org')) {
      const rawOrgId = requireFlag(flags, 'org').trim();
      if (!rawOrgId || rawOrgId === 'true') {
        failBind(trace, '--org requires a value');
      }
      orgId = rawOrgId;
    } else {
      const memberships = await loadMemberships(HUB_URL);
      if (memberships.length === 0) {
        failBind(trace, 'No org memberships found. Re-run with --org <id> or join an org first.');
      }
      if (memberships.length > 1) {
        const orgList = memberships.map(membership => membership.orgId).join(', ');
        failBind(trace, `Multiple org memberships found (${orgList}). Re-run with --org <id>.`);
      }

      orgId = memberships[0].orgId;
      console.log(`Auto-selected org: ${orgId} (single membership).`);
    }

    const { fingerprint, source } = computeFingerprint(root, isGit);
    const targetPath = markerPath(root, local);
    if (existsSync(targetPath) && !force) {
      console.log(`Marker already exists at ${targetPath}; re-run with --force to overwrite.`);
      logOp('bind', 'info', {
        trace,
        phase: 'outcome',
        status: 'exists',
        org: orgId,
        fingerprint_fp: fp(fingerprint),
        source,
        local,
        path: targetPath,
      });
      return;
    }

    const marker: OrgMarker = {
      mc_version: 1,
      org_id: orgId,
      project_fingerprint: fingerprint,
      fingerprint_source: source,
      bound_at: new Date().toISOString(),
    };

    const writtenPath = writeMarker(root, marker, local);

    console.log(`Bound org: ${marker.org_id}`);
    console.log(`Fingerprint: ${marker.project_fingerprint}`);
    console.log(`Fingerprint source: ${marker.fingerprint_source}`);
    console.log(`Marker path: ${writtenPath}`);

    logOp('bind', 'info', {
      trace,
      phase: 'outcome',
      status: 'ok',
      org: orgId,
      fingerprint_fp: fp(fingerprint),
      source,
      local,
      path: writtenPath,
    });
  } catch (error) {
    const errText = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logOp('bind', 'error', {
      trace,
      phase: 'outcome',
      status: 'err',
      err: errText,
      local,
      force,
    });
    throw error;
  }
}

if (isMainModule()) {
  main().catch(error => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
