import fs from 'node:fs';
import path from 'node:path';

import { sign, verify } from '../crypto.js';
import { ensureCrypto } from '../crypto-utils.js';
import { loadIdentity } from '../key-store.js';
import { emitNegativeReceipt, emitPredicateReceipt } from './ops.js';
import { receiptPath, receiptsDirPath } from './paths.js';
import { canonicalJson, computeEnvFp, sha256Hex } from './types.js';

const RECEIPT_VERSION = 'gstv-receipt-v1' as const;

export interface PredicateReceiptArtifact {
  v: 'gstv-receipt-v1';
  kind: 'predicate';
  goal_id: string;
  exit: number;
  env_fp: string;
  chain_head: string;
  predicate_hash: string;
  state_hash: string;
  attempts_to_green: number;
  bench_mock: true;
  issued_at: string;
  ed_pubkey_hex: string;
  contributor_sig: string;
}

export interface NegativeReceiptArtifact {
  v: 'gstv-receipt-v1';
  kind: 'negative';
  goal_id: string;
  cited_state_hash: string;
  cited_episode_id: string | null;
  absent_from_final: true;
  basis: 'cited_files_absent_from_closing_manifest';
  semantics: 'not_sufficient_as_tried_then';
  bench_mock: true;
  issued_at: string;
  ed_pubkey_hex: string;
  contributor_sig: string;
}

export interface WritePredicateReceiptInput {
  goal_id: string;
  exit: number;
  chain_head: string;
  predicate_hash: string;
  state_hash: string;
  attempts_to_green: number;
}

export interface WriteNegativeReceiptInput {
  goal_id: string;
  cited_state_hash: string;
  cited_episode_id: string | null;
}

export interface ReceiptContext {
  trace: string;
  session_id?: string;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort on non-POSIX platforms
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on non-POSIX platforms
  }
}

function sessionForLog(ctx: ReceiptContext): string {
  return ctx.session_id ?? '-';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signArtifact<T extends { contributor_sig: string; ed_pubkey_hex: string }>(
  identity: { edPrivkey: Uint8Array; edPubkey: Uint8Array },
  artifactWithoutSig: Omit<T, 'contributor_sig'>,
): T {
  const preimage = new TextEncoder().encode(canonicalJson(artifactWithoutSig));
  const contributorSig = Buffer.from(sign(identity.edPrivkey, preimage)).toString('hex');
  return {
    ...artifactWithoutSig,
    contributor_sig: contributorSig,
  } as T;
}

/**
 * Stable receipt ID over canonical JSON of the artifact without contributor_sig.
 */
export function receiptIdFor(artifactWithoutSig: unknown): string {
  return sha256Hex(canonicalJson(artifactWithoutSig));
}

/**
 * Tier labels are labels only (I-2): never a gate, never retrieval scoring.
 */
export function computeTierLabel(hasPredicateReceipt: boolean): 'T0' | 'T1' {
  return hasPredicateReceipt ? 'T1' : 'T0';
}

export function verifyReceiptSignature(artifact: PredicateReceiptArtifact | NegativeReceiptArtifact): boolean {
  try {
    const { contributor_sig, ...artifactWithoutSig } = artifact;
    const { ed_pubkey_hex } = artifact;
    if (typeof contributor_sig !== 'string' || !/^[0-9a-f]+$/.test(contributor_sig) || contributor_sig.length % 2 !== 0) {
      return false;
    }
    if (typeof ed_pubkey_hex !== 'string' || !/^[0-9a-f]{64}$/.test(ed_pubkey_hex)) {
      return false;
    }

    const preimage = new TextEncoder().encode(canonicalJson(artifactWithoutSig));
    return verify(Buffer.from(ed_pubkey_hex, 'hex'), Buffer.from(contributor_sig, 'hex'), preimage);
  } catch {
    return false;
  }
}

export async function writePredicateReceipt(
  goalDirPath: string,
  input: WritePredicateReceiptInput,
  ctx: ReceiptContext,
): Promise<{ receipt_id: string; artifact: PredicateReceiptArtifact }> {
  try {
    await ensureCrypto();
    const identity = await loadIdentity();
    if (!identity) {
      throw new Error('No WeVibe identity found. Create your identity first, then retry.');
    }

    const artifactWithoutSig: Omit<PredicateReceiptArtifact, 'contributor_sig'> = {
      v: RECEIPT_VERSION,
      kind: 'predicate',
      goal_id: input.goal_id,
      exit: input.exit,
      env_fp: computeEnvFp(),
      chain_head: input.chain_head,
      predicate_hash: input.predicate_hash,
      state_hash: input.state_hash,
      attempts_to_green: input.attempts_to_green,
      bench_mock: true,
      issued_at: new Date().toISOString(),
      ed_pubkey_hex: Buffer.from(identity.edPubkey).toString('hex'),
    };

    const artifact = signArtifact<PredicateReceiptArtifact>(identity, artifactWithoutSig);
    const receipt_id = receiptIdFor(artifactWithoutSig);

    fs.mkdirSync(receiptsDirPath(goalDirPath), { recursive: true });
    writeJsonAtomic(receiptPath(goalDirPath, receipt_id), artifact);

    emitPredicateReceipt({
      trace: ctx.trace,
      session_id: sessionForLog(ctx),
      goal_id: input.goal_id,
      exit: input.exit,
      env_fp: artifact.env_fp,
      chain_head_fp: artifact.chain_head,
      receipt_fp: receipt_id,
      sig_fp: artifact.contributor_sig,
      status: 'ok',
    });

    return { receipt_id, artifact };
  } catch (error) {
    emitPredicateReceipt({
      trace: ctx.trace,
      session_id: sessionForLog(ctx),
      goal_id: input.goal_id,
      exit: input.exit,
      env_fp: computeEnvFp(),
      chain_head_fp: input.chain_head,
      receipt_fp: '-',
      sig_fp: '-',
      status: 'error',
      err: errorMessage(error),
    });
    throw error;
  }
}

export async function writeNegativeReceipt(
  goalDirPath: string,
  input: WriteNegativeReceiptInput,
  ctx: ReceiptContext,
): Promise<{ receipt_id: string; artifact: NegativeReceiptArtifact }> {
  try {
    await ensureCrypto();
    const identity = await loadIdentity();
    if (!identity) {
      throw new Error('No WeVibe identity found. Create your identity first, then retry.');
    }

    const artifactWithoutSig: Omit<NegativeReceiptArtifact, 'contributor_sig'> = {
      v: RECEIPT_VERSION,
      kind: 'negative',
      goal_id: input.goal_id,
      cited_state_hash: input.cited_state_hash,
      cited_episode_id: input.cited_episode_id,
      absent_from_final: true,
      basis: 'cited_files_absent_from_closing_manifest',
      semantics: 'not_sufficient_as_tried_then',
      bench_mock: true,
      issued_at: new Date().toISOString(),
      ed_pubkey_hex: Buffer.from(identity.edPubkey).toString('hex'),
    };

    const artifact = signArtifact<NegativeReceiptArtifact>(identity, artifactWithoutSig);
    const receipt_id = receiptIdFor(artifactWithoutSig);

    fs.mkdirSync(receiptsDirPath(goalDirPath), { recursive: true });
    writeJsonAtomic(receiptPath(goalDirPath, receipt_id), artifact);

    emitNegativeReceipt({
      trace: ctx.trace,
      session_id: sessionForLog(ctx),
      goal_id: input.goal_id,
      cited_state_fp: input.cited_state_hash,
      receipt_fp: receipt_id,
      sig_fp: artifact.contributor_sig,
      status: 'ok',
    });

    return { receipt_id, artifact };
  } catch (error) {
    emitNegativeReceipt({
      trace: ctx.trace,
      session_id: sessionForLog(ctx),
      goal_id: input.goal_id,
      cited_state_fp: input.cited_state_hash,
      receipt_fp: '-',
      sig_fp: '-',
      status: 'error',
      err: errorMessage(error),
    });
    throw error;
  }
}
