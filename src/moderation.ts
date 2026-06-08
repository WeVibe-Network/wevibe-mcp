import { openEnvelope, decryptSymmetric, sign } from './crypto.js';
import { loadIdentity } from './key-store.js';
import { buildWeVibeSignedAuth } from './auth.js';
import { ensureCrypto } from './crypto-utils.js';
import type { OrgMembership, MemoryType } from './types.js';
import { approveSubmissionMessageSimple, denySubmissionMessage } from './canonical.js';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PendingQueueItem {
  submission_hash: string;
  org_id: string;
  epoch_id: number;
  contributor_pubkey: string;
  contributor_wallet?: string;
  contributor_display_name?: string;
  ciphertext_hex: string;
  wrapped_dek_mod: string;
  stack_hint: string[];
  memory_type: MemoryType;
  created_at: string;
  status: string;
  votes?: number;
  required_approvals?: number;
  voter_pubkeys?: string[];
}

export interface ModerationHistoryItem {
  submission_hash: string;
  memory_type: MemoryType;
  epoch_id: number;
  decision: 'approved' | 'denied';
  status: string;
  moderator_pubkey: string | null;
  decided_at: string;
  denial_reason: string | null;
}

export interface DecryptedPendingItem {
  submissionHash: string;
  epochId: number;
  contributorPubkey: string;
  contributorWallet?: string;
  contributorDisplayName?: string;
  stackHint: string[];
  memoryType: MemoryType;
  createdAt: string;
  plaintext: string;
  decryptError?: string;
  stegScan?: StegScanResult;
}

export interface StegScanResult {
  version: string;
  input_bytes: number;
  findings_count: number;
  clean: boolean;
  findings: StegFinding[];
}

export interface StegFinding {
  type: 'detector' | 'decoder' | 'error';
  name: string;
  severity: 'high' | 'medium' | 'critical' | 'info';
  details: Record<string, unknown>;
}

function getStegScanBin(): string {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
  return join(projectRoot, 'scripts/wevibe-steg-scan.py');
}

async function parseHttpError(response: Response): Promise<string> {
  try {
    const errBody = await response.json() as { error?: string };
    return errBody.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function scanForSteganography(text: string): StegScanResult | null {
  const bin = getStegScanBin();
  const result = spawnSync('python3', [bin], {
    input: text,
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as StegScanResult;
  } catch {
    return null;
  }
}

export async function fetchPendingQueue(
  hubUrl: string,
  orgId: string,
): Promise<PendingQueueItem[]> {
  await ensureCrypto();

  const { headers } = await buildWeVibeSignedAuth();

  const response = await fetch(
    `${hubUrl}/v1/orgs/${orgId}/moderation/queue`,
    { headers },
  );

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`hub returned ${response.status}: ${errBody}`);
  }

  return await response.json() as PendingQueueItem[];
}

export async function fetchModerationHistory(
  hubUrl: string,
  orgId: string,
): Promise<ModerationHistoryItem[]> {
  await ensureCrypto();

  const { headers } = await buildWeVibeSignedAuth();

  const response = await fetch(
    `${hubUrl}/v1/orgs/${orgId}/moderation/history`,
    { headers },
  );

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`hub returned ${response.status}: ${errBody}`);
  }

  const payload = await response.json() as { items: ModerationHistoryItem[] };
  return payload.items;
}

export function decryptPendingItem(
  item: PendingQueueItem,
  membership: OrgMembership,
): DecryptedPendingItem {
  const result: DecryptedPendingItem = {
    submissionHash: item.submission_hash,
    epochId: item.epoch_id,
    contributorPubkey: item.contributor_pubkey,
    contributorWallet: item.contributor_wallet,
    contributorDisplayName: item.contributor_display_name,
    stackHint: item.stack_hint ?? [],
    memoryType: item.memory_type,
    createdAt: item.created_at,
    plaintext: '',
  };

  if (!membership.modPrivkey) {
    result.decryptError = 'no moderation private key available';
    return result;
  }

  try {
    const wrappedDekModBytes = new Uint8Array(Buffer.from(item.wrapped_dek_mod, 'hex'));
    const dek = openEnvelope(wrappedDekModBytes, membership.modPrivkey);

    const ciphertextBytes = new Uint8Array(Buffer.from(item.ciphertext_hex, 'hex'));
    const plaintext = decryptSymmetric(ciphertextBytes, dek);
    result.plaintext = Buffer.from(plaintext).toString('utf-8');
  } catch (e) {
    result.decryptError = `decryption failed: ${(e as Error).message}`;
  }

  return result;
}

export interface SimilarMemory {
  cid: string;
  score: number;
  breakdown?: Record<string, unknown>;
}

export interface ApproveResult {
  status: 'approved' | 'error';
  error?: string;
  similarMemories?: SimilarMemory[];
}

export async function approveSubmission(
  hubUrl: string,
  orgId: string,
  item: PendingQueueItem,
  membership: OrgMembership,
): Promise<ApproveResult> {
  await ensureCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    return { status: 'error', error: 'no identity in keychain' };
  }

  if (!membership.modPrivkey) {
    return { status: 'error', error: 'no moderation private key — cannot approve' };
  }

  let dek: Uint8Array;
  try {
    const wrappedDekModBytes = new Uint8Array(Buffer.from(item.wrapped_dek_mod, 'hex'));
    dek = openEnvelope(wrappedDekModBytes, membership.modPrivkey);
  } catch (e) {
    return { status: 'error', error: `failed to unseal DEK: ${(e as Error).message}` };
  }

  let plaintext: string;
  try {
    const ciphertextBytes = new Uint8Array(Buffer.from(item.ciphertext_hex, 'hex'));
    const decrypted = decryptSymmetric(ciphertextBytes, dek);
    plaintext = Buffer.from(decrypted).toString('utf-8');
  } catch (e) {
    return { status: 'error', error: `failed to decrypt content: ${(e as Error).message}` };
  }

  const moderatorPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
  const memoryType = item.memory_type;

	if (memoryType !== 'memory') {
		return { status: 'error', error: 'memory_type is required for approval' };
	}

  const canonical = approveSubmissionMessageSimple(
    orgId,
    item.submission_hash,
    item.epoch_id,
    memoryType,
    moderatorPubkeyHex,
  );
  const sigBytes = sign(identity.edPrivkey, canonical);
  const moderatorSigHex = Buffer.from(sigBytes).toString('hex');

  const requestBody = {
    epoch_id: item.epoch_id,
    memory_type: memoryType,
    moderator_sig: moderatorSigHex,
    signed_by: moderatorPubkeyHex,
  };

  const { headers: authHeaders } = await buildWeVibeSignedAuth();

  const response = await fetch(
    `${hubUrl}/v1/orgs/${orgId}/moderation/${item.submission_hash}/approve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    return { status: 'error', error: await parseHttpError(response) };
  }

  return { status: 'approved', similarMemories: [] };
}

export interface DenyResult {
  status: 'denied' | 'error';
  error?: string;
}

export async function denySubmission(
  hubUrl: string,
  orgId: string,
  submissionHash: string,
  reason: string,
): Promise<DenyResult> {
  await ensureCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    return { status: 'error', error: 'no identity in keychain' };
  }

  const moderatorPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');

  const canonical = denySubmissionMessage(orgId, submissionHash, reason, moderatorPubkeyHex);
  const sigBytes = sign(identity.edPrivkey, canonical);
  const moderatorSigHex = Buffer.from(sigBytes).toString('hex');

  const requestBody = {
    reason,
    signed_by: moderatorPubkeyHex,
    signature: moderatorSigHex,
  };

  const { headers: authHeaders } = await buildWeVibeSignedAuth();

  const response = await fetch(
    `${hubUrl}/v1/orgs/${orgId}/moderation/${submissionHash}/deny`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    return { status: 'error', error: await parseHttpError(response) };
  }

  return { status: 'denied' };
}

export interface VoteResult {
  status: string;
  votes: number;
  required_approvals: number;
  ready: boolean;
  error?: string;
}

export async function voteOnSubmission(
  hubUrl: string,
  orgId: string,
  submissionHash: string,
): Promise<VoteResult> {
  await ensureCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    return { status: 'error', error: 'no identity in keychain', votes: 0, required_approvals: 0, ready: false };
  }

  const moderatorPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
  const timestamp = new Date().toISOString();
  const sig = sign(identity.edPrivkey, new TextEncoder().encode(timestamp));
  const sigHex = Buffer.from(sig).toString('hex');

  const response = await fetch(
    `${hubUrl}/v1/orgs/${orgId}/moderation/${submissionHash}/vote`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `WeVibe-Signed pubkey=${moderatorPubkeyHex},timestamp=${timestamp},signature=${sigHex}`,
      },
    },
  );

  if (!response.ok) {
    return { status: 'error', error: await parseHttpError(response), votes: 0, required_approvals: 0, ready: false };
  }

  const result = await response.json() as { status: string; votes: number; required_approvals: number; ready: boolean };
  return result;
}
