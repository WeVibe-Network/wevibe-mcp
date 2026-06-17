import { randomBytes } from 'node:crypto';
import { buildWeVibeSignedAuth } from './auth.js';
import { HUB_URL } from './config.js';
import { writeIdentitySidecar } from './identity-sidecar.js';
import { loadIdentitySeed } from './key-store.js';
import { base32Encode, encryptIdentitySeedForPairing, pairingIdFromSecret } from './pair-crypto.js';

export async function exportIdentityPairing(): Promise<{ token: string; pairingId: string }> {
  let secret: Buffer | null = null;
  let seed: Uint8Array | null = null;

  try {
    seed = await loadIdentitySeed();
    if (!seed) {
      throw new Error('No identity. Run setup-identity first.');
    }

    secret = randomBytes(16);
    const { hkdfSalt, iv, ciphertextWithTag } = encryptIdentitySeedForPairing(seed, secret);

    const pairingId = pairingIdFromSecret(secret);
    const token = base32Encode(secret);

    const { headers } = await buildWeVibeSignedAuth();
    const resp = await fetch(`${HUB_URL}/v1/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        pairing_id: pairingId,
        hkdf_salt: hkdfSalt.toString('base64'),
        iv: iv.toString('base64'),
        ciphertext: ciphertextWithTag.toString('base64'),
      }),
    });

    if (!resp.ok) {
      throw new Error(`Hub upload failed: ${resp.status}`);
    }

    // Record the pairing id so the plugin/dashboard flow can poll consumption.
    try {
      writeIdentitySidecar({ lastPairingId: pairingId });
    } catch {
      // best-effort
    }

    return { token, pairingId };
  } finally {
    if (secret) secret.fill(0);
    if (seed) seed.fill(0);
  }
}
