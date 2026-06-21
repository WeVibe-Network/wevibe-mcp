import * as crypto from 'node:crypto';
import { generateDek, encryptSymmetric, sealToPubkey, sign } from './crypto.js';
import { loadIdentity } from './key-store.js';
import { storePendingDek } from './pending-vault.js';
import { runWeVibeGuard } from './guard.js';
import { ensureCrypto } from './crypto-utils.js';
import { runAttestationHook, computeSessionHash } from './attestation.js';
import type { OrgMembership, AttestationMetadata, ProvenanceTier } from './types.js';
import { submitMemoryMessage } from './canonical.js';
import type { MemoryType } from './types.js';

type MemoryKeywordMetadata = {
  classified: Array<{ keyword: string; weight: number; base_weight: number }>;
  suggestions: Array<{ keyword: string; weight: number; base_weight: number; rationale: string }>;
};

export async function submitMemory(
  rawNotes: string,
  orgId: string,
  hubUrl: string,
  membership: OrgMembership,
  memoryType: MemoryType,
  stackHint?: string[],
  sessionTranscript?: string,
  keywords?: MemoryKeywordMetadata,
): Promise<{ status: string; submissionHash?: string; error?: string; attestation?: AttestationMetadata }> {
  if (!memoryType) {
    return { status: 'error', error: 'memory_type is required, did Pass 1 extraction run?' };
  }

  await ensureCrypto();

  let attestation: AttestationMetadata | undefined;

  if (sessionTranscript) {
    const sessionHash = computeSessionHash(sessionTranscript);
    const maybeAttestation = await runAttestationHook(
      sessionTranscript,
      rawNotes,
      membership.allowedProviders[0] ?? 'unknown',
    );
    if (maybeAttestation) {
      attestation = maybeAttestation;
    } else {
      attestation = {
        provenance: 'unattested' as ProvenanceTier,
        attestor_signature: '',
        attestation_timestamp: new Date().toISOString(),
        model_identity: membership.allowedProviders[0] ?? 'unknown',
        session_hash: sessionHash,
        domain_tags: [],
        challenge_params: {
          audit_tier: 'sampled',
          tokens_challenged: 0,
          total_tokens: 0,
        },
      };
    }
  }

  try {
    const guardResult = runWeVibeGuard(rawNotes, [], {}, { stack: stackHint });
    if (!guardResult.passed) {
      console.warn(`wevibe-mcp: wevibe-guard flagged submission: ${JSON.stringify(guardResult.detections)}`);
    }
  } catch {
    console.warn('wevibe-mcp: wevibe-guard unavailable — proceeding without local scan');
  }

  if (!membership.modPubkey) {
    return { status: 'error', error: 'no mod_pubkey in membership' };
  }

  const dek = generateDek();
  const plaintextBytes = Buffer.from(rawNotes, 'utf-8');
  const salt = crypto.randomBytes(32);
  const plaintextHash = crypto
    .createHash('sha256')
    .update(Buffer.concat([salt, plaintextBytes]))
    .digest('hex');
  const ciphertext = encryptSymmetric(new Uint8Array(plaintextBytes), dek);
  const wrappedDekMod = sealToPubkey(dek, membership.modPubkey);
  const ciphertextHash = crypto.createHash('sha256').update(Buffer.from(ciphertext)).digest('hex');
  const wrappedDekHash = crypto.createHash('sha256').update(Buffer.from(wrappedDekMod)).digest('hex');

  const hashInput = Buffer.concat([Buffer.from(ciphertext), Buffer.from(wrappedDekMod)]);
  const submissionHashRaw = crypto.createHash('sha256').update(hashInput).digest();

  const identity = await loadIdentity();
  if (!identity) {
    return { status: 'error', error: 'no identity in keychain' };
  }

  const submissionHash = Buffer.from(submissionHashRaw).toString('hex');
  const contributorPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');

  const canonical = submitMemoryMessage(
    orgId,
    membership.currentEpoch,
    submissionHash,
    contributorPubkeyHex,
    memoryType,
    ciphertextHash,
    plaintextHash,
    salt.toString('hex'),
    wrappedDekHash,
  );
  const sig = sign(identity.edPrivkey, canonical);

  const payload = {
    org_id: orgId,
    epoch_id: membership.currentEpoch,
    ciphertext: Buffer.from(ciphertext).toString('hex'),
    wrapped_dek_mod: Buffer.from(wrappedDekMod).toString('hex'),
    submission_hash: submissionHash,
    plaintext_hash: plaintextHash,
    salt: salt.toString('hex'),
    ciphertext_hash: ciphertextHash,
    wrapped_dek_hash: wrappedDekHash,
    contributor_pubkey: contributorPubkeyHex,
    contributor_sig: Buffer.from(sig).toString('hex'),
    memory_type: memoryType,
    stack_hint: stackHint ?? [],
    keywords: keywords ?? { classified: [], suggestions: [] },
    attestation: attestation ?? null,
  };

  try {
    const response = await fetch(`${hubUrl}/v1/orgs/${orgId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn(`wevibe-mcp: submitMemory — Hub returned ${response.status}`);
    }
  } catch (e) {
    console.warn(`wevibe-mcp: submitMemory — Hub unavailable: ${e}`);
  }

  await storePendingDek(
    submissionHash,
    orgId,
    membership.currentEpoch,
    dek,
    rawNotes.slice(0, 100),
  );

  return { status: 'pending', submissionHash, attestation };
}
