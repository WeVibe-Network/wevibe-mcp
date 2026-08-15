import { describe, expect, it } from 'vitest';
import { generateIdentityFromSeed } from '../src/crypto.js';

// PARITY VECTORS for the single-identity seed derivation, pinned to guard
// wevibe-sdk crates/wevibe-sdk-core/src/crypto.rs:147-161 (compiled to WASM,
// exercised here through src/crypto.ts generateIdentityFromSeed):
//   ed25519 privkey = seed verbatim; ed25519 pubkey = ed25519 pubkey of that seed
//   x25519 privkey  = HKDF-SHA256(ikm=seed, salt=EMPTY, info="wevibe-x25519-v1") -> 32B
//   x25519 pubkey   = x25519 pubkey of that privkey
// The expected values were computed ONCE with INDEPENDENT references — @noble/ed25519
// (ed25519), @noble/hashes (HKDF-SHA256), @noble/curves (x25519) — cross-checked
// against OpenSSL via node:crypto (hkdfSync + X25519 PKCS8/SPKI), and are HARDCODED:
// no runtime recomputation, so any drift in the derivation fails here. Cross-
// implementation parity (noble != ed25519-dalek/x25519-dalek/Rust-hkdf in the WASM).
// SECURITY: TEST_SEED_HEX is a fixed non-secret test constant (bytes 0x00..0x1f).
// It is NEVER a live identity seed.
const TEST_SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const VECTOR_ED_PUBKEY_HEX = '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8';
const VECTOR_X_PRIVKEY_HEX = '6f488dbf45ad25a871497c65546594099b353d5cf6c9b2c87cd0484fcc098d83';
const VECTOR_X_PUBKEY_HEX = '4bfdab281b03b23d16b53b5c5db4017957997f3924a6fde66dd40ed0c7164a1c';

describe('seed derivation parity vectors', () => {
  it('pins ed25519 = seed verbatim and x25519 = HKDF-SHA256(seed, empty salt, "wevibe-x25519-v1")', () => {
    const seed = new Uint8Array(Buffer.from(TEST_SEED_HEX, 'hex'));
    const identity = generateIdentityFromSeed(seed);

    // (a) ed25519 privkey is the seed verbatim — the single-identity canon.
    expect(Buffer.from(identity.edPrivkey).toString('hex')).toBe(TEST_SEED_HEX);
    // (b) ed25519 pubkey matches the independent noble-derived vector.
    expect(Buffer.from(identity.edPubkey).toString('hex')).toBe(VECTOR_ED_PUBKEY_HEX);
    // (c) x25519 privkey is exactly the HKDF-SHA256 expansion output.
    expect(Buffer.from(identity.xPrivkey).toString('hex')).toBe(VECTOR_X_PRIVKEY_HEX);
    // (d) x25519 pubkey matches the independent noble-derived vector.
    expect(Buffer.from(identity.xPubkey).toString('hex')).toBe(VECTOR_X_PUBKEY_HEX);
  });
});
