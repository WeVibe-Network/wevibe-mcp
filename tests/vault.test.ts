process.env.WEVIBE_KEYSTORE_TEST = '1';
process.env.WEVIBE_VAULT_PATH = '/tmp/test-vault.enc';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { argon2id } from '@noble/hashes/argon2';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  createVault,
  unlockVault,
  lockVault,
  vaultExists,
  addOrgToVault,
  removeOrgFromVault,
  getVaultEntry,
  listVaultEntries,
  getVaultCache,
  isVaultUnlocked,
  updateVaultEntry,
} from '../src/vault.js';
import type { VaultEntry } from '../src/vault.js';

const TEST_VAULT_PATH = '/tmp/test-vault.enc';

function getTestVaultPath(): string {
  return process.env.WEVIBE_VAULT_PATH ?? TEST_VAULT_PATH;
}

describe('vault', () => {
  beforeEach(() => {
    const path = getTestVaultPath();
    try { unlinkSync(path); } catch { }
    try { unlinkSync(path + '.tmp'); } catch { }
    lockVault();
  });

  afterEach(() => {
    const path = getTestVaultPath();
    try { unlinkSync(path); } catch { }
    try { unlinkSync(path + '.tmp'); } catch { }
    lockVault();
  });

  it('test_create_vault_creates_file', async () => {
    await createVault('test-passphrase-123');
    const path = getTestVaultPath();
    expect(existsSync(path)).toBe(true);
  });

  it('test_create_vault_sets_permissions', async () => {
    await createVault('test-passphrase-123');
    const path = getTestVaultPath();
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('test_ensure_wevibe_dir_creates_parent_directory', async () => {
    const testId = Date.now();
    const nestedPath = `/tmp/wevibe-vault-test-${testId}/subdir/vault.enc`;
    const origEnv = process.env.WEVIBE_VAULT_PATH;
    process.env.WEVIBE_VAULT_PATH = nestedPath;
    try {
      await createVault('dir-creation-test');
      expect(existsSync(nestedPath)).toBe(true);
      lockVault();
      const vault = await unlockVault('dir-creation-test');
      expect(vault.version).toBe(1);
    } finally {
      process.env.WEVIBE_VAULT_PATH = origEnv;
      try {
        const { rmSync } = await import('node:fs');
        rmSync(`/tmp/wevibe-vault-test-${testId}`, { recursive: true });
      } catch {}
    }
  });

  it('test_unlock_with_correct_passphrase', async () => {
    await createVault('correct-passphrase');
    lockVault();
    const vault = await unlockVault('correct-passphrase');
    expect(vault.version).toBe(1);
    expect(vault.entries).toEqual([]);
  });

  it('test_unlock_with_wrong_passphrase_throws', async () => {
    await createVault('my-passphrase');
    lockVault();
    await expect(unlockVault('wrong-passphrase')).rejects.toThrow();
  });

  it('test_add_org_to_vault_persists', async () => {
    await createVault('passphrase-for-add');
    const entry: VaultEntry = {
      org_id: 'org-123',
      org_name: 'Test Org',
      k_master_hex: 'a'.repeat(64),
      recovery_phrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24',
      sk_mod_hex: 'b'.repeat(64),
      current_epoch: 0,
      created_at: new Date().toISOString(),
      last_verified_at: null,
    };
    await addOrgToVault(entry);
    lockVault();
    const vault = await unlockVault('passphrase-for-add');
    expect(vault.entries.length).toBe(1);
    expect(vault.entries[0].org_id).toBe('org-123');
    expect(vault.entries[0].k_master_hex).toBe('a'.repeat(64));
  });

  it('test_remove_org_from_vault_persists', async () => {
    await createVault('passphrase-for-remove');
    const entry: VaultEntry = {
      org_id: 'org-to-remove',
      org_name: 'Remove Me',
      k_master_hex: 'c'.repeat(64),
      recovery_phrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24',
      sk_mod_hex: null,
      current_epoch: 1,
      created_at: new Date().toISOString(),
      last_verified_at: null,
    };
    await addOrgToVault(entry);
    await removeOrgFromVault('org-to-remove');
    lockVault();
    const vault = await unlockVault('passphrase-for-remove');
    expect(vault.entries.length).toBe(0);
  });

  it('test_atomic_write_no_corruption', async () => {
    await createVault('atomic-test');
    const entry: VaultEntry = {
      org_id: 'org-atomic',
      org_name: 'Atomic Org',
      k_master_hex: 'd'.repeat(64),
      recovery_phrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24',
      sk_mod_hex: null,
      current_epoch: 0,
      created_at: new Date().toISOString(),
      last_verified_at: null,
    };
    await addOrgToVault(entry);

    const path = getTestVaultPath();
    const before = readFileSync(path);

    try { unlinkSync(path + '.tmp'); } catch { }
    const vault = await unlockVault('atomic-test');
    lockVault();
    expect(vault.entries.length).toBe(1);
  });

  it('test_list_vault_entries_returns_summaries', async () => {
    await createVault('summary-test');
    const entry: VaultEntry = {
      org_id: 'org-summary',
      org_name: 'Summary Org',
      k_master_hex: 'e'.repeat(64),
      recovery_phrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24',
      sk_mod_hex: 'f'.repeat(64),
      current_epoch: 5,
      created_at: new Date().toISOString(),
      last_verified_at: '2024-01-01T00:00:00.000Z',
    };
    await addOrgToVault(entry);
    const summaries = await listVaultEntries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].org_id).toBe('org-summary');
    expect(summaries[0].org_name).toBe('Summary Org');
    expect(summaries[0].current_epoch).toBe(5);
    expect(summaries[0].last_verified_at).toBe('2024-01-01T00:00:00.000Z');
    expect((summaries[0] as any).k_master_hex).toBeUndefined();
  });

  it('test_empty_vault_is_valid', async () => {
    await createVault('empty-test');
    const vault = await unlockVault('empty-test');
    expect(vault.entries).toEqual([]);
    expect(vault.version).toBe(1);
  });

  it('test_unknown_version_throws', async () => {
    const path = getTestVaultPath();
    const { randomBytes, createCipheriv } = await import('node:crypto');
    const salt = randomBytes(32);
    const key = argon2id(utf8ToBytes('version-test'), salt, {
      t: 3,
      m: 65536,
      p: 4,
      dkLen: 32,
    });
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
    const badVault = Buffer.from(JSON.stringify({ version: 99, entries: [], created_at: '', updated_at: '' }), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(badVault), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertextWithTag = Buffer.concat([ciphertext, tag]);
    const vaultData = Buffer.concat([salt, nonce, ciphertextWithTag]);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, vaultData);
    await expect(unlockVault('version-test')).rejects.toThrow('Unknown vault version');
  });

  it('test_update_vault_entry', async () => {
    await createVault('update-test');
    const entry: VaultEntry = {
      org_id: 'org-update',
      org_name: 'Update Org',
      k_master_hex: 'g'.repeat(64),
      recovery_phrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24',
      sk_mod_hex: null,
      current_epoch: 0,
      created_at: new Date().toISOString(),
      last_verified_at: null,
    };
    await addOrgToVault(entry);
    await updateVaultEntry('org-update', { current_epoch: 10, sk_mod_hex: 'h'.repeat(64) });
    const updated = await getVaultEntry('org-update');
    expect(updated!.current_epoch).toBe(10);
    expect(updated!.sk_mod_hex).toBe('h'.repeat(64));
  });

  it('test_add_org_updates_existing', async () => {
    await createVault('update-existing-test');
    const entry1: VaultEntry = {
      org_id: 'org-same',
      org_name: 'First Name',
      k_master_hex: 'i'.repeat(64),
      recovery_phrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24',
      sk_mod_hex: null,
      current_epoch: 0,
      created_at: new Date().toISOString(),
      last_verified_at: null,
    };
    await addOrgToVault(entry1);
    const entry2: VaultEntry = {
      ...entry1,
      org_name: 'Updated Name',
      current_epoch: 5,
    };
    await addOrgToVault(entry2);
    const entries = await listVaultEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].org_name).toBe('Updated Name');
    expect(entries[0].current_epoch).toBe(5);
  });

  it('test_get_vault_cache_returns_null_when_locked', () => {
    lockVault();
    expect(getVaultCache()).toBeNull();
    expect(isVaultUnlocked()).toBe(false);
  });

  it('test_get_vault_cache_returns_vault_when_unlocked', async () => {
    await createVault('cache-test');
    expect(isVaultUnlocked()).toBe(true);
    const cache = getVaultCache();
    expect(cache).not.toBeNull();
    expect(cache!.version).toBe(1);
  });
});
