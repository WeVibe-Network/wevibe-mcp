import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

async function runSidecar(command: string, args: string[]): Promise<Record<string, unknown>> {
  const bin = getSidecarBin();
  let stdout: string;
  let stderr: string;

  try {
    const output = await execFileAsync(bin, [command, ...args], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    const execError = error as Error & { stderr?: string };
    const stderrText = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    throw formatSidecarError(command, stderrText, execError.message);
  }

  if (stderr.trim()) {
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

export async function umbralEncrypt(epochPkHex: string, plaintextHex: string): Promise<EncryptResult> {
  const out = await runSidecar('encrypt', [
    '--epoch-pk', epochPkHex,
    '--plaintext', plaintextHex,
  ]);

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
  ]);

  const plaintext = out.plaintext;
  if (typeof plaintext !== 'string') {
    throw new Error('sidecar decrypt-reencrypted response missing plaintext');
  }

  return plaintext;
}
