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
 *   wevibe-admin create-org --name "My Org" --domain example.com
 *   wevibe-admin orgs
 *   wevibe-admin invite --org <org_id> --pubkey <hex> --x25519 <hex> --pre-pubkey <hex> --role member|moderator
 *   wevibe-admin rotate --org <org_id>
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

import { initCrypto, generateIdentity, deriveEpochKeys, sealToPubkey, openEnvelope, decryptSymmetric } from './crypto.js';
import { loadIdentity, storeIdentity, loadKeyEnvelope, storeKeyEnvelope } from './key-store.js';
import { generateRecoveryPhrase, reconstructMasterKey, splitMasterKey, reconstructFromShares } from './recovery.js';
import { loadMemberships, createOrg, inviteMember, rotateEpoch } from './org-client.js';
import { fetchPendingQueue, decryptPendingItem, approveSubmission, denySubmission, scanForSteganography } from './moderation.js';
import { buildWeVibeSignedAuth, getOrCreatePreIdentity, getPrePublicKeyHex } from './auth.js';
import { vaultExists, isVaultUnlocked, unlockVault, listVaultEntries, getVaultCache, retrievePassphraseFromKeychain, lockVault } from './vault.js';
import { setLlmProvider } from './llm.js';
import { createOllamaProvider } from './llm-ollama.js';

const HUB_URL = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
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

async function cmdSetupIdentity() {
  const existing = await loadIdentity();
  if (existing) {
    console.log(`Identity already exists.`);
    console.log(`  Ed25519: ${uint8ArrayToHex(existing.edPubkey)}`);
    console.log(`  X25519:  ${uint8ArrayToHex(existing.xPubkey)}`);
    return;
  }
  const identity = generateIdentity();
  await storeIdentity({
    edPrivkeyB64: Buffer.from(identity.edPrivkey).toString('base64'),
    edPubkeyB64: Buffer.from(identity.edPubkey).toString('base64'),
    xPrivkeyB64: Buffer.from(identity.xPrivkey).toString('base64'),
    xPubkeyB64: Buffer.from(identity.xPubkey).toString('base64'),
  });
  console.log(`Identity created.`);
  console.log(`  Ed25519: ${uint8ArrayToHex(identity.edPubkey)}`);
  console.log(`  X25519:  ${uint8ArrayToHex(identity.xPubkey)}`);
  console.log(`\nShare these public keys with an org leader to receive an invitation.`);
}

async function cmdCreateOrg(flags: Record<string, string>) {
  const orgName = requireFlag(flags, 'name');
  const domain = requireFlag(flags, 'domain');
  const result = await createOrg({ orgName, domain, hubUrl: HUB_URL });
  if (result.status === 'error') die(`Org creation failed: ${result.error}`);

  const masterKey = await loadKeyEnvelope(result.orgId, 'master');
  if (!masterKey) die(`Org created (ID: ${result.orgId}) but master key not found.`);

  const phrase = generateRecoveryPhrase(masterKey);
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
  const role = (flags['role'] ?? 'member') as 'member' | 'moderator';

  const epochSk = await loadKeyEnvelope(orgId, 'epoch-sk');
  if (!epochSk) {
    die(`No epoch_sk found for org ${orgId}. Create or rotate the org first to refresh local epoch key material.`);
  }

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
    epochSkHex: Buffer.from(epochSk).toString('hex'),
    role,
    hubUrl: HUB_URL,
  });
  if (result.status === 'error') die(`Invitation failed: ${result.error}`);
  console.log(`Member invited to ${orgId} as ${role}.`);
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

async function cmdModerateQueue(flags: Record<string, string>) {
  const membership = await getMembership(flags['org']);
  if (membership.role !== 'leader' && membership.role !== 'moderator') die(`Role "${membership.role}" cannot moderate.`);

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
  if (membership.role !== 'leader' && membership.role !== 'moderator') die(`Role "${membership.role}" cannot approve.`);

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
  if (membership.role !== 'leader' && membership.role !== 'moderator') die(`Role "${membership.role}" cannot deny.`);

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
  setup-identity                  Generate Ed25519 + X25519 keypair
  create-org --name --domain      Create a new org
  orgs                            List org memberships
  invite --org --pubkey --x25519 --pre-pubkey [--role]   Invite a member
  rotate --org                    Rotate encryption epoch
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
  WEVIBE_HUB_URL    Hub URL (default: http://localhost:4440)
`);
}

async function main() {
  const ollamaUrl = process.env.WEVIBE_OLLAMA_URL ?? 'http://localhost:11434';
  const model = process.env.WEVIBE_EXTRACTION_MODEL ?? 'qwen3:4b';
  setLlmProvider(createOllamaProvider(ollamaUrl, model));

  const storedPassphrase = await retrievePassphraseFromKeychain();
  if (storedPassphrase) {
    try { await unlockVault(storedPassphrase); } catch {}
  }

  await initCrypto();
  const { command, flags } = parseArgs();

  switch (command) {
    case 'setup-identity': return cmdSetupIdentity();
    case 'create-org': return cmdCreateOrg(flags);
    case 'orgs': return cmdOrgs();
    case 'invite': return cmdInvite(flags);
    case 'rotate': return cmdRotate(flags);
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

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
