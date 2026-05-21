import { sign } from './crypto.js';
import { randomBytes } from 'node:crypto';
import { getPublicKey } from '@noble/secp256k1';
import { getStore, loadIdentity } from './key-store.js';

export interface WeVibeAuthResult {
  pubkeyHex: string;
  headers: Record<string, string>;
}

export interface PreIdentity {
  secretKey: Buffer;
  publicKey: Buffer;
}

const KEYTAR_SERVICE = 'wevibe-network';
const PRE_IDENTITY_ACCOUNT = 'pre-identity-key';

let cachedPreIdentity: PreIdentity | null = null;
let preIdentityLoadPromise: Promise<PreIdentity> | null = null;

function parsePreIdentity(secretKeyHex: string): PreIdentity {
  if (!/^[0-9a-f]+$/i.test(secretKeyHex)) {
    throw new Error('invalid pre-identity-key hex in keychain');
  }

  const secretKey = Buffer.from(secretKeyHex, 'hex');
  if (secretKey.length !== 32) {
    throw new Error(`invalid pre-identity-key length: expected 32 bytes, got ${secretKey.length}`);
  }

  const publicKey = Buffer.from(getPublicKey(secretKey, true));
  if (publicKey.length !== 33) {
    throw new Error(`invalid PRE public key length: expected 33 bytes, got ${publicKey.length}`);
  }

  return { secretKey, publicKey };
}

async function createAndStorePreIdentity(): Promise<PreIdentity> {
  const store = getStore();

  while (true) {
    const secretKey = randomBytes(32);
    try {
      const publicKey = Buffer.from(getPublicKey(secretKey, true));
      await store.setPassword(KEYTAR_SERVICE, PRE_IDENTITY_ACCOUNT, secretKey.toString('hex'));
      return { secretKey, publicKey };
    } catch {
      // Rare invalid secp256k1 scalar, regenerate.
    }
  }
}

export async function getOrCreatePreIdentity(): Promise<PreIdentity> {
  if (cachedPreIdentity) {
    return cachedPreIdentity;
  }

  if (!preIdentityLoadPromise) {
    preIdentityLoadPromise = (async () => {
      const store = getStore();
      const storedSecretKeyHex = await store.getPassword(KEYTAR_SERVICE, PRE_IDENTITY_ACCOUNT);

      if (storedSecretKeyHex) {
        return parsePreIdentity(storedSecretKeyHex);
      }

      return await createAndStorePreIdentity();
    })();
  }

  try {
    cachedPreIdentity = await preIdentityLoadPromise;
    return cachedPreIdentity;
  } finally {
    preIdentityLoadPromise = null;
  }
}

function requirePreIdentityCache(): PreIdentity {
  if (!cachedPreIdentity) {
    throw new Error('PRE identity not initialized; call getOrCreatePreIdentity() first');
  }

  return cachedPreIdentity;
}

export function getPrePublicKeyHex(): string {
  return requirePreIdentityCache().publicKey.toString('hex');
}

export function getPreSecretKeyHex(): string {
  return requirePreIdentityCache().secretKey.toString('hex');
}

export async function buildWeVibeSignedAuth(): Promise<WeVibeAuthResult> {
  const identity = await loadIdentity();
  if (!identity) {
    throw new Error('no identity in keychain');
  }

  const pubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
  const timestamp = new Date().toISOString();
  const sig = sign(identity.edPrivkey, new TextEncoder().encode(timestamp));
  const sigHex = Buffer.from(sig).toString('hex');

  return {
    pubkeyHex,
    headers: {
      'Authorization': `WeVibe-Signed pubkey=${pubkeyHex},timestamp=${timestamp},signature=${sigHex}`,
    },
  };
}
