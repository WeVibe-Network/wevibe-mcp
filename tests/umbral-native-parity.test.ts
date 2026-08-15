import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  umbralDecryptReencrypted,
  umbralDeriveEpochKeypair,
  umbralEncrypt,
  umbralGenerateKfrag,
} from '../src/umbral.js';

/**
 * Drift guard for the two builds of the same crypto:
 *
 *   * wevibe-mcp's WASM module (crates/wasm -> vendor/umbral-wasm)
 *   * the native wevibe-umbral binary + its :4460 gRPC service
 *
 * Both compile from crates/core, so they should never diverge — but "should"
 * is not a test. Ciphertext already on the hub was written by the native side;
 * if these ever disagree, existing memories become unreadable.
 *
 * Skipped when the native binary is absent (a fresh clone, or an npm-only
 * install). Build it with `cargo build --release` in wevibe-umbral to enable.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NATIVE_BIN = path.join(REPO_ROOT, 'wevibe-umbral/target/release/wevibe-umbral');

const nativeAvailable = existsSync(NATIVE_BIN);
const describeParity = nativeAvailable ? describe : describe.skip;

function native(args: string[]): string {
  return execFileSync(NATIVE_BIN, args, { encoding: 'utf-8' }).trim();
}

const SEED = 'a'.repeat(64);
const MEMBER_SEED = 'b'.repeat(64);
const PLAINTEXT = Buffer.from('wevibe epoch memory payload').toString('hex');

describeParity(
  nativeAvailable
    ? 'umbral WASM <-> native binary parity'
    : `umbral WASM <-> native binary parity (skipped: no binary at ${NATIVE_BIN})`,
  () => {
    it('derives byte-identical keypairs', async () => {
      const nativeKp = JSON.parse(native(['derive-epoch-keypair', '--seed', SEED]));
      const wasmKp = await umbralDeriveEpochKeypair(SEED);

      expect(wasmKp.publicKeyHex).toBe(nativeKp.public_key);
      expect(wasmKp.secretKeyHex).toBe(nativeKp.secret_key);
    });

    it('decrypts natively-encrypted ciphertext with a WASM-minted kfrag', async () => {
      const epoch = await umbralDeriveEpochKeypair(SEED);
      const member = await umbralDeriveEpochKeypair(MEMBER_SEED);

      const enc = JSON.parse(
        native(['encrypt', '--epoch-pk', epoch.publicKeyHex, '--plaintext', PLAINTEXT]),
      );
      const kfrag = await umbralGenerateKfrag(SEED, member.publicKeyHex);
      const cfrag = JSON.parse(native(['reencrypt', '--capsule', enc.capsule, '--kfrag', kfrag])).cfrag;

      const recovered = await umbralDecryptReencrypted(
        enc.capsule,
        cfrag,
        enc.ciphertext,
        MEMBER_SEED,
        epoch.publicKeyHex,
      );

      expect(recovered).toBe(PLAINTEXT);
    });

    it('produces ciphertext the native binary can re-encrypt and decrypt', async () => {
      const epoch = await umbralDeriveEpochKeypair(SEED);
      const member = await umbralDeriveEpochKeypair(MEMBER_SEED);

      const enc = await umbralEncrypt(epoch.publicKeyHex, PLAINTEXT);
      const kfrag = native([
        'generate-kfrags', '--delegating-sk', SEED, '--receiving-pk', member.publicKeyHex,
      ]);
      const cfrag = JSON.parse(native(['reencrypt', '--capsule', enc.capsule, '--kfrag', kfrag])).cfrag;
      const recovered = JSON.parse(native([
        'decrypt-reencrypted',
        '--capsule', enc.capsule,
        '--cfrags', cfrag,
        '--ciphertext', enc.ciphertext,
        '--receiving-sk', MEMBER_SEED,
        '--delegating-pk', epoch.publicKeyHex,
      ])).plaintext;

      expect(recovered).toBe(PLAINTEXT);
    });

    it('emits identical wire-format sizes', async () => {
      const epoch = await umbralDeriveEpochKeypair(SEED);
      const member = await umbralDeriveEpochKeypair(MEMBER_SEED);

      const nativeEnc = JSON.parse(
        native(['encrypt', '--epoch-pk', epoch.publicKeyHex, '--plaintext', PLAINTEXT]),
      );
      const wasmEnc = await umbralEncrypt(epoch.publicKeyHex, PLAINTEXT);

      const nativeKfrag = native([
        'generate-kfrags', '--delegating-sk', SEED, '--receiving-pk', member.publicKeyHex,
      ]);
      const wasmKfrag = await umbralGenerateKfrag(SEED, member.publicKeyHex);

      expect(wasmEnc.capsule.length).toBe(nativeEnc.capsule.length);
      expect(wasmEnc.ciphertext.length).toBe(nativeEnc.ciphertext.length);
      expect(wasmKfrag.length).toBe(nativeKfrag.length);
    });
  },
);
