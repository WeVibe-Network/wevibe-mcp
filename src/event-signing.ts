import { createHash } from 'node:crypto';
import { signCanonicalBody, normalizeHex } from './serve-signing.js';

const textEncoder = new TextEncoder();
const CANONICAL_EVENT_VERSION = 'wevibe-event-v1';
const OUTCOME_EVENT_TOKEN = 'outcome';

export interface CanonicalOutcomeEventBodyInput {
  orgId: string;
  memoryHash: string | Uint8Array;
  epoch: number;
  signerPubkey: string | Uint8Array;
  nonce: string | Uint8Array;
  episodeRef: string | Uint8Array;
  worked: boolean;
  evidenceRef: string | Uint8Array;
}

function ensureOrgId(orgId: string): void {
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error('org_id must be a non-empty string');
  }
}

function ensureEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > Number.MAX_SAFE_INTEGER) {
    throw new Error(`epoch must be a non-negative integer <= ${Number.MAX_SAFE_INTEGER}`);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function normalizeHexOrBytes(value: string | Uint8Array, fieldName: string): string {
  if (value instanceof Uint8Array) {
    return bytesToHex(value);
  }
  return normalizeHex(value, fieldName);
}

function ensureFixedBytes(hexValue: string, expectedBytes: number, fieldName: string): void {
  if (hexValue.length !== expectedBytes * 2) {
    throw new Error(`${fieldName} must be ${expectedBytes} bytes`);
  }
}

function ensureVarBytes(hexValue: string, minBytes: number, maxBytes: number, fieldName: string): void {
  const byteLength = hexValue.length / 2;
  if (byteLength < minBytes || byteLength > maxBytes) {
    throw new Error(`${fieldName} must be between ${minBytes} and ${maxBytes} bytes`);
  }
}

export function buildCanonicalOutcomeEventBodyBytes(input: CanonicalOutcomeEventBodyInput): Uint8Array {
  ensureOrgId(input.orgId);
  ensureEpoch(input.epoch);

  const memoryHashHex = normalizeHexOrBytes(input.memoryHash, 'memory_hash');
  const signerPubkeyHex = normalizeHexOrBytes(input.signerPubkey, 'signer_pubkey');
  const nonceHex = normalizeHexOrBytes(input.nonce, 'nonce');
  const episodeRefHex = normalizeHexOrBytes(input.episodeRef, 'episode_ref');
  const evidenceRefHex = normalizeHexOrBytes(input.evidenceRef, 'evidence_ref');

  ensureFixedBytes(memoryHashHex, 32, 'memory_hash');
  ensureFixedBytes(signerPubkeyHex, 32, 'signer_pubkey');
  ensureVarBytes(nonceHex, 1, 64, 'nonce');
  ensureVarBytes(episodeRefHex, 1, 64, 'episode_ref');
  ensureVarBytes(evidenceRefHex, 1, 64, 'evidence_ref');

  const body = [
    CANONICAL_EVENT_VERSION,
    OUTCOME_EVENT_TOKEN,
    input.orgId,
    memoryHashHex,
    String(input.epoch),
    signerPubkeyHex,
    episodeRefHex,
    `worked=${input.worked ? 'true' : 'false'}`,
    evidenceRefHex,
    nonceHex,
  ].join('\n');

  return textEncoder.encode(body);
}

export function computeEventFingerprint(body: Uint8Array): Uint8Array {
  return createHash('sha256').update(body).digest();
}

export { signCanonicalBody };
