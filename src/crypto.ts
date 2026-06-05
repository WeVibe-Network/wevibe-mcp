import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PKG = join(__dirname, '../../wevibe-sdk/pkg-nodejs');

const mod = await import(WASM_PKG + '/wevibe_sdk_wasm.js');

export async function initCrypto(): Promise<void> {
}

export function generateDek(): Uint8Array {
  return new Uint8Array(mod.generate_dek());
}

export function encryptSymmetric(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  return new Uint8Array(mod.encrypt_symmetric(plaintext, key));
}

export function decryptSymmetric(blob: Uint8Array, key: Uint8Array): Uint8Array {
  return new Uint8Array(mod.decrypt_symmetric(blob, key));
}

export function sealToPubkey(plaintext: Uint8Array, recipientPubkey: Uint8Array): Uint8Array {
  return new Uint8Array(mod.seal_to_pubkey(plaintext, recipientPubkey));
}

export function openEnvelope(blob: Uint8Array, privkey: Uint8Array): Uint8Array {
  return new Uint8Array(mod.open_envelope(blob, privkey));
}

export function deriveEpochKeys(masterKey: Uint8Array, epoch: number): { encKey: Uint8Array; searchKey: Uint8Array; auditKey: Uint8Array } {
  const result = mod.derive_epoch_keys(masterKey, epoch);
  return {
    encKey: new Uint8Array(result[0]),
    searchKey: new Uint8Array(result[1]),
    auditKey: new Uint8Array(result[2]),
  };
}

export function sign(privkey: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(mod.sign(privkey, data));
}

export function verify(pubkey: Uint8Array, signature: Uint8Array, data: Uint8Array): boolean {
  return mod.verify(pubkey, signature, data);
}

export function generateIdentity(): { edPrivkey: Uint8Array; edPubkey: Uint8Array; xPrivkey: Uint8Array; xPubkey: Uint8Array } {
  const result = mod.generate_identity();
  return {
    edPrivkey: new Uint8Array(result[0]),
    edPubkey: new Uint8Array(result[1]),
    xPrivkey: new Uint8Array(result[2]),
    xPubkey: new Uint8Array(result[3]),
  };
}

export function generateIdentityFromSeed(seed: Uint8Array): { edPrivkey: Uint8Array; edPubkey: Uint8Array; xPrivkey: Uint8Array; xPubkey: Uint8Array } {
  const result = mod.generate_identity_from_seed(seed);
  return {
    edPrivkey: new Uint8Array(result[0]),
    edPubkey: new Uint8Array(result[1]),
    xPrivkey: new Uint8Array(result[2]),
    xPubkey: new Uint8Array(result[3]),
  };
}

export function seedToMnemonic(seed: Uint8Array): string {
  return mod.master_key_to_mnemonic(seed);
}

export function mnemonicToSeed(phrase: string): Uint8Array {
  return new Uint8Array(mod.mnemonic_to_master_key(phrase));
}

export function splitSecret(secret: Uint8Array, threshold: number, totalShares: number): string {
  return mod.splitSecret(secret, threshold, totalShares);
}

export function reconstructSecret(sharesJson: string, threshold: number): Uint8Array {
  return new Uint8Array(mod.reconstructSecret(sharesJson, threshold));
}
