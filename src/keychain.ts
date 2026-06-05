import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SERVICE = 'wevibe-network';

interface KeychainEntry {
  setPassword(password: string): void;
  getPassword(): string;
  deletePassword(): boolean;
}

type KeychainEntryConstructor = new (service: string, account: string) => KeychainEntry;

interface KeyringModule {
  Entry: KeychainEntryConstructor;
}

function createEntry(account: string): KeychainEntry {
  const { Entry } = require('@napi-rs/keyring') as KeyringModule;
  return new Entry(SERVICE, account);
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /not\s*found|no\s*entry|no\s*matching/i.test(error.message);
}

/**
 * Stores a base64-encoded value in the OS keychain for the given account.
 */
export function setKeychainItem(account: string, valueB64: string): void {
  const entry = createEntry(account);
  entry.setPassword(valueB64);
}

/**
 * Loads a base64-encoded value from the OS keychain for the given account.
 * Returns null when no keychain item exists.
 */
export function getKeychainItem(account: string): string | null {
  const entry = createEntry(account);
  try {
    return entry.getPassword();
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Deletes the OS keychain item for the given account.
 * Missing entries are ignored.
 */
export function deleteKeychainItem(account: string): void {
  const entry = createEntry(account);
  try {
    entry.deletePassword();
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
}
