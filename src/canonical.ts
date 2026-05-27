import { createHash } from 'node:crypto';
import type { MemoryType } from './types.js';

export interface FeeModel {
  tier?: string;
  monthly_credits?: number;
  per_query_cost?: number;
  overage_multiplier?: number;
  currency?: string;
}

export function createOrgMessage(
  orgId: string,
  leaderPubkey: string,
  leaderX25519Pubkey: string,
  orgName: string,
  domain: string,
  encEnvelope: string,
  searchEnvelope: string,
  modEnvelope: string,
  pkMod: string,
  feeModel: FeeModel | null,
): Uint8Array {
  const fmHash = feeModelHash(feeModel);
  const msg = [
    'wevibe.create_org.v1',
    `domain:${domain}`,
    `enc_envelope:${encEnvelope}`,
    `fee_model_hash:${fmHash}`,
    `leader_pubkey:${leaderPubkey}`,
    `leader_x25519_pubkey:${leaderX25519Pubkey}`,
    `mod_envelope:${modEnvelope}`,
    `org_id:${orgId}`,
    `org_name:${orgName}`,
    `pk_mod:${pkMod}`,
    `search_envelope:${searchEnvelope}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function inviteMemberMessage(
  orgId: string,
  pubkey: string,
  x25519Pubkey: string,
  role: string,
  signedBy: string,
  encEnvelope: string,
  searchEnvelope: string,
  modEnvelope: string,
): Uint8Array {
  const msg = [
    'wevibe.invite_member.v1',
    `enc_envelope:${encEnvelope}`,
    `mod_envelope:${modEnvelope}`,
    `org_id:${orgId}`,
    `pubkey:${pubkey}`,
    `role:${role}`,
    `search_envelope:${searchEnvelope}`,
    `signed_by:${signedBy}`,
    `x25519_pubkey:${x25519Pubkey}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function rotateEpochMessage(
  orgId: string,
  newPkMod: string,
  signedBy: string,
  envelopes: Array<{ pubkey: string; enc_envelope: string; search_envelope: string; mod_envelope?: string | null }>,
): Uint8Array {
  const envHash = envelopesHash(envelopes);
  const msg = [
    'wevibe.rotate_epoch.v1',
    `envelopes_hash:${envHash}`,
    `new_pk_mod:${newPkMod}`,
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function removeMemberMessage(
  orgId: string,
  pubkey: string,
  signedBy: string,
): Uint8Array {
  const msg = [
    'wevibe.remove_member.v1',
    `org_id:${orgId}`,
    `pubkey:${pubkey}`,
    `signed_by:${signedBy}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function submitMemoryMessage(
  orgId: string,
  epochId: number,
  submissionHash: string,
  contributorPubkey: string,
  memoryType: MemoryType,
  ciphertextHash: string,
  plaintextHash: string,
  salt: string,
  wrappedDekHash: string,
): Uint8Array {
  const msg = [
    'wevibe.submit_memory.v1',
    `ciphertext_hash:${ciphertextHash}`,
    `contributor_pubkey:${contributorPubkey}`,
    `epoch_id:${epochId}`,
    `memory_type:${memoryType}`,
    `org_id:${orgId}`,
    `plaintext_hash:${plaintextHash}`,
    `salt:${salt}`,
    `submission_hash:${submissionHash}`,
    `wrapped_dek_hash:${wrappedDekHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function approveSubmissionMessage(
  orgId: string,
  submissionHash: string,
  epochId: number,
  approvedCid: string,
  umbralCapsule: string,
  umbralCiphertext: string,
  memoryType: MemoryType,
  signedBy: string,
  keywords: { keyword: string; weight: number }[],
): Uint8Array {
  const keywordsHashStr = keywordsHash(keywords);
  const msg = [
    'wevibe.approve_submission.v1',
    `approved_cid:${approvedCid}`,
    `keywords_hash:${keywordsHashStr}`,
    `epoch_id:${epochId}`,
    `memory_type:${memoryType}`,
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
    `umbral_capsule:${umbralCapsule}`,
    `umbral_ciphertext:${umbralCiphertext}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function approveSubmissionMessageSimple(
  orgId: string,
  submissionHash: string,
  epochId: number,
  memoryType: MemoryType,
  signedBy: string,
): Uint8Array {
  const msg = [
    'wevibe.approve_submission.v2',
    `epoch_id:${epochId}`,
    `memory_type:${memoryType}`,
    `org_id:${orgId}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

export function denySubmissionMessage(
  orgId: string,
  submissionHash: string,
  reason: string,
  signedBy: string,
): Uint8Array {
  const msg = [
    'wevibe.deny_submission.v1',
    `org_id:${orgId}`,
    `reason:${reason}`,
    `signed_by:${signedBy}`,
    `submission_hash:${submissionHash}`,
  ].join('\n');
  return new TextEncoder().encode(msg);
}

function keywordsHash(keywords: { keyword: string; weight: number }[]): string {
  const sorted = [...keywords].sort((a, b) => a.keyword.localeCompare(b.keyword));
  const entries = sorted.map(kw => `${kw.keyword}:${kw.weight.toFixed(6)}`);
  const joined = entries.join('\n');
  return createHash('sha256').update(joined, 'utf-8').digest('hex');
}

export function feeModelHash(feeModel: FeeModel | null): string {
  if (!feeModel) {
    return createHash('sha256').update('{}', 'utf-8').digest('hex');
  }

  const parts: string[] = [];
  if (feeModel.tier !== undefined && feeModel.tier !== '') {
    parts.push(`"tier":${JSON.stringify(feeModel.tier)}`);
  }
  if (feeModel.monthly_credits !== undefined && feeModel.monthly_credits !== 0) {
    parts.push(`"monthly_credits":${feeModel.monthly_credits}`);
  }
  if (feeModel.per_query_cost !== undefined && feeModel.per_query_cost !== 0) {
    parts.push(`"per_query_cost":${feeModel.per_query_cost}`);
  }
  if (feeModel.overage_multiplier !== undefined && feeModel.overage_multiplier !== 0) {
    parts.push(`"overage_multiplier":${feeModel.overage_multiplier}`);
  }
  if (feeModel.currency !== undefined && feeModel.currency !== '') {
    parts.push(`"currency":${JSON.stringify(feeModel.currency)}`);
  }

  const canonical = '{' + parts.join(',') + '}';
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

function envelopesHash(
  envelopes: Array<{ pubkey: string; enc_envelope: string; search_envelope: string; mod_envelope?: string | null }>,
): string {
  const sorted = [...envelopes].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  const entries = sorted.map(e => {
    const modEnv = e.mod_envelope ?? '';
    return [
      `enc_envelope:${e.enc_envelope}`,
      `mod_envelope:${modEnv}`,
      `pubkey:${e.pubkey}`,
      `search_envelope:${e.search_envelope}`,
    ].join('\n');
  });
  const joined = entries.join('\n--\n');
  return createHash('sha256').update(joined, 'utf-8').digest('hex');
}
