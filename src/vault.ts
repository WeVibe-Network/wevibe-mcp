import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { argon2id } from '@noble/hashes/argon2';
import { utf8ToBytes } from '@noble/hashes/utils';

const WEVIBE_DIR = join(homedir(), '.wevibe');
const VAULT_PATH = join(WEVIBE_DIR, 'vault.enc');

const ARGON2_SALT_LEN = 32;
const ARGON2_NONCE_LEN = 12;
const ARGON2_PARAMS = { t: 3, m: 65536, p: 4 };
const AES_KEY_LEN = 32;
const AES_GCM_TAG_LEN = 16;

export interface VaultEntry {
  org_id: string;
  org_name: string;
  k_master_hex: string;
  recovery_phrase: string;
  sk_mod_hex: string | null;
  current_epoch: number;
  created_at: string;
  last_verified_at: string | null;
}

export interface VaultFile {
  version: 1;
  entries: VaultEntry[];
  created_at: string;
  updated_at: string;
}

export interface VaultOrgSummary {
  org_id: string;
  org_name: string;
  current_epoch: number;
  last_verified_at: string | null;
}

let _vaultCache: VaultFile | null = null;
let _vaultCachePassphrase: string | null = null;

function _getVaultPath(): string {
  return process.env.WEVIBE_VAULT_PATH ?? VAULT_PATH;
}

function _ensureWevibeDir(): void {
  const vaultDir = dirname(_getVaultPath());
  if (!existsSync(vaultDir)) {
    mkdirSync(vaultDir, { recursive: true });
  }
}

async function _deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const hash = argon2id(utf8ToBytes(passphrase), salt, {
    ...ARGON2_PARAMS,
    dkLen: AES_KEY_LEN,
  });
  return Buffer.from(hash);
}

function _encryptVault(vault: VaultFile, key: Buffer): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(ARGON2_NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(JSON.stringify(vault), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: Buffer.concat([ciphertext, tag]) };
}

async function _decryptVault(data: Buffer, key: Buffer): Promise<VaultFile> {
  if (data.length < ARGON2_NONCE_LEN + AES_GCM_TAG_LEN + 1) {
    throw new Error('Invalid vault file: data too short');
  }
  const nonce = data.subarray(0, ARGON2_NONCE_LEN);
  const ciphertextWithTag = data.subarray(ARGON2_NONCE_LEN);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - AES_GCM_TAG_LEN);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AES_GCM_TAG_LEN);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf-8')) as VaultFile;
}

export async function vaultExists(): Promise<boolean> {
  return existsSync(_getVaultPath());
}

export async function createVault(passphrase: string): Promise<void> {
  _ensureWevibeDir();
  const salt = randomBytes(ARGON2_SALT_LEN);
  const key = await _deriveKey(passphrase, salt);
  const now = new Date().toISOString();
  const vault: VaultFile = {
    version: 1,
    entries: [],
    created_at: now,
    updated_at: now,
  };
  const { nonce, ciphertext } = _encryptVault(vault, key);
  const vaultData = Buffer.concat([salt, nonce, ciphertext]);
  const tmpPath = _getVaultPath() + '.tmp';
  writeFileSync(tmpPath, vaultData);
  renameSync(tmpPath, _getVaultPath());
  chmodSync(_getVaultPath(), 0o600);
  _vaultCache = vault;
  _vaultCachePassphrase = passphrase;
}

export async function unlockVault(passphrase: string): Promise<VaultFile> {
  const vaultPath = _getVaultPath();
  if (!existsSync(vaultPath)) {
    throw new Error('Vault does not exist');
  }
  const data = readFileSync(vaultPath);
  if (data.length < ARGON2_SALT_LEN + ARGON2_NONCE_LEN + AES_GCM_TAG_LEN + 1) {
    throw new Error('Invalid vault file: data too short');
  }
  const salt = data.subarray(0, ARGON2_SALT_LEN);
  const key = await _deriveKey(passphrase, salt);
  const ciphertextData = data.subarray(ARGON2_SALT_LEN);
  const vault = await _decryptVault(ciphertextData, key);

  if (vault.version !== 1) {
    throw new Error(`Unknown vault version: ${vault.version}`);
  }

  _vaultCache = vault;
  _vaultCachePassphrase = passphrase;
  return vault;
}

export async function lockVault(): Promise<void> {
  if (_vaultCachePassphrase) {
    _vaultCachePassphrase = null;
  }
  if (_vaultCache) {
    _vaultCache = null;
  }
}

export async function saveVault(): Promise<void> {
  if (!_vaultCache) {
    throw new Error('Vault is not unlocked');
  }
  if (!_vaultCachePassphrase) {
    throw new Error('Vault is not unlocked');
  }
  const vaultPath = _getVaultPath();
  const data = readFileSync(vaultPath);
  const salt = data.subarray(0, ARGON2_SALT_LEN);
  const key = await _deriveKey(_vaultCachePassphrase, salt);
  _vaultCache.updated_at = new Date().toISOString();
  const { nonce, ciphertext } = _encryptVault(_vaultCache, key);
  const vaultData = Buffer.concat([salt, nonce, ciphertext]);
  const tmpPath = vaultPath + '.tmp';
  writeFileSync(tmpPath, vaultData);
  renameSync(tmpPath, vaultPath);
  chmodSync(vaultPath, 0o600);
}

export function getVaultCache(): VaultFile | null {
  return _vaultCache;
}

export function isVaultUnlocked(): boolean {
  return _vaultCache !== null;
}

export async function addOrgToVault(entry: VaultEntry): Promise<void> {
  if (!_vaultCache) {
    throw new Error('Vault is not unlocked');
  }
  const existingIdx = _vaultCache.entries.findIndex(e => e.org_id === entry.org_id);
  if (existingIdx >= 0) {
    _vaultCache.entries[existingIdx] = entry;
  } else {
    _vaultCache.entries.push(entry);
  }
  await saveVault();
}

export async function removeOrgFromVault(orgId: string): Promise<void> {
  if (!_vaultCache) {
    throw new Error('Vault is not unlocked');
  }
  _vaultCache.entries = _vaultCache.entries.filter(e => e.org_id !== orgId);
  await saveVault();
}

export async function getVaultEntry(orgId: string): Promise<VaultEntry | null> {
  if (!_vaultCache) {
    return null;
  }
  return _vaultCache.entries.find(e => e.org_id === orgId) ?? null;
}

export async function listVaultEntries(): Promise<VaultOrgSummary[]> {
  if (!_vaultCache) {
    return [];
  }
  return _vaultCache.entries.map(e => ({
    org_id: e.org_id,
    org_name: e.org_name,
    current_epoch: e.current_epoch,
    last_verified_at: e.last_verified_at,
  }));
}

export async function updateVaultEntry(
  orgId: string,
  updates: Partial<Pick<VaultEntry, 'sk_mod_hex' | 'current_epoch' | 'last_verified_at'>>
): Promise<void> {
  if (!_vaultCache) {
    throw new Error('Vault is not unlocked');
  }
  const entry = _vaultCache.entries.find(e => e.org_id === orgId);
  if (!entry) {
    return;
  }
  if (updates.sk_mod_hex !== undefined) entry.sk_mod_hex = updates.sk_mod_hex;
  if (updates.current_epoch !== undefined) entry.current_epoch = updates.current_epoch;
  if (updates.last_verified_at !== undefined) entry.last_verified_at = updates.last_verified_at;
  await saveVault();
}

export async function storePassphraseInKeychain(passphrase: string): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync(`security add-generic-password -s wevibe-vault -a wevibe-vault -w "${passphrase}" -U`, {
        stdio: 'ignore',
      });
      return true;
    } else if (platform === 'linux') {
      execSync(`secret-tool store --label=wevibe-vault account wevibe-vault <<< "${passphrase}"`, {
        stdio: 'ignore',
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function retrievePassphraseFromKeychain(): Promise<string | null> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      const result = execSync('security find-generic-password -s wevibe-vault -a wevibe-vault -w', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return result.trim() || null;
    } else if (platform === 'linux') {
      const result = execSync('secret-tool lookup account wevibe-vault', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return result.trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function deletePassphraseFromKeychain(): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync('security delete-generic-password -s wevibe-vault -a wevibe-vault', { stdio: 'ignore' });
      return true;
    } else if (platform === 'linux') {
      execSync('secret-tool clear account wevibe-vault', { stdio: 'ignore' });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export { VAULT_PATH };
