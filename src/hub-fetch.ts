import { createHash } from 'node:crypto';
import { verify } from './crypto.js';
import { getOrgHubState } from './identity-sidecar.js';

const warnedMissingPubkeyOrgs = new Set<string>();

export class HubSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubSignatureError';
  }
}

export interface HubFetchVerifiedResult {
  res: Response;
  bodyText: string;
  json<T>(): T;
}

export function hexToUint8Array(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(`invalid hex input: "${hex}"`);
  }
  return new Uint8Array(Buffer.from(normalized, 'hex'));
}

function verifyHubResponseSignature(orgId: string, bodyBytes: Uint8Array, signatureHex: string, pubkeyHex: string): void {
  let pubkeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;

  try {
    pubkeyBytes = hexToUint8Array(pubkeyHex);
  } catch {
    throw new HubSignatureError(`hub response signature verification failed for ${orgId}: invalid hub_response_pubkey`);
  }

  try {
    signatureBytes = hexToUint8Array(signatureHex);
  } catch {
    throw new HubSignatureError(`hub response signature verification failed for ${orgId}: malformed X-Hub-Signature header`);
  }

  if (pubkeyBytes.length !== 32) {
    throw new HubSignatureError(`hub response signature verification failed for ${orgId}: hub_response_pubkey must be 32 bytes`);
  }
  if (signatureBytes.length !== 64) {
    throw new HubSignatureError(`hub response signature verification failed for ${orgId}: X-Hub-Signature must be 64 bytes`);
  }

  const digest = new Uint8Array(createHash('sha256').update(bodyBytes).digest());
  const isValid = verify(pubkeyBytes, signatureBytes, digest);

  if (!isValid) {
    throw new HubSignatureError(`hub response signature verification failed for ${orgId}: signature mismatch`);
  }
}

export async function hubFetchVerified(orgId: string, url: string, init?: RequestInit): Promise<HubFetchVerifiedResult> {
  const res = await fetch(url, init);
  const bodyBytes = new Uint8Array(await res.arrayBuffer());
  const bodyText = new TextDecoder().decode(bodyBytes);

  const hubResponsePubkey = getOrgHubState(orgId)?.hubResponsePubkey;

  if (hubResponsePubkey) {
    const signatureHex = res.headers.get('x-hub-signature');
    if (!signatureHex) {
      throw new HubSignatureError(`hub response signature verification failed for ${orgId}: missing X-Hub-Signature header`);
    }
    verifyHubResponseSignature(orgId, bodyBytes, signatureHex, hubResponsePubkey);
  } else if (!warnedMissingPubkeyOrgs.has(orgId)) {
    warnedMissingPubkeyOrgs.add(orgId);
    console.warn(`hub response signature not verified for ${orgId}: no hub_response_pubkey published yet`);
  }

  return {
    res,
    bodyText,
    json<T>(): T {
      return JSON.parse(bodyText) as T;
    },
  };
}
