/**
 * Umbral PRE operations, executed in-process via WebAssembly.
 *
 * Replaces the former `sidecar.ts`, which located a native Rust binary through
 * the WEVIBE_UMBRAL_SIDECAR_BIN environment variable and spawned it once per
 * operation. That variable had to be injected at every MCP launch site, so any
 * launch-script rewrite silently broke leader-side crypto — which happened on
 * 2026-07-05, 2026-07-13 and 2026-08-14.
 *
 * The WASM module is vendored at ../vendor/umbral-wasm and resolved relative to
 * THIS file, so the same specifier works from src/ under tsx and from dist/
 * after tsc — both sit one level below the package root. There is no path to
 * configure and no environment variable to forget.
 *
 * The crypto is compiled from crates/core in the wevibe-umbral repo — the same
 * source the native binary and the :4460 gRPC service use — so capsules,
 * kfrags and cfrags stay byte-compatible in both directions.
 */
import { createRequire } from 'node:module';
import { logOp, fp, appendRaw } from './logger.js';

const require = createRequire(import.meta.url);

interface UmbralWasm {
  deriveEpochKeypair(seedHex: string): string;
  encrypt(epochPkHex: string, plaintextHex: string): string;
  generateKfrag(delegatingSkHex: string, receivingPkHex: string): string;
  reencrypt(capsuleHex: string, kfragHex: string): string;
  decryptReencrypted(
    capsuleHex: string,
    cfragsHex: string,
    ciphertextHex: string,
    receivingSkHex: string,
    delegatingPkHex: string,
  ): string;
}

export interface EncryptResult {
  capsule: string;
  ciphertext: string;
}

let wasmModule: UmbralWasm | undefined;

/**
 * Loaded on first use rather than at import time: a packaging fault should not
 * stop the MCP from starting, and the error it raises names the exact fix.
 */
function getUmbral(): UmbralWasm {
  if (wasmModule) return wasmModule;

  try {
    wasmModule = require('../vendor/umbral-wasm/wevibe_umbral_wasm.js') as UmbralWasm;
  } catch (error) {
    throw new Error(
      'Umbral WASM module could not be loaded from vendor/umbral-wasm. '
        + 'The wevibe-mcp package is incomplete — reinstall it, or rebuild with '
        + '`wevibe-umbral/scripts/build-wasm.sh`. '
        + `Underlying error: ${(error as Error).message}`,
    );
  }

  return wasmModule;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('umbral response is not a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * Runs one operation with the timing/telemetry shape the sidecar emitted, so
 * existing log tooling keeps working. Secrets never appear here: only
 * fingerprints and byte lengths, per D-MISSION-INVARIANT.
 */
function runUmbral<T>(
  command: string,
  logMeta: Record<string, unknown>,
  operation: (umbral: UmbralWasm) => T,
): T {
  const t0 = Date.now();

  try {
    const result = operation(getUmbral());
    const rendered = typeof result === 'string' ? result : '';

    appendRaw(
      'umbral.log',
      `${new Date().toISOString()} [${command}] status=ok out_bytes=${Buffer.byteLength(rendered)} out_fp=${fp(rendered)}\n`,
    );
    logOp('umbral', 'info', { ...logMeta, command, status: 'ok', dur_ms: Date.now() - t0 });

    return result;
  } catch (error) {
    // WASM rejections arrive as the plain string we passed to JsValue::from_str.
    const message = error instanceof Error ? error.message : String(error);

    appendRaw(
      'umbral.log',
      `${new Date().toISOString()} [${command}] status=err\n`,
    );
    logOp('umbral', 'error', {
      ...logMeta,
      command,
      status: 'err',
      dur_ms: Date.now() - t0,
      err: message,
    });

    throw new Error(`umbral ${command} failed: ${message}`);
  }
}

function parseJson(command: string, raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw));
  } catch (error) {
    throw new Error(`umbral ${command} returned invalid JSON: ${(error as Error).message}`);
  }
}

export async function umbralEncrypt(
  epochPkHex: string,
  plaintextHex: string,
): Promise<EncryptResult> {
  const raw = runUmbral('encrypt', {
    epoch_pk_fp: fp(epochPkHex),
    plaintext_len: Math.floor(plaintextHex.length / 2),
  }, (umbral) => umbral.encrypt(epochPkHex, plaintextHex));

  const out = parseJson('encrypt', raw);
  const capsule = out.capsule;
  const ciphertext = out.ciphertext;
  if (typeof capsule !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('umbral encrypt response missing capsule/ciphertext');
  }

  return { capsule, ciphertext };
}

export async function umbralDecryptReencrypted(
  capsuleHex: string,
  cfragsHex: string,
  ciphertextHex: string,
  receivingSkHex: string,
  delegatingPkHex: string,
): Promise<string> {
  return runUmbral('decrypt-reencrypted', {
    capsule_fp: fp(capsuleHex),
    delegating_pk_fp: fp(delegatingPkHex),
    receiving_pk_fp: fp(receivingSkHex),
    cfrags_len: Math.floor(cfragsHex.length / 2),
    ciphertext_len: Math.floor(ciphertextHex.length / 2),
  }, (umbral) => umbral.decryptReencrypted(
    capsuleHex,
    cfragsHex,
    ciphertextHex,
    receivingSkHex,
    delegatingPkHex,
  ));
}

export async function umbralDeriveEpochKeypair(
  seedHex: string,
): Promise<{ secretKeyHex: string; publicKeyHex: string }> {
  const raw = runUmbral('derive-epoch-keypair', {
    seed_len: Math.floor(seedHex.length / 2),
  }, (umbral) => umbral.deriveEpochKeypair(seedHex));

  const out = parseJson('derive-epoch-keypair', raw);
  const secretKeyHex = out.secret_key;
  const publicKeyHex = out.public_key;
  if (typeof secretKeyHex !== 'string' || typeof publicKeyHex !== 'string') {
    throw new Error('umbral derive-epoch-keypair response missing secret_key/public_key');
  }

  return { secretKeyHex, publicKeyHex };
}

export async function umbralGenerateKfrag(
  delegatingSkHex: string,
  receivingPkHex: string,
): Promise<string> {
  const kfragHex = runUmbral('generate-kfrags', {
    receiving_pk_fp: fp(receivingPkHex),
    delegating_sk_len: Math.floor(delegatingSkHex.length / 2),
  }, (umbral) => umbral.generateKfrag(delegatingSkHex, receivingPkHex));

  if (!kfragHex) {
    throw new Error('umbral generate-kfrags returned empty output');
  }

  return kfragHex;
}
