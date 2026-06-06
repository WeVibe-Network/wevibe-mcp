import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generateIdentityFromSeed } from './crypto.js';
import { requireBiometric } from './biometric.js';
import { getKeychainItem, setKeychainItem, deleteKeychainItem } from './keychain.js';

const SERVICE = 'wevibe-network';
const IDENTITY_SEED_ACCOUNT = 'identity-seed-v1';

type IdentityKeys = {
  edPrivkey: Uint8Array;
  edPubkey: Uint8Array;
  xPrivkey: Uint8Array;
  xPubkey: Uint8Array;
};

let cachedIdentity: IdentityKeys | null = null;

const isTestMode = () => process.env.WEVIBE_KEYSTORE_TEST === '1';

type SeedBackend = 'test' | 'keychain' | 'file';

function seedBackend(): SeedBackend {
  if (isTestMode()) return 'test';
  if (process.env.WEVIBE_SEED_BACKEND === 'file') return 'file';
  return 'keychain';
}

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

interface KeystoreData {
  [service: string]: {
    [account: string]: string;
  };
}

interface EncryptedKeystoreFile {
  version: 1;
  nonce_b64: string;
  ciphertext_b64: string;
  tag_b64: string;
}

const KEYSTORE_VERSION = 1;
const NONCE_BYTES = 12;

function getKeystoreDir(): string {
  const dir = process.env.WEVIBE_KEYSTORE_PATH || join(homedir(), '.wevibe', 'keys');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getKeystorePath(): string {
  const dir = getKeystoreDir();
  return join(dir, 'keys.json');
}

function getMachineSeedPath(): string {
  return join(getKeystoreDir(), 'machine-seed.bin');
}

function loadMachineSeed(): Buffer {
  const seedPath = getMachineSeedPath();
  if (existsSync(seedPath)) {
    return readFileSync(seedPath);
  }
  const seed = randomBytes(32);
  writeFileSync(seedPath, seed);
  chmodSync(seedPath, 0o600);
  return seed;
}

function deriveKeystoreKey(): Buffer {
  const seed = loadMachineSeed();
  return createHash('sha256').update('wevibe-keystore-v1').update(seed).digest();
}

function encryptKeystore(data: KeystoreData): EncryptedKeystoreFile {
  const key = deriveKeystoreKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: KEYSTORE_VERSION,
    nonce_b64: nonce.toString('base64'),
    ciphertext_b64: ciphertext.toString('base64'),
    tag_b64: tag.toString('base64'),
  };
}

function decryptKeystore(payload: EncryptedKeystoreFile): KeystoreData {
  const key = deriveKeystoreKey();
  const nonce = Buffer.from(payload.nonce_b64, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext_b64, 'base64');
  const tag = Buffer.from(payload.tag_b64, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf-8')) as KeystoreData;
}

function parseEncryptedKeystore(raw: string): EncryptedKeystoreFile | null {
  const parsed = JSON.parse(raw) as Partial<EncryptedKeystoreFile>;
  if (
    parsed.version !== KEYSTORE_VERSION ||
    typeof parsed.nonce_b64 !== 'string' ||
    typeof parsed.ciphertext_b64 !== 'string' ||
    typeof parsed.tag_b64 !== 'string'
  ) {
    return null;
  }
  return parsed as EncryptedKeystoreFile;
}

function loadKeystore(): KeystoreData {
  const path = getKeystorePath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const payload = parseEncryptedKeystore(readFileSync(path, 'utf-8'));
    if (!payload) {
      return {};
    }
    return decryptKeystore(payload);
  } catch {
    return {};
  }
}

function saveKeystore(data: KeystoreData): void {
  const path = getKeystorePath();
  const encrypted = encryptKeystore(data);
  writeFileSync(path, JSON.stringify(encrypted, null, 2), 'utf-8');
  chmodSync(path, 0o600);
}

const fileStore: KeytarLike = {
  async getPassword(service: string, account: string): Promise<string | null> {
    const data = loadKeystore();
    return data[service]?.[account] ?? null;
  },
  async setPassword(service: string, account: string, password: string): Promise<void> {
    const data = loadKeystore();
    if (!data[service]) {
      data[service] = {};
    }
    data[service][account] = password;
    saveKeystore(data);
  },
  async deletePassword(service: string, account: string): Promise<boolean> {
    const data = loadKeystore();
    if (data[service]?.[account]) {
      delete data[service][account];
      saveKeystore(data);
      return true;
    }
    return false;
  },
};

const testStoreMap = new Map<string, string>();
const testStore: KeytarLike = {
  async getPassword(service: string, account: string): Promise<string | null> {
    return testStoreMap.get(`${service}:${account}`) ?? null;
  },
  async setPassword(service: string, account: string, password: string): Promise<void> {
    testStoreMap.set(`${service}:${account}`, password);
  },
  async deletePassword(service: string, account: string): Promise<boolean> {
    return testStoreMap.delete(`${service}:${account}`);
  },
};

export function getStore(): KeytarLike {
  if (isTestMode()) {
    return testStore;
  }
  return fileStore;
}

export async function getDeviceKey(): Promise<Uint8Array> {
  const store = getStore();
  let stored = await store.getPassword(SERVICE, 'device-key-v1');
  if (!stored) {
    const key = randomBytes(32);
    stored = key.toString('base64');
    await store.setPassword(SERVICE, 'device-key-v1', stored);
  }
  return Buffer.from(stored, 'base64');
}

export async function storeKeyEnvelope(orgId: string, envelopeType: string, blob: Uint8Array): Promise<void> {
  const store = getStore();
  const account = `org-${orgId}-${envelopeType}`;
  await store.setPassword(SERVICE, account, Buffer.from(blob).toString('base64'));
}

export async function loadKeyEnvelope(orgId: string, envelopeType: string): Promise<Uint8Array | null> {
  const store = getStore();
  const account = `org-${orgId}-${envelopeType}`;
  const stored = await store.getPassword(SERVICE, account);
  if (!stored) return null;
  return Buffer.from(stored, 'base64');
}

async function storeIdentitySeedB64(seedB64: string): Promise<void> {
  const backend = seedBackend();
  if (backend === 'test') {
    await testStore.setPassword(SERVICE, IDENTITY_SEED_ACCOUNT, seedB64);
    return;
  }
  if (backend === 'file') {
    await fileStore.setPassword(SERVICE, IDENTITY_SEED_ACCOUNT, seedB64);
    return;
  }
  setKeychainItem(IDENTITY_SEED_ACCOUNT, seedB64);
}

async function loadIdentitySeedB64(): Promise<string | null> {
  const backend = seedBackend();
  if (backend === 'test') {
    return testStore.getPassword(SERVICE, IDENTITY_SEED_ACCOUNT);
  }
  if (backend === 'file') {
    return fileStore.getPassword(SERVICE, IDENTITY_SEED_ACCOUNT);
  }
  return getKeychainItem(IDENTITY_SEED_ACCOUNT);
}

export async function hasStoredIdentitySeed(): Promise<boolean> {
  const seedB64 = await loadIdentitySeedB64();
  return Boolean(seedB64);
}

export function generateIdentitySeed(): Uint8Array {
  return randomBytes(32);
}

export async function storeIdentitySeed(seed: Uint8Array): Promise<void> {
  if (seed.length !== 32) {
    throw new Error('identity seed must be 32 bytes');
  }

  await storeIdentitySeedB64(Buffer.from(seed).toString('base64'));
  cachedIdentity = null;
}

export async function loadIdentitySeed(): Promise<Uint8Array | null> {
  const seedB64 = await loadIdentitySeedB64();
  if (!seedB64) {
    return null;
  }
  if (seedBackend() === 'keychain') {
    const biometricOk = await requireBiometric('Export your WeVibe identity recovery phrase');
    if (!biometricOk) {
      throw new Error('biometric authentication failed');
    }
  }
  return Buffer.from(seedB64, 'base64');
}

export function clearTestStore(): void {
  testStoreMap.clear();
  cachedIdentity = null;
}

export function getTestStoreSnapshot(): Map<string, string> {
  return new Map(testStoreMap);
}

export function setTestStoreFromSnapshot(snapshot: Map<string, string>): void {
  testStoreMap.clear();
  if (!snapshot) return;
  const entries = Symbol.iterator in snapshot && !(snapshot instanceof Map)
    ? Array.from((snapshot as unknown as Iterable<[string, string]>))
    : snapshot instanceof Map
      ? snapshot
      : Object.entries(snapshot as Record<string, string>);
  for (const [k, v] of entries) {
    testStoreMap.set(k, v);
  }
}

export async function loadIdentity(): Promise<{
  edPrivkey: Uint8Array;
  edPubkey: Uint8Array;
  xPrivkey: Uint8Array;
  xPubkey: Uint8Array;
} | null> {
  if (cachedIdentity && !isTestMode()) {
    return cachedIdentity;
  }

  const seedB64 = await loadIdentitySeedB64();
  if (!seedB64) {
    return null;
  }

  if (seedBackend() === 'keychain') {
    const biometricOk = await requireBiometric('Unlock your WeVibe identity');
    if (!biometricOk) {
      throw new Error('biometric authentication failed');
    }
  }

  const seed = Buffer.from(seedB64, 'base64');
  const identity = generateIdentityFromSeed(seed);

  if (!isTestMode()) {
    cachedIdentity = identity;
  }

  return identity;
}
