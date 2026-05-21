/**
 * BIP39 mnemonic recovery for WeVibe Network master keys.
 *
 * Provides conversion between 32-byte master keys and 24-word
 * English mnemonic phrases per BIP39. Used for offline backup
 * and recovery of org master keys.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PKG = join(__dirname, '../../wevibe-sdk/crates/wevibe-sdk-wasm/pkg-nodejs');

const mod = await import(WASM_PKG + '/wevibe_sdk_wasm.js');

export function generateRecoveryPhrase(masterKey: Uint8Array): string {
  if (masterKey.length !== 32) {
    throw new Error('masterKey must be 32 bytes');
  }
  return mod.master_key_to_mnemonic(masterKey);
}

export function reconstructMasterKey(phrase: string): Uint8Array {
  return new Uint8Array(mod.mnemonic_to_master_key(phrase));
}

export interface ShamirShares {
  shares: Uint8Array[];
  threshold: number;
  totalShares: number;
}

export function splitMasterKey(masterKey: Uint8Array): ShamirShares {
  if (masterKey.length !== 32) {
    throw new Error('masterKey must be 32 bytes');
  }
  const sharesJson = mod.splitSecret(masterKey, 2, 3);
  const rawShares: number[][] = JSON.parse(sharesJson);
  return {
    shares: rawShares.map(s => new Uint8Array(s)),
    threshold: 2,
    totalShares: 3,
  };
}

export function reconstructFromShares(shares: Uint8Array[]): Uint8Array {
  if (shares.length < 2) {
    throw new Error('at least 2 shares required for reconstruction');
  }
  const rawShares = shares.map(s => Array.from(s));
  const sharesJson = JSON.stringify(rawShares);
  return new Uint8Array(mod.reconstructSecret(sharesJson, 2));
}