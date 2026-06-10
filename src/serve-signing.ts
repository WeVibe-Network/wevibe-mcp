import { createHash } from 'node:crypto';
import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { loadIdentity } from './key-store.js';

const textEncoder = new TextEncoder();

const ORG_SERVE_KEY_HKDF_SALT = textEncoder.encode('wevibe-org-serve-key-v1-salt');
const ORG_SERVE_KEY_HKDF_INFO_PREFIX = 'wevibe-org-serve-key-v1:';

const CANONICAL_SERVE_VERSION = 'wevibe-serve-v1';
const CANONICAL_DENIAL_VERSION = 'wevibe-denial-v1';

export interface OrgServeKeypair {
  priv: Uint8Array;
  pub: Uint8Array;
  pubHex: string;
}

export interface CanonicalServeBodyInput {
  orgId: string;
  memoryContentHashHex: string;
  epoch: number;
  serveKeyPubkeyHex: string;
  matchedKeywords: string[];
  nonceHex: string;
}

export interface CanonicalDenialBodyInput {
  orgId: string;
  memoryHashHex: string;
  epoch: number;
  serveKeyPubkeyHex: string;
  serveFingerprintHex: string;
  nonceHex: string;
}

function ensureEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > Number.MAX_SAFE_INTEGER) {
    throw new Error(`epoch must be a non-negative integer <= ${Number.MAX_SAFE_INTEGER}`);
  }
}

function ensureOrgId(orgId: string): void {
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error('org_id must be a non-empty string');
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function ensureFixedHexLength(normalizedHex: string, expectedBytes: number, fieldName: string): void {
  if (normalizedHex.length !== expectedBytes * 2) {
    throw new Error(`${fieldName} must be ${expectedBytes} bytes`);
  }
}

function epochToBigEndianUint64(epoch: number): Uint8Array {
  ensureEpoch(epoch);
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(0, BigInt(epoch), false);
  return out;
}

function sortedKeywords(keywords: string[]): string[] {
  if (!Array.isArray(keywords)) {
    throw new Error('matched_keywords must be an array of strings');
  }
  if (keywords.some(keyword => typeof keyword !== 'string')) {
    throw new Error('matched_keywords must contain only strings');
  }
  return [...keywords].sort();
}

export function normalizeHex(hexValue: string, fieldName: string): string {
  if (typeof hexValue !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const normalized = hexValue.trim().toLowerCase();
  if (normalized.startsWith('0x')) {
    throw new Error(`${fieldName} must not include 0x prefix`);
  }
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(`${fieldName} must be lowercase hex`);
  }
  return normalized;
}

export function deriveOrgServeSeed(identitySeed: Uint8Array, orgId: string): Uint8Array {
  ensureOrgId(orgId);
  if (identitySeed.length !== 32) {
    throw new Error('identity seed must be 32 bytes');
  }
  const info = textEncoder.encode(`${ORG_SERVE_KEY_HKDF_INFO_PREFIX}${orgId}`);
  return hkdf(sha256, identitySeed, ORG_SERVE_KEY_HKDF_SALT, info, 32);
}

export async function ed25519KeypairFromSeed(seed: Uint8Array): Promise<OrgServeKeypair> {
  if (seed.length !== 32) {
    throw new Error('ed25519 seed must be 32 bytes');
  }
  const priv = new Uint8Array(seed);
  const pub = await getPublicKeyAsync(priv);
  return {
    priv,
    pub,
    pubHex: bytesToHex(pub),
  };
}

export async function deriveOrgServeKeyFromIdentitySeed(identitySeed: Uint8Array, orgId: string): Promise<OrgServeKeypair> {
  const orgServeSeed = deriveOrgServeSeed(identitySeed, orgId);
  return ed25519KeypairFromSeed(orgServeSeed);
}

export async function deriveOrgServeKey(orgId: string): Promise<OrgServeKeypair> {
  const identity = await loadIdentity();
  if (!identity) {
    throw new Error('identity not found');
  }
  return deriveOrgServeKeyFromIdentitySeed(identity.edPrivkey, orgId);
}

export function buildCanonicalServeBody(input: CanonicalServeBodyInput): string {
  ensureOrgId(input.orgId);
  ensureEpoch(input.epoch);

  const memoryContentHashHex = normalizeHex(input.memoryContentHashHex, 'memory_content_hash');
  const serveKeyPubkeyHex = normalizeHex(input.serveKeyPubkeyHex, 'serve_key_pubkey');
  const nonceHex = normalizeHex(input.nonceHex, 'nonce');

  ensureFixedHexLength(memoryContentHashHex, 32, 'memory_content_hash');
  ensureFixedHexLength(serveKeyPubkeyHex, 32, 'serve_key_pubkey');

  const nonceBytes = Buffer.from(nonceHex, 'hex');
  if (nonceBytes.length < 4 || nonceBytes.length > 16) {
    throw new Error('nonce must be between 4 and 16 bytes');
  }

  const keywordsJoined = sortedKeywords(input.matchedKeywords).join(',');
  return [
    CANONICAL_SERVE_VERSION,
    input.orgId,
    memoryContentHashHex,
    String(input.epoch),
    serveKeyPubkeyHex,
    keywordsJoined,
    nonceHex,
  ].join('\n');
}

export function buildCanonicalServeBodyBytes(input: CanonicalServeBodyInput): Uint8Array {
  return textEncoder.encode(buildCanonicalServeBody(input));
}

export function computeServeFingerprintHex(input: {
  memoryContentHashHex: string;
  serveKeyPubkeyHex: string;
  epoch: number;
}): string {
  ensureEpoch(input.epoch);
  const memoryContentHashHex = normalizeHex(input.memoryContentHashHex, 'memory_content_hash');
  const serveKeyPubkeyHex = normalizeHex(input.serveKeyPubkeyHex, 'serve_key_pubkey');

  ensureFixedHexLength(memoryContentHashHex, 32, 'memory_content_hash');
  ensureFixedHexLength(serveKeyPubkeyHex, 32, 'serve_key_pubkey');

  const digest = createHash('sha256')
    .update(Buffer.from(memoryContentHashHex, 'hex'))
    .update(Buffer.from(serveKeyPubkeyHex, 'hex'))
    .update(Buffer.from(epochToBigEndianUint64(input.epoch)))
    .digest();

  return digest.toString('hex');
}

export function buildCanonicalDenialBody(input: CanonicalDenialBodyInput): string {
  ensureOrgId(input.orgId);
  ensureEpoch(input.epoch);

  const memoryHashHex = normalizeHex(input.memoryHashHex, 'memory_hash');
  const serveKeyPubkeyHex = normalizeHex(input.serveKeyPubkeyHex, 'serve_key_pubkey');
  const serveFingerprintHex = normalizeHex(input.serveFingerprintHex, 'serve_fingerprint');
  const nonceHex = normalizeHex(input.nonceHex, 'nonce');

  ensureFixedHexLength(memoryHashHex, 32, 'memory_hash');
  ensureFixedHexLength(serveKeyPubkeyHex, 32, 'serve_key_pubkey');
  ensureFixedHexLength(serveFingerprintHex, 32, 'serve_fingerprint');

  const nonceBytes = Buffer.from(nonceHex, 'hex');
  if (nonceBytes.length < 4 || nonceBytes.length > 16) {
    throw new Error('nonce must be between 4 and 16 bytes');
  }

  return [
    CANONICAL_DENIAL_VERSION,
    input.orgId,
    memoryHashHex,
    String(input.epoch),
    serveKeyPubkeyHex,
    serveFingerprintHex,
    nonceHex,
  ].join('\n');
}

export function buildCanonicalDenialBodyBytes(input: CanonicalDenialBodyInput): Uint8Array {
  return textEncoder.encode(buildCanonicalDenialBody(input));
}

export async function signCanonicalBody(canonicalBody: Uint8Array, serveKeyPriv: Uint8Array): Promise<string> {
  if (serveKeyPriv.length !== 32) {
    throw new Error('serve key seed must be 32 bytes');
  }
  const sig = await signAsync(canonicalBody, serveKeyPriv);
  return bytesToHex(sig);
}
