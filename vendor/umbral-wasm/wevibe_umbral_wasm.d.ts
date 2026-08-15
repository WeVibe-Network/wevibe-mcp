/* tslint:disable */
/* eslint-disable */

/**
 * Matches `wevibe-umbral decrypt-reencrypted` — returns plaintext hex.
 */
export function decryptReencrypted(capsule_hex: string, cfrags_hex: string, ciphertext_hex: string, receiving_sk_hex: string, delegating_pk_hex: string): string;

/**
 * Matches `wevibe-umbral derive-epoch-keypair --seed <hex>`.
 */
export function deriveEpochKeypair(seed_hex: string): string;

/**
 * Matches `wevibe-umbral encrypt --epoch-pk <hex> --plaintext <hex>`.
 */
export function encrypt(epoch_pk_hex: string, plaintext_hex: string): string;

/**
 * Matches `wevibe-umbral generate-kfrags` — returns bare kfrag hex.
 */
export function generateKfrag(delegating_sk_hex: string, receiving_pk_hex: string): string;

/**
 * Matches `wevibe-umbral reencrypt` — returns bare cfrag hex.
 *
 * Not currently called by the MCP (the hub relays re-encryption), but exported
 * so the cross-compatibility test can drive a full round trip in-process.
 */
export function reencrypt(capsule_hex: string, kfrag_hex: string): string;
