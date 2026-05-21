process.env.WEVIBE_KEYSTORE_TEST = '1';
process.env.WEVIBE_VAULT_PATH = '/tmp/test-recovery-vault.enc';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import {
  createVault,
  unlockVault,
  lockVault,
  addOrgToVault,
  getVaultCache,
  isVaultUnlocked,
  vaultExists,
  listVaultEntries,
} from '../src/vault.js';
import type { VaultEntry } from '../src/vault.js';

const TEST_VAULT_PATH = '/tmp/test-recovery-vault.enc';

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    org_id: 'org-test-' + Math.random().toString(36).slice(2, 8),
    org_name: 'Test Org',
    k_master_hex: 'a'.repeat(64),
    recovery_phrase: Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' '),
    sk_mod_hex: 'b'.repeat(64),
    current_epoch: 0,
    created_at: new Date().toISOString(),
    last_verified_at: null,
    ...overrides,
  };
}

describe('recovery status data', () => {
  beforeEach(async () => {
    try { unlinkSync(TEST_VAULT_PATH); } catch {}
    try { unlinkSync(TEST_VAULT_PATH + '.tmp'); } catch {}
    await lockVault();
  });

  afterEach(async () => {
    try { unlinkSync(TEST_VAULT_PATH); } catch {}
    try { unlinkSync(TEST_VAULT_PATH + '.tmp'); } catch {}
    await lockVault();
  });

  it('reports healthy org with all fields present', async () => {
    await createVault('recovery-test');
    const entry = makeEntry({
      org_id: 'org-healthy',
      org_name: 'Healthy Org',
      last_verified_at: new Date().toISOString(),
    });
    await addOrgToVault(entry);

    const cache = getVaultCache();
    expect(cache).not.toBeNull();
    const e = cache!.entries[0];
    expect(e.k_master_hex.length).toBe(64);
    expect(e.recovery_phrase.split(/\s+/).length).toBe(24);
    expect(e.sk_mod_hex).not.toBeNull();
    expect(e.last_verified_at).not.toBeNull();
  });

  it('detects missing mod key', async () => {
    await createVault('mod-missing-test');
    const entry = makeEntry({ sk_mod_hex: null });
    await addOrgToVault(entry);

    const cache = getVaultCache();
    expect(cache!.entries[0].sk_mod_hex).toBeNull();
  });

  it('detects missing recovery phrase', async () => {
    await createVault('phrase-missing-test');
    const entry = makeEntry({ recovery_phrase: '' });
    await addOrgToVault(entry);

    const cache = getVaultCache();
    expect(cache!.entries[0].recovery_phrase).toBe('');
  });

  it('detects stale verification (> 30 days)', async () => {
    await createVault('stale-test');
    const staleDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const entry = makeEntry({ last_verified_at: staleDate });
    await addOrgToVault(entry);

    const cache = getVaultCache();
    const verifiedAt = new Date(cache!.entries[0].last_verified_at!).getTime();
    const daysSince = Math.floor((Date.now() - verifiedAt) / (1000 * 60 * 60 * 24));
    expect(daysSince).toBeGreaterThan(30);
  });

  it('detects never-verified org', async () => {
    await createVault('never-verified-test');
    const entry = makeEntry({ last_verified_at: null });
    await addOrgToVault(entry);

    const cache = getVaultCache();
    expect(cache!.entries[0].last_verified_at).toBeNull();
  });

  it('filters by org_id when provided', async () => {
    await createVault('filter-test');
    await addOrgToVault(makeEntry({ org_id: 'org-aaa', org_name: 'Org A' }));
    await addOrgToVault(makeEntry({ org_id: 'org-bbb', org_name: 'Org B' }));

    const cache = getVaultCache();
    expect(cache!.entries.length).toBe(2);
    const filtered = cache!.entries.filter(e => e.org_id === 'org-aaa');
    expect(filtered.length).toBe(1);
    expect(filtered[0].org_name).toBe('Org A');
  });

  it('returns empty when vault is locked', async () => {
    await createVault('lock-test');
    await lockVault();
    expect(isVaultUnlocked()).toBe(false);
    expect(getVaultCache()).toBeNull();
  });
});