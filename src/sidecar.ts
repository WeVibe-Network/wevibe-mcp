import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logOp, fp, appendRaw } from './logger.js';

const execFileAsync = promisify(execFile);

export interface EncryptResult {
  capsule: string;
  ciphertext: string;
}

function getSidecarBin(): string {
  const bin = process.env.WEVIBE_UMBRAL_SIDECAR_BIN;
  if (!bin) {
    throw new Error('WEVIBE_UMBRAL_SIDECAR_BIN environment variable is required');
  }
  return bin;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sidecar response is not a JSON object');
  }
  return value as Record<string, unknown>;
}

function formatSidecarError(command: string, stderrText: string, fallback: string): Error {
  if (!stderrText) {
    return new Error(`sidecar ${command} failed: ${fallback}`);
  }

  try {
    const parsed = JSON.parse(stderrText) as Record<string, unknown>;
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.message === 'string'
        ? parsed.message
        : null;
    if (message) {
      return new Error(`sidecar ${command} failed: ${message}`);
    }
  } catch {
    // Non-JSON stderr, fall through to raw text.
  }

  return new Error(`sidecar ${command} failed: ${stderrText}`);
}

async function runSidecar(
  command: string,
  args: string[],
  logMeta?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const bin = getSidecarBin();
  const t0 = Date.now();
  let stdout: string;
  let stderr: string;

  try {
    const output = await execFileAsync(bin, [command, ...args], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    stdout = output.stdout;
    stderr = output.stderr;
    appendRaw(
      'umbral-sidecar.log',
      `${new Date().toISOString()} [${command}] status=ok\n--- stdout ---\n${output.stdout ?? ''}\n--- stderr ---\n${output.stderr ?? ''}\n`,
    );
    logOp('sidecar', 'info', {
      ...logMeta,
      command,
      status: 'ok',
      dur_ms: Date.now() - t0,
    });
  } catch (error) {
    const anyErr = error as { stdout?: string; stderr?: string; message?: string };
    appendRaw(
      'umbral-sidecar.log',
      `${new Date().toISOString()} [${command}] status=err\n--- stdout ---\n${anyErr.stdout ?? ''}\n--- stderr ---\n${anyErr.stderr ?? ''}\n`,
    );
    logOp('sidecar', 'error', {
      ...logMeta,
      command,
      status: 'err',
      dur_ms: Date.now() - t0,
      err: anyErr.message ?? String(error),
    });

    const execError = error as Error & { stderr?: string };
    const stderrText = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    throw formatSidecarError(command, stderrText, execError.message);
  }

  if (stderr.trim()) {
    logOp('sidecar', 'error', {
      ...logMeta,
      command,
      status: 'err',
      dur_ms: Date.now() - t0,
      err: 'sidecar wrote to stderr',
    });
    throw formatSidecarError(command, stderr.trim(), 'sidecar wrote to stderr');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`sidecar ${command} returned invalid JSON: ${(error as Error).message}`);
  }

  return asRecord(parsed);
}

async function runSidecarText(
  command: string,
  args: string[],
  logMeta?: Record<string, unknown>,
): Promise<string> {
  const bin = getSidecarBin();
  const t0 = Date.now();
  let stdout: string;
  let stderr: string;

  try {
    const output = await execFileAsync(bin, [command, ...args], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    stdout = output.stdout;
    stderr = output.stderr;
    appendRaw(
      'umbral-sidecar.log',
      `${new Date().toISOString()} [${command}] status=ok\n--- stdout ---\n${output.stdout ?? ''}\n--- stderr ---\n${output.stderr ?? ''}\n`,
    );
    logOp('sidecar', 'info', {
      ...logMeta,
      command,
      status: 'ok',
      dur_ms: Date.now() - t0,
    });
  } catch (error) {
    const anyErr = error as { stdout?: string; stderr?: string; message?: string };
    appendRaw(
      'umbral-sidecar.log',
      `${new Date().toISOString()} [${command}] status=err\n--- stdout ---\n${anyErr.stdout ?? ''}\n--- stderr ---\n${anyErr.stderr ?? ''}\n`,
    );
    logOp('sidecar', 'error', {
      ...logMeta,
      command,
      status: 'err',
      dur_ms: Date.now() - t0,
      err: anyErr.message ?? String(error),
    });

    const execError = error as Error & { stderr?: string };
    const stderrText = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    throw formatSidecarError(command, stderrText, execError.message);
  }

  if (stderr.trim()) {
    logOp('sidecar', 'error', {
      ...logMeta,
      command,
      status: 'err',
      dur_ms: Date.now() - t0,
      err: 'sidecar wrote to stderr',
    });
    throw formatSidecarError(command, stderr.trim(), 'sidecar wrote to stderr');
  }

  return stdout.trim();
}

export async function umbralEncrypt(epochPkHex: string, plaintextHex: string): Promise<EncryptResult> {
  const out = await runSidecar('encrypt', [
    '--epoch-pk', epochPkHex,
    '--plaintext', plaintextHex,
  ], {
    epoch_pk_fp: fp(epochPkHex),
    plaintext_len: Math.floor(plaintextHex.length / 2),
  });

  const capsule = out.capsule;
  const ciphertext = out.ciphertext;
  if (typeof capsule !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('sidecar encrypt response missing capsule/ciphertext');
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
  const out = await runSidecar('decrypt-reencrypted', [
    '--capsule', capsuleHex,
    '--cfrags', cfragsHex,
    '--ciphertext', ciphertextHex,
    '--receiving-sk', receivingSkHex,
    '--delegating-pk', delegatingPkHex,
  ], {
    capsule_fp: fp(capsuleHex),
    delegating_pk_fp: fp(delegatingPkHex),
    receiving_pk_fp: fp(receivingSkHex),
    cfrags_len: Math.floor(cfragsHex.length / 2),
    ciphertext_len: Math.floor(ciphertextHex.length / 2),
  });

  const plaintext = out.plaintext;
  if (typeof plaintext !== 'string') {
    throw new Error('sidecar decrypt-reencrypted response missing plaintext');
  }

  return plaintext;
}

export async function umbralDeriveEpochKeypair(seedHex: string): Promise<{ secretKeyHex: string; publicKeyHex: string }> {
  const out = await runSidecar('derive-epoch-keypair', [
    '--seed', seedHex,
  ], {
    seed_len: Math.floor(seedHex.length / 2),
  });

  const secretKeyHex = out.secret_key;
  const publicKeyHex = out.public_key;
  if (typeof secretKeyHex !== 'string' || typeof publicKeyHex !== 'string') {
    throw new Error('sidecar derive-epoch-keypair response missing secret_key/public_key');
  }

  return { secretKeyHex, publicKeyHex };
}

export async function umbralGenerateKfrag(delegatingSkHex: string, receivingPkHex: string): Promise<string> {
  const kfragHex = await runSidecarText('generate-kfrags', [
    '--delegating-sk', delegatingSkHex,
    '--receiving-pk', receivingPkHex,
  ], {
    receiving_pk_fp: fp(receivingPkHex),
    delegating_sk_len: Math.floor(delegatingSkHex.length / 2),
  });

  if (!kfragHex) {
    throw new Error('sidecar generate-kfrags returned empty output');
  }

  return kfragHex;
}
