#!/usr/bin/env node

/**
 * wevibe-admin — CLI for WeVibe Network administrative operations.
 *
 * These commands were previously MCP tools but do not belong in an
 * agent's tool list. They are run by org leaders, moderators, and
 * during initial setup.
 *
 * Usage:
 *   wevibe-admin setup-identity
 *   wevibe-admin export-identity
 *   wevibe-admin import-identity --phrase "24 word phrase" [--force]
 *   wevibe-admin pair --code <dashboard pairing code> [--force]
 *   wevibe-admin export-pairing [--no-open]
 *   wevibe-admin resolve-endpoints [--json]
 *   wevibe-admin create-org --name "My Org" --domain example.com
 *   wevibe-admin orgs
 *   wevibe-admin invite --org <org_id> --pubkey <hex> --x25519 <hex> --pre-pubkey <hex> --role member|moderator
 *   wevibe-admin rotate --org <org_id>
 *   wevibe-admin provision-recall --org <org_id>
 *   wevibe-admin moderate-queue [--org <org_id>]
 *   wevibe-admin moderate-approve --hash <submission_hash> [--org <org_id>]
 *   wevibe-admin moderate-deny --hash <submission_hash> --reason "..." [--org <org_id>]
 *   wevibe-admin keywords list [--org <org_id>]
 *   wevibe-admin keywords add --keyword <kw> [--org <org_id>]
 *   wevibe-admin keywords merge --from <kw> --to <kw> [--org <org_id>]
 *   wevibe-admin keywords rename --keyword <kw> --to <new> [--org <org_id>]
 *   wevibe-admin keywords deprecate --keyword <kw> [--org <org_id>]
 *   wevibe-admin vault-status
 *   wevibe-admin vault-unlock --passphrase "..."
 *   wevibe-admin recovery-status [--org <org_id>]
 *   wevibe-admin recover-org --org <org_id> --phrase "24 word phrase"
 *   wevibe-admin setup-threshold --org <org_id> --share2 <hex> --share3 <hex>
 *   wevibe-admin recover-threshold --org <org_id> --share <hex>
 */

import { initCrypto, deriveEpochKeys, sealToPubkey, openEnvelope, decryptSymmetric, seedToMnemonic, mnemonicToSeed, generateIdentityFromSeed } from './crypto.js';
import { loadIdentity, loadIdentitySeed, storeIdentitySeed, generateIdentitySeed, loadKeyEnvelope, storeKeyEnvelope, hasStoredIdentitySeed } from './key-store.js';
import { generateRecoveryPhrase, reconstructMasterKey, splitMasterKey, reconstructFromShares } from './recovery.js';
import { loadMemberships, createOrg, inviteMember, rotateEpoch, provisionRecall } from './org-client.js';
import { fetchPendingQueue, decryptPendingItem, approveSubmission, denySubmission, scanForSteganography } from './moderation.js';
import { buildWeVibeSignedAuth, getOrCreatePreIdentity, getPrePublicKeyHex } from './auth.js';
import { vaultExists, isVaultUnlocked, unlockVault, listVaultEntries, getVaultCache, retrievePassphraseFromKeychain, lockVault } from './vault.js';
import { base32Decode, pairingIdFromSecret, decryptPairedIdentitySeed } from './pair-crypto.js';
import { HUB_URL, CHAIN_REST_URL, DASHBOARD_URL } from './config.js';
import { logOp } from './logger.js';
import { writeIdentitySidecar, readIdentitySidecar } from './identity-sidecar.js';
import { isBiometricAvailable } from './biometric.js';
import { resolveAllOrgsOnce } from './hub-resolver.js';
import { exportIdentityPairing } from './pairing-export.js';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type PairingPayload = {
  hkdf_salt: string;
  iv: string;
  ciphertext: string;
};

class PairingCommandError extends Error {}

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cross-OS browser open. Returns true if an opener was successfully spawned.
 * macOS: `open`, Windows: `cmd /c start`, Linux/other: `xdg-open`.
 */
function openUrl(url: string): boolean {
  try {
    let result;
    if (process.platform === 'darwin') {
      result = spawnSync('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      // Empty title arg required so URLs with spaces/& are handled by `start`.
      result = spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else {
      result = spawnSync('xdg-open', [url], { stdio: 'ignore' });
    }
    return !result.error && (result.status === 0 || result.status === null);
  } catch {
    return false;
  }
}

/** Persist non-secret identity pubkeys to the sidecar (no biometric needed to read later). */
function recordIdentitySidecar(identity: { edPubkey: Uint8Array; xPubkey: Uint8Array }, opts?: { createdAt?: boolean }): void {
  try {
    const patch: Parameters<typeof writeIdentitySidecar>[0] = {
      ed25519PublicKey: uint8ArrayToHex(identity.edPubkey),
      x25519PublicKey: uint8ArrayToHex(identity.xPubkey),
      platform: process.platform,
      biometric: isBiometricAvailable(),
    };
    if (opts?.createdAt) {
      patch.createdAt = new Date().toISOString();
    }
    writeIdentitySidecar(patch);
  } catch {
    // Sidecar is best-effort; never block the primary command on it.
  }
}

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

/** True if a (possibly value-less) flag was passed. The arg parser stores
 *  value-less trailing flags as '' and mid-list flags as 'true', so presence
 *  is the reliable signal for boolean flags. */
function hasFlag(flags: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key) && flags[key] !== 'false';
}

async function getIdentityPubkeyHex(): Promise<string | null> {
  const identity = await loadIdentity();
  if (!identity) return null;
  return Buffer.from(identity.edPubkey).toString('hex');
}

async function getMembership(orgId?: string) {
  let memberships: Awaited<ReturnType<typeof loadMemberships>>;
  try {
    memberships = await loadMemberships(HUB_URL);
  } catch (e) {
    die(`Failed to load org memberships from hub: ${e}`);
  }

  if (memberships.length === 0) die('No org memberships found. Run setup-identity and get invited first.');
  if (orgId) {
    const m = memberships.find(m => m.orgId === orgId);
    if (!m) die(`Not a member of org ${orgId}`);
    return m;
  }
  return memberships[0];
}

async function cmdSetupIdentity(flags: Record<string, string> = {}) {
  const json = hasFlag(flags, 'json');
  const existing = await loadIdentity();
  if (existing) {
    // Backfill the sidecar in case it is missing (legacy identity created before sidecars).
    recordIdentitySidecar(existing);
    if (json) {
      console.log(JSON.stringify({
        status: 'exists',
        ed25519PublicKey: uint8ArrayToHex(existing.edPubkey),
        x25519PublicKey: uint8ArrayToHex(existing.xPubkey),
      }));
      return;
    }
    console.log(`Identity already exists.`);
    console.log(`  Ed25519: ${uint8ArrayToHex(existing.edPubkey)}`);
    console.log(`  X25519:  ${uint8ArrayToHex(existing.xPubkey)}`);
    return;
  }
  const seed = generateIdentitySeed();
  await storeIdentitySeed(seed);
  const identity = await loadIdentity();
  if (!identity) {
    if (json) {
      console.log(JSON.stringify({ status: 'error', error: 'failed to create identity' }));
      process.exit(1);
    }
    die('failed to create identity');
  }
  recordIdentitySidecar(identity, { createdAt: true });
  if (json) {
    console.log(JSON.stringify({
      status: 'created',
      ed25519PublicKey: uint8ArrayToHex(identity.edPubkey),
      x25519PublicKey: uint8ArrayToHex(identity.xPubkey),
    }));
    return;
  }
  console.log(`Identity created.`);
  console.log(`  Ed25519: ${uint8ArrayToHex(identity.edPubkey)}`);
  console.log(`  X25519:  ${uint8ArrayToHex(identity.xPubkey)}`);
  console.log(`\nShare these public keys with an org leader to receive an invitation.`);
}

async function cmdIdentityStatus(flags: Record<string, string>) {
  // NO biometric: existence probe + non-secret sidecar only.
  const hasIdentity = await hasStoredIdentitySeed();
  const sidecar = readIdentitySidecar();

  const status = {
    hasIdentity,
    sidecar: sidecar !== null,
    ed25519PublicKey: sidecar?.ed25519PublicKey ?? null,
    x25519PublicKey: sidecar?.x25519PublicKey ?? null,
    createdAt: sidecar?.createdAt ?? null,
    platform: sidecar?.platform ?? process.platform,
    biometric: sidecar?.biometric ?? null,
    adopted: sidecar?.adoptedAt != null,
    extracted: sidecar?.extractedAt != null,
    lastPairingId: sidecar?.lastPairingId ?? null,
  };

  if (hasFlag(flags, 'json')) {
    console.log(JSON.stringify(status));
    return;
  }

  console.log(`Identity: ${hasIdentity ? 'present' : 'none'}`);
  if (hasIdentity) {
    console.log(`  Ed25519: ${status.ed25519PublicKey ?? '(unknown — run setup-identity to backfill sidecar)'}`);
    console.log(`  Created: ${status.createdAt ?? '(unknown)'}`);
    console.log(`  Adopted (dashboard): ${status.adopted}`);
    console.log(`  Extracted: ${status.extracted}`);
  } else {
    console.log('  Run setup-identity (or the wevibe_setup_org tool) to create one.');
  }
}

async function cmdResolveEndpoints(flags: Record<string, string>) {
  // Plugin startup path must remain biometric-free; resolve from chain + sidecar only.
  const result = await resolveAllOrgsOnce({ includeMembershipBootstrap: false });

  if (hasFlag(flags, 'json')) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.changed.length === 0) {
    console.log('No org hub endpoint changes detected.');
    return;
  }

  for (const change of result.changed) {
    console.log(`Org ${change.orgId} updated hub endpoints.`);
    console.log(`  from: ${change.from.join(', ') || '(none)'}`);
    console.log(`  to:   ${change.to.join(', ') || '(none)'}`);
  }
}

async function cmdExportIdentity() {
  const seed = await loadIdentitySeed();
  if (!seed) {
    die('No identity found. Run setup-identity first.');
  }

  const phrase = seedToMnemonic(seed);
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  IDENTITY RECOVERY PHRASE — WRITE IT DOWN, KEEP IT SECRET  ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  ${phrase}`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  WARNING: Anyone with this phrase controls this identity    ║`);
  console.log(`║  and can pair a new device to it.                           ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
}

async function cmdImportIdentity(flags: Record<string, string>) {
  const phrase = requireFlag(flags, 'phrase');

  const existing = await loadIdentity();
  if (existing && flags['force'] !== 'true') {
    die('An identity already exists. Re-run with --force to overwrite it (the current identity will be replaced).');
  }

  let seed: Uint8Array;
  try {
    seed = mnemonicToSeed(phrase);
  } catch (e) {
    die(`Invalid recovery phrase: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (seed.length !== 32) {
    die('Recovery phrase did not yield a 32-byte seed.');
  }

  await storeIdentitySeed(seed);
  const identity = await loadIdentity();
  if (!identity) {
    die('Failed to restore identity from phrase.');
  }

  console.log('Identity restored.');
  console.log(`  Ed25519: ${uint8ArrayToHex(identity.edPubkey)}`);
  console.log(`  X25519:  ${uint8ArrayToHex(identity.xPubkey)}`);
}

async function cmdPair(flags: Record<string, string>) {
  const token = requireFlag(flags, 'code');

  if (await hasStoredIdentitySeed() && flags['force'] !== 'true') {
    die('An identity already exists. Re-run with --force to replace it.');
  }

  let secret: Buffer | null = null;
  let seed: Buffer | null = null;
  let error: unknown = null;

  try {
    try {
      secret = base32Decode(token.trim().toUpperCase());
    } catch {
      throw new PairingCommandError('Invalid pairing code.');
    }

    if (secret.length !== 16) {
      throw new PairingCommandError('Invalid pairing code.');
    }

    const pairingId = pairingIdFromSecret(secret);
    const resp = await fetch(`${HUB_URL}/v1/pair/${pairingId}`);
    if (resp.status === 404) {
      throw new PairingCommandError('Pairing code not found or expired. Generate a new code in the dashboard.');
    }
    if (!resp.ok) {
      throw new PairingCommandError(`Hub error ${resp.status}`);
    }

    const body = await resp.json() as Partial<PairingPayload>;
    if (
      typeof body.hkdf_salt !== 'string' ||
      typeof body.iv !== 'string' ||
      typeof body.ciphertext !== 'string'
    ) {
      throw new PairingCommandError('Hub returned malformed pairing payload.');
    }

    const hkdfSalt = Buffer.from(body.hkdf_salt, 'base64');
    const iv = Buffer.from(body.iv, 'base64');
    const ciphertext = Buffer.from(body.ciphertext, 'base64');

    try {
      seed = decryptPairedIdentitySeed(secret, hkdfSalt, iv, ciphertext);
    } catch {
      throw new PairingCommandError('Invalid pairing code.');
    }

    if (seed.length !== 32) {
      throw new PairingCommandError('Paired identity seed must be 32 bytes.');
    }

    await storeIdentitySeed(seed);
    const identity = generateIdentityFromSeed(seed);
    recordIdentitySidecar(identity, { createdAt: true });
    console.log('Identity paired.');
    console.log(`  Ed25519: ${uint8ArrayToHex(identity.edPubkey)}`);
    console.log(`  X25519:  ${uint8ArrayToHex(identity.xPubkey)}`);
  } catch (e) {
    error = e;
  } finally {
    if (secret) secret.fill(0);
    if (seed) seed.fill(0);
  }

  if (!error) {
    return;
  }
  if (error instanceof PairingCommandError) {
    die(error.message);
  }
  if (error instanceof Error) {
    die(error.message);
  }
  die(String(error));
}

async function cmdExportPairing(flags: Record<string, string>) {
  if (!await loadIdentity()) {
    die('No identity. Run setup-identity first.');
  }

  let error: unknown = null;

  try {
    const { token, pairingId } = await exportIdentityPairing();
    const adoptUrl = `${DASHBOARD_URL}/adopt#code=${token}`;

    // Open the browser unless explicitly suppressed. Default is to open.
    const shouldOpen = !hasFlag(flags, 'no-open');
    let opened = false;
    if (shouldOpen) {
      opened = openUrl(adoptUrl);
    }

    if (hasFlag(flags, 'json')) {
      console.log(JSON.stringify({ ok: true, opened, url: adoptUrl, pairingId }));
    } else {
      console.log('Pairing export created.');
      console.log(`  URL: ${adoptUrl}`);
      console.log(`  Token: ${token}`);
      console.log('  Single use, expires in 15 minutes.');
      if (shouldOpen && !opened) {
        console.log('  (Could not open a browser automatically — open the URL above manually.)');
      }
    }
  } catch (e) {
    error = e;
  }

  if (!error) {
    return;
  }
  if (error instanceof PairingCommandError) {
    die(error.message);
  }
  if (error instanceof Error) {
    die(error.message);
  }
  die(String(error));
}

async function cmdCreateOrg(flags: Record<string, string>) {
  const orgName = requireFlag(flags, 'name');
  const domain = requireFlag(flags, 'domain');
  logOp('admin.setup_org', 'info', { phase: 'entry', name: orgName, domain });
  const result = await createOrg({ orgName, domain, hubUrl: HUB_URL });
  if (result.status === 'error') {
    logOp('admin.setup_org', 'error', {
      phase: 'outcome',
      status: 'err',
      name: orgName,
      domain,
      err: result.error,
    });
    die(`Org creation failed: ${result.error}`);
  }

  const masterKey = await loadKeyEnvelope(result.orgId, 'master');
  if (!masterKey) {
    logOp('admin.setup_org', 'error', {
      phase: 'outcome',
      status: 'err',
      org: result.orgId,
      name: orgName,
      domain,
      err: 'master key not found',
    });
    die(`Org created (ID: ${result.orgId}) but master key not found.`);
  }

  const phrase = generateRecoveryPhrase(masterKey);
  logOp('admin.setup_org', 'info', {
    phase: 'outcome',
    status: 'ok',
    org: result.orgId,
    name: orgName,
    domain,
  });
  console.log(`Org created: ${result.orgId}`);
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  RECOVERY PHRASE — WRITE THIS DOWN AND STORE IT SECURELY   ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  ${phrase}`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  WARNING: Anyone with this phrase controls your org's      ║`);
  console.log(`║  master key. It cannot be displayed again.                 ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
}

async function cmdOrgs() {
  let memberships: Awaited<ReturnType<typeof loadMemberships>>;
  try {
    memberships = await loadMemberships(HUB_URL);
  } catch (e) {
    die(`Failed to load org memberships from hub: ${e}`);
  }

  if (memberships.length === 0) {
    console.log('Not a member of any org.');
    return;
  }
  console.log('Orgs:');
  for (const m of memberships) {
    console.log(`  ${m.orgId} — ${m.role} (epoch ${m.currentEpoch}, egress: ${m.egressMode})`);
  }
}

async function cmdInvite(flags: Record<string, string>) {
  const orgId = requireFlag(flags, 'org');
  const pubkey = requireFlag(flags, 'pubkey');
  const x25519 = requireFlag(flags, 'x25519');
  const prePubkeyFlag = flags['pre-pubkey'];
  const canContribute = flags['can-contribute'] === 'true' || flags['can-contribute'] === '1';
  const canModerate = flags['can-moderate'] === 'true' || flags['can-moderate'] === '1';

  let inviteePrePubkeyHex = prePubkeyFlag ?? '';
  if (!inviteePrePubkeyHex) {
    const identity = await loadIdentity();
    const selfPubkeyHex = identity ? Buffer.from(identity.edPubkey).toString('hex') : '';
    if (selfPubkeyHex === pubkey) {
      await getOrCreatePreIdentity();
      inviteePrePubkeyHex = getPrePublicKeyHex();
    } else {
      die('Missing --pre-pubkey for invitee. Provide invitee compressed secp256k1 PRE pubkey hex.');
    }
  }

  const result = await inviteMember({
    orgId,
    inviteePubkeyHex: pubkey,
    inviteeX25519PubkeyHex: x25519,
    prePubkeyHex: inviteePrePubkeyHex,
    canContribute,
    canModerate,
    hubUrl: HUB_URL,
  });
  if (result.status === 'error') die(`Invitation failed: ${result.error}`);
  console.log(`Member invited to ${orgId} (contribute=${canContribute}, moderate=${canModerate}).`);
}

async function cmdRotate(flags: Record<string, string>) {
  const orgId = requireFlag(flags, 'org');
  const result = await rotateEpoch({ orgId, hubUrl: HUB_URL });
  if (result.status === 'error') die(`Rotation failed: ${result.error}`);
  console.log(`Epoch rotated. New epoch: ${result.newEpoch}, members re-keyed: ${result.membersRekeyed}`);
  if (result.bufferedMoved && result.bufferedMoved > 0) {
    console.log(`Buffered submissions moved: ${result.bufferedMoved}`);
  }
}

async function cmdProvisionRecall(flags: Record<string, string>) {
  const orgId = requireFlag(flags, 'org');
  logOp('admin.provision_recall', 'info', { phase: 'entry', org: orgId });
  try {
    await provisionRecall(orgId);
  } catch (error) {
    logOp('admin.provision_recall', 'error', {
      phase: 'outcome',
      status: 'err',
      org: orgId,
      err: error instanceof Error ? error.message : String(error),
    });
    die(`Recall provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  logOp('admin.provision_recall', 'info', { phase: 'outcome', status: 'ok', org: orgId });
  console.log(`Recall provisioned for org ${orgId}.`);
}

async function cmdModerateQueue(flags: Record<string, string>) {
  const membership = await getMembership(flags['org']);
  if (membership.role !== 'leader' && !membership.canModerate) die(`Role "${membership.role}" cannot moderate.`);

  const items = await fetchPendingQueue(HUB_URL, membership.orgId);
  if (items.length === 0) {
    console.log('No pending submissions.');
    return;
  }

  console.log(`${items.length} pending submission(s):\n`);
  for (const item of items) {
    const decrypted = decryptPendingItem(item, membership);
    console.log(`--- ${decrypted.submissionHash} ---`);
    console.log(`  epoch: ${decrypted.epochId}, contributor: ${decrypted.contributorPubkey.slice(0, 16)}...`);
    if (decrypted.stackHint.length > 0) console.log(`  stack: ${decrypted.stackHint.join(', ')}`);
    if (decrypted.decryptError) {
      console.log(`  ${decrypted.decryptError}`);
    } else {
      const stegScan = scanForSteganography(decrypted.plaintext);
      if (stegScan && !stegScan.clean) {
        console.log(`  ⚠ STEGANOGRAPHY DETECTED: ${stegScan.findings_count} finding(s)`);
      }
      const preview = decrypted.plaintext.length > 500 ? decrypted.plaintext.slice(0, 500) + '...' : decrypted.plaintext;
      console.log(`  content:\n${preview}`);
    }
    console.log('');
  }
}

async function cmdModerateApprove(flags: Record<string, string>) {
  const hash = requireFlag(flags, 'hash');
  const membership = await getMembership(flags['org']);
  if (membership.role !== 'leader' && !membership.canModerate) die(`Role "${membership.role}" cannot approve.`);

  const items = await fetchPendingQueue(HUB_URL, membership.orgId);
  const item = items.find(i => i.submission_hash === hash);
  if (!item) die(`Submission ${hash} not found in queue.`);

  const result = await approveSubmission(HUB_URL, membership.orgId, item, membership);
  if (result.status === 'error') die(`Approval failed: ${result.error}`);
  console.log(`Submission ${hash} approved.`);
  if (result.similarMemories && result.similarMemories.length > 0) {
    console.log(`\n⚠ Similar memories detected:`);
    for (const sim of result.similarMemories) {
      console.log(`  • ${sim.cid.slice(0, 16)}... (score: ${sim.score.toFixed(3)})`);
    }
  }
}

async function cmdModerateDeny(flags: Record<string, string>) {
  const hash = requireFlag(flags, 'hash');
  const reason = requireFlag(flags, 'reason');
  const membership = await getMembership(flags['org']);
  if (membership.role !== 'leader' && !membership.canModerate) die(`Role "${membership.role}" cannot deny.`);

  const result = await denySubmission(HUB_URL, membership.orgId, hash, reason);
  if (result.status === 'error') die(`Denial failed: ${result.error}`);
  console.log(`Submission ${hash} denied. Reason: ${reason}`);
}

async function cmdKeywords(flags: Record<string, string>) {
  const action = process.argv[3] ?? 'list';
  const membership = await getMembership(flags['org']);
  if (membership.role !== 'leader') die(`Keyword management requires leader role.`);

  const { headers } = await buildWeVibeSignedAuth();

  if (action === 'list') {
    const resp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/keywords`, { headers });
    if (!resp.ok) die(`Failed to list keywords: HTTP ${resp.status}`);
    const keywords = await resp.json() as Array<{ keyword: string; deprecated: boolean; usage_count: number }>;
    if (keywords.length === 0) { console.log('No keywords.'); return; }
    for (const kw of keywords) {
      console.log(`  ${kw.keyword}${kw.deprecated ? ' (deprecated)' : ''} — ${kw.usage_count} memories`);
    }
  } else if (action === 'add') {
    const keyword = requireFlag(flags, 'keyword');
    const resp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/keywords`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ keyword: keyword.toLowerCase().trim() }),
    });
    if (!resp.ok) die(`Failed to add keyword: HTTP ${resp.status}`);
    console.log(`Keyword "${keyword}" added.`);
  } else if (action === 'merge') {
    const from = requireFlag(flags, 'from');
    const to = requireFlag(flags, 'to');
    const resp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/keywords/merge`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ source: from.toLowerCase().trim(), target: to.toLowerCase().trim() }),
    });
    if (!resp.ok) die(`Failed to merge: HTTP ${resp.status}`);
    console.log(`Merged "${from}" into "${to}".`);
  } else if (action === 'rename') {
    const keyword = requireFlag(flags, 'keyword');
    const to = requireFlag(flags, 'to');
    const resp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/keywords/${encodeURIComponent(keyword)}/rename`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ new_name: to.toLowerCase().trim() }),
    });
    if (!resp.ok) die(`Failed to rename: HTTP ${resp.status}`);
    console.log(`Renamed "${keyword}" to "${to}".`);
  } else if (action === 'deprecate') {
    const keyword = requireFlag(flags, 'keyword');
    const resp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/keywords/${encodeURIComponent(keyword)}`, {
      method: 'DELETE', headers,
    });
    if (!resp.ok) die(`Failed to deprecate: HTTP ${resp.status}`);
    console.log(`Keyword "${keyword}" deprecated.`);
  } else {
    die(`Unknown keywords action: ${action}. Use: list, add, merge, rename, deprecate`);
  }
}

async function cmdVaultStatus() {
  const exists = await vaultExists();
  if (!exists) { console.log('Vault does not exist.'); return; }
  if (!isVaultUnlocked()) { console.log('Vault exists but is locked.'); return; }
  const entries = await listVaultEntries();
  if (entries.length === 0) { console.log('Vault unlocked, no org entries.'); return; }
  console.log('Vault status (unlocked):');
  for (const e of entries) {
    console.log(`  ${e.org_id} — ${e.org_name} (epoch ${e.current_epoch})`);
  }
}

async function cmdVaultUnlock(flags: Record<string, string>) {
  const passphrase = requireFlag(flags, 'passphrase');
  await unlockVault(passphrase);
  console.log('Vault unlocked.');
}

async function cmdRecoveryStatus(flags: Record<string, string>) {
  if (!await vaultExists()) die('No vault found.');
  if (!isVaultUnlocked()) die('Vault is locked. Run vault-unlock first.');
  const cache = getVaultCache();
  if (!cache || cache.entries.length === 0) die('Vault empty.');
  const entries = flags['org'] ? cache.entries.filter(e => e.org_id === flags['org']) : cache.entries;
  for (const entry of entries) {
    console.log(`\n${entry.org_id} — ${entry.org_name} (epoch ${entry.current_epoch})`);
    console.log(`  Master key: ${entry.k_master_hex?.length === 64 ? '✓ present' : '✗ MISSING'}`);
    console.log(`  Recovery phrase: ${entry.recovery_phrase?.trim().split(/\s+/).length >= 24 ? '✓ present' : '✗ MISSING'}`);
    console.log(`  Mod key: ${entry.sk_mod_hex?.length === 64 ? '✓ present' : '✗ missing'}`);
  }
}

async function cmdRecoverOrg(flags: Record<string, string>) {
  const orgId = requireFlag(flags, 'org');
  const phrase = requireFlag(flags, 'phrase');
  const masterKey = reconstructMasterKey(phrase);
  deriveEpochKeys(masterKey, 0);
  await storeKeyEnvelope(orgId, 'master', masterKey);
  console.log(`Master key recovered for org ${orgId}. Epoch key derivation verified.`);
}

async function cmdSetupThreshold(flags: Record<string, string>) {
  const orgId = requireFlag(flags, 'org');
  const share3Hex = requireFlag(flags, 'share3');
  const share2Hex = flags['share2'];

  const identity = await loadIdentity();
  if (!identity) die('No identity found.');

  const membership = await getMembership(orgId);
  if (membership.role !== 'leader') die('Only leaders can set up threshold recovery.');

  const masterKey = await loadKeyEnvelope(orgId, 'master');
  if (!masterKey) die('Master key not found.');

  const { shares } = splitMasterKey(masterKey);
  const share1Sealed = sealToPubkey(shares[0], identity.xPubkey);

  const { pubkeyHex, headers } = await buildWeVibeSignedAuth();

  if (!share2Hex) die('--share2 is required.');

  const share2Pubkey = new Uint8Array(Buffer.from(share2Hex, 'hex'));
  const share2Sealed = sealToPubkey(shares[1], share2Pubkey);
  const share3Pubkey = new Uint8Array(Buffer.from(share3Hex, 'hex'));
  const share3Sealed = sealToPubkey(shares[2], share3Pubkey);

  const resp = await fetch(`${HUB_URL}/v1/orgs/${orgId}/recovery/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      org_id: orgId, agent_pubkey: pubkeyHex,
      shares: [
        { holder: 'leader', sealed: Buffer.from(share1Sealed).toString('hex') },
        { holder: 'share2', sealed: Buffer.from(share2Sealed).toString('hex'), holder_pubkey: share2Hex },
        { holder: 'share3', sealed: Buffer.from(share3Sealed).toString('hex'), holder_pubkey: share3Hex },
      ],
    }),
  });
  if (!resp.ok) die(`Failed to upload shares: ${resp.statusText}`);
  console.log(`Threshold recovery set up. 2-of-3 shares distributed.`);
}

async function cmdRecoverThreshold(flags: Record<string, string>) {
  const orgId = requireFlag(flags, 'org');
  const shareHex = requireFlag(flags, 'share');

  const identity = await loadIdentity();
  if (!identity) die('No identity found.');

  const { pubkeyHex, headers } = await buildWeVibeSignedAuth();

  const resp = await fetch(`${HUB_URL}/v1/orgs/${orgId}/recovery/shares/${pubkeyHex}`, { headers });
  if (!resp.ok) die('Failed to fetch share from hub.');
  const data = await resp.json() as { sealed?: string };
  if (!data.sealed) die('No sealed share found on hub.');

  const hubShare = new Uint8Array(Buffer.from(data.sealed, 'hex'));
  const share1 = openEnvelope(hubShare, identity.xPrivkey);
  const share2 = new Uint8Array(Buffer.from(shareHex, 'hex'));
  const masterKey = reconstructFromShares([share1, share2]);
  deriveEpochKeys(masterKey, 0);
  await storeKeyEnvelope(orgId, 'master', masterKey);
  console.log(`Master key recovered for org ${orgId}. Stored in vault.`);
}

function printHelp() {
  console.log(`wevibe-admin — WeVibe Network administrative CLI

Commands:
  setup-identity [--json]         Generate Ed25519 + X25519 keypair
  identity-status [--json]        Report identity state (no biometric prompt)
  resolve-endpoints [--json]      Resolve org hub endpoints from chain into sidecar
  export-identity                 Show this identity's 24-word recovery/pairing phrase
  import-identity --phrase [--force]   Restore/pair an identity from a 24-word phrase
  pair --code [--force]           Pair identity from dashboard one-time code
  export-pairing [--no-open] [--json]  Export pairing code for dashboard identity adoption
  create-org --name --domain      Create a new org
  orgs                            List org memberships
  invite --org --pubkey --x25519 --pre-pubkey [--role]   Invite a member
  rotate --org                    Rotate encryption epoch
  provision-recall --org          Derive and upload leader kfrag for recall
  moderate-queue [--org]          View pending submissions
  moderate-approve --hash [--org] Approve submission
  moderate-deny --hash --reason [--org]     Deny submission
  keywords list|add|merge|rename|deprecate  Manage org keywords
  vault-status                    Check vault state
  vault-unlock --passphrase       Unlock the vault
  recovery-status [--org]         Check recovery health
  recover-org --org --phrase      Recover from 24-word phrase
  setup-threshold --org --share2 --share3   Set up 2-of-3 recovery
  recover-threshold --org --share           Recover from threshold shares

Environment:
  WEVIBE_HUB_URL    Hub URL (default: ${HUB_URL})
  WEVIBE_CHAIN_REST_URL  Chain REST URL (default: ${CHAIN_REST_URL})
`);
}

async function main() {
  const { command, flags } = parseArgs();

  if (command === 'resolve-endpoints') {
    return cmdResolveEndpoints(flags);
  }

  const storedPassphrase = await retrievePassphraseFromKeychain();
  if (storedPassphrase) {
    try { await unlockVault(storedPassphrase); } catch {}
  }

  await initCrypto();

  switch (command) {
    case 'setup-identity': return cmdSetupIdentity(flags);
    case 'identity-status': return cmdIdentityStatus(flags);
    case 'resolve-endpoints': return cmdResolveEndpoints(flags);
    case 'export-identity': return cmdExportIdentity();
    case 'import-identity': return cmdImportIdentity(flags);
    case 'pair': return cmdPair(flags);
    case 'export-pairing': return cmdExportPairing(flags);
    case 'create-org': return cmdCreateOrg(flags);
    case 'orgs': return cmdOrgs();
    case 'invite': return cmdInvite(flags);
    case 'rotate': return cmdRotate(flags);
    case 'provision-recall': return cmdProvisionRecall(flags);
    case 'moderate-queue': return cmdModerateQueue(flags);
    case 'moderate-approve': return cmdModerateApprove(flags);
    case 'moderate-deny': return cmdModerateDeny(flags);
    case 'keywords': return cmdKeywords(flags);
    case 'vault-status': return cmdVaultStatus();
    case 'vault-unlock': return cmdVaultUnlock(flags);
    case 'recovery-status': return cmdRecoveryStatus(flags);
    case 'recover-org': return cmdRecoverOrg(flags);
    case 'setup-threshold': return cmdSetupThreshold(flags);
    case 'recover-threshold': return cmdRecoverThreshold(flags);
    case 'help': case '--help': case '-h': return printHelp();
    default: console.error(`Unknown command: ${command}`); printHelp(); process.exit(1);
  }
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

if (isMainModule()) {
  main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
}
