import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Non-secret identity sidecar at ~/.wevibe/identity.json.
 *
 * Set WEVIBE_HOME for isolated bench/smoke identities; when unset, the default
 * remains the real user's home WeVibe directory.
 *
 * This file NEVER contains the seed or any private key — only public keys and
 * lifecycle flags. Its purpose is to let the opencode TUI plugin (and the
 * `identity-status` command) report identity state WITHOUT triggering a
 * biometric prompt. Public keys are safe to persist in plaintext.
 */

export interface IdentitySidecar {
  version: 1;
  ed25519PublicKey: string | null; // hex
  x25519PublicKey: string | null; // hex
  createdAt: string | null; // ISO-8601
  platform: NodeJS.Platform | null; // darwin | win32 | linux | ...
  biometric: boolean; // was creation biometric-gated?
  adoptedAt: string | null; // dashboard adoption confirmed
  extractedAt: string | null; // last successful extraction
  lastPairingId: string | null; // hex(SHA-256(secret)) of last export-pairing
  orgs?: Record<string, {
    hubEndpoints: string[];
    activeHubEndpoint: string | null;
    hubServingAddress: string | null;
    hubResponsePubkey: string | null;
    updatedAt: string | null;
  }>;
}

export interface OrgHubState {
  hubEndpoints: string[];
  activeHubEndpoint: string | null;
  hubServingAddress: string | null;
  hubResponsePubkey: string | null;
  updatedAt: string | null;
}

function wevibeDir(): string {
  const override = process.env.WEVIBE_HOME;
  return override?.trim() ? override : join(homedir(), '.wevibe');
}

function sidecarPath(): string {
  return join(wevibeDir(), 'identity.json');
}

function ensureDir(): void {
  const dir = wevibeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
  }
}

function defaults(): IdentitySidecar {
  return {
    version: 1,
    ed25519PublicKey: null,
    x25519PublicKey: null,
    createdAt: null,
    platform: null,
    biometric: false,
    adoptedAt: null,
    extractedAt: null,
    lastPairingId: null,
    orgs: {},
  };
}

function defaultOrgHubState(): OrgHubState {
  return {
    hubEndpoints: [],
    activeHubEndpoint: null,
    hubServingAddress: null,
    hubResponsePubkey: null,
    updatedAt: null,
  };
}

export function readIdentitySidecar(): IdentitySidecar | null {
  const path = sidecarPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<IdentitySidecar>;
    return { ...defaults(), ...parsed, version: 1 };
  } catch {
    return null;
  }
}

export function writeIdentitySidecar(patch: Partial<IdentitySidecar>): IdentitySidecar {
  ensureDir();
  const current = readIdentitySidecar() ?? defaults();
  const next: IdentitySidecar = { ...current, ...patch, version: 1 };
  const path = sidecarPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  // Atomic replace (same directory) — safe across concurrent writers.
  renameSync(tmp, path);
  return next;
}

export function getOrgHubState(orgId: string): OrgHubState | null {
  const sidecar = readIdentitySidecar() ?? defaults();
  const orgState = sidecar.orgs?.[orgId];
  if (!orgState) {
    return null;
  }
  return { ...defaultOrgHubState(), ...orgState };
}

export function setOrgHubState(orgId: string, patch: Partial<OrgHubState>): IdentitySidecar {
  const sidecar = readIdentitySidecar() ?? defaults();
  const existing = sidecar.orgs?.[orgId] ?? defaultOrgHubState();
  const nextOrgState: OrgHubState = {
    ...existing,
    ...patch,
    hubEndpoints: patch.hubEndpoints ?? existing.hubEndpoints ?? [],
  };
  return writeIdentitySidecar({
    orgs: {
      ...(sidecar.orgs ?? {}),
      [orgId]: nextOrgState,
    },
  });
}

export function getSidecarPath(): string {
  return sidecarPath();
}
