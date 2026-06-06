import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Non-secret identity sidecar at ~/.wevibe/identity.json.
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

const WEVIBE_DIR = join(homedir(), '.wevibe');
const SIDECAR_PATH = join(WEVIBE_DIR, 'identity.json');

function ensureDir(): void {
  if (!existsSync(WEVIBE_DIR)) {
    mkdirSync(WEVIBE_DIR, { recursive: true });
    try {
      chmodSync(WEVIBE_DIR, 0o700);
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
  if (!existsSync(SIDECAR_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SIDECAR_PATH, 'utf-8')) as Partial<IdentitySidecar>;
    return { ...defaults(), ...parsed, version: 1 };
  } catch {
    return null;
  }
}

export function writeIdentitySidecar(patch: Partial<IdentitySidecar>): IdentitySidecar {
  ensureDir();
  const current = readIdentitySidecar() ?? defaults();
  const next: IdentitySidecar = { ...current, ...patch, version: 1 };
  const tmp = `${SIDECAR_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  // Atomic replace (same directory) — safe across concurrent writers.
  renameSync(tmp, SIDECAR_PATH);
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
  return SIDECAR_PATH;
}
