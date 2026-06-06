import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PAIRING_INFO = Buffer.from('wevibe-pair-v1', 'utf8');
const GCM_TAG_BYTES = 16;

const BASE32_LOOKUP = new Map<string, number>(
  Array.from(BASE32_ALPHABET).map((char, idx) => [char, idx]),
);

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let bitsLeft = 0;
  const output: string[] = [];

  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitsLeft += 8;

    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      output.push(BASE32_ALPHABET[(bits >> bitsLeft) & 0x1f]);
      bits &= (1 << bitsLeft) - 1;
    }
  }

  if (bitsLeft > 0) {
    output.push(BASE32_ALPHABET[(bits << (5 - bitsLeft)) & 0x1f]);
  }

  return output.join('');
}

export function base32Decode(input: string): Buffer {
  let bits = 0;
  let bitsLeft = 0;
  const output: number[] = [];

  for (const char of input) {
    const value = BASE32_LOOKUP.get(char);
    if (value === undefined) {
      throw new Error('invalid base32 token');
    }

    bits = (bits << 5) | value;
    bitsLeft += 5;

    while (bitsLeft >= 8) {
      bitsLeft -= 8;
      output.push((bits >> bitsLeft) & 0xff);
      bits &= (1 << bitsLeft) - 1;
    }
  }

  if (bitsLeft > 0) {
    const mask = (1 << bitsLeft) - 1;
    if ((bits & mask) !== 0) {
      throw new Error('invalid base32 token');
    }
  }

  return Buffer.from(output);
}

export function pairingIdFromSecret(secret: Uint8Array): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function decryptPairedIdentitySeed(
  secret: Uint8Array,
  hkdfSalt: Uint8Array,
  iv: Uint8Array,
  ciphertextWithTag: Uint8Array,
): Buffer {
  if (secret.length !== 16) {
    throw new Error('pairing secret must be 16 bytes');
  }
  if (hkdfSalt.length !== 32) {
    throw new Error('hkdf salt must be 32 bytes');
  }
  if (iv.length !== 12) {
    throw new Error('pairing iv must be 12 bytes');
  }

  const payload = Buffer.from(ciphertextWithTag);
  if (payload.length < GCM_TAG_BYTES) {
    throw new Error('ciphertext must include 16-byte auth tag');
  }

  const authTag = payload.subarray(payload.length - GCM_TAG_BYTES);
  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES);
  const key = Buffer.from(hkdfSync('sha256', secret, hkdfSalt, PAIRING_INFO, 32));

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const seed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (seed.length !== 32) {
      throw new Error('paired seed must be 32 bytes');
    }
    return seed;
  } finally {
    key.fill(0);
    payload.fill(0);
  }
}

export function encryptIdentitySeedForPairing(
  seed: Uint8Array,
  secret: Uint8Array,
): { hkdfSalt: Buffer; iv: Buffer; ciphertextWithTag: Buffer } {
  if (seed.length !== 32) {
    throw new Error('identity seed must be 32 bytes');
  }
  if (secret.length !== 16) {
    throw new Error('pairing secret must be 16 bytes');
  }

  const hkdfSalt = randomBytes(32);
  const iv = randomBytes(12);
  const key = Buffer.from(hkdfSync('sha256', secret, hkdfSalt, PAIRING_INFO, 32));

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      hkdfSalt,
      iv,
      ciphertextWithTag: Buffer.concat([ciphertext, authTag]),
    };
  } finally {
    key.fill(0);
  }
}
