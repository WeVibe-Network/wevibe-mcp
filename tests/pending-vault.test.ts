process.env.WEVIBE_KEYSTORE_TEST = '1';

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { storePendingDek, loadPendingDek, listPending } from '../src/pending-vault.js';

const VAULT_DIR = join(homedir(), '.wevibe', 'pending_vault');

function testHash(): string {
  return 'test-' + Math.random().toString(36).slice(2) + '-' + Date.now();
}

describe('pending-vault', () => {
  it('test_store_and_load', async () => {
    const hash = testHash();
    const dek = new Uint8Array(32);
    crypto.getRandomValues(dek);

    await storePendingDek(hash, 'org1', 1, dek, 'test preview');
    const loaded = await loadPendingDek(hash);

    expect(loaded).not.toBeNull();
    expect(Buffer.from(loaded!).toString('base64')).toBe(Buffer.from(dek).toString('base64'));

    const entries = await listPending('org1');
    expect(entries.some((e) => e.submissionHash === hash)).toBe(true);
  });

  it('test_load_nonexistent_returns_null', async () => {
    const loaded = await loadPendingDek('nonexistent-hash-' + Date.now());
    expect(loaded).toBeNull();
  });

  it('test_list_pending_empty', async () => {
    const entries = await listPending('nonexistent-org-' + Date.now());
    expect(entries).toEqual([]);
  });

  it('test_list_filtered_by_org', async () => {
    const hash1 = testHash();
    const hash2 = testHash();
    const dek = new Uint8Array(32);
    crypto.getRandomValues(dek);

    await storePendingDek(hash1, 'orgA', 1, dek, 'preview A');
    await storePendingDek(hash2, 'orgB', 1, dek, 'preview B');

    const orgA = await listPending('orgA');
    const orgB = await listPending('orgB');

    expect(orgA.some((e) => e.submissionHash === hash1)).toBe(true);
    expect(orgA.some((e) => e.submissionHash === hash2)).toBe(false);
    expect(orgB.some((e) => e.submissionHash === hash2)).toBe(true);
  });

  it('test_vault_files_encrypted', async () => {
    const hash = testHash();
    const dek = new Uint8Array(32);
    crypto.getRandomValues(dek);

    await storePendingDek(hash, 'org-secure', 1, dek, 'sensitive preview');

    const vaultPath = join(VAULT_DIR, `${hash}.bin`);
    const raw = readFileSync(vaultPath);
    const text = raw.toString('utf-8');
    expect(text).not.toContain('org-secure');
    expect(text).not.toContain('sensitive preview');
    expect(() => JSON.parse(text)).toThrow();
  });
});
