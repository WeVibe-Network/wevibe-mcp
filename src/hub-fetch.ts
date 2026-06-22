import { createHash } from 'node:crypto';
import { verify } from './crypto.js';
import { getOrgHubState } from './identity-sidecar.js';

const warnedMissingPubkeyOrgs = new Set<string>();
const HUB_SIGNATURE_HEADER = 'x-hub-signature';

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

function verifyBody(
  verificationSubject: string,
  bodyBytes: Uint8Array,
  signatureHex: string,
  pubkeyHex: string,
  pubkeyName: string,
): void {
  let pubkeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;

  try {
    pubkeyBytes = hexToUint8Array(pubkeyHex);
  } catch {
    throw new HubSignatureError(`hub response signature verification failed for ${verificationSubject}: invalid ${pubkeyName}`);
  }

  try {
    signatureBytes = hexToUint8Array(signatureHex);
  } catch {
    throw new HubSignatureError(`hub response signature verification failed for ${verificationSubject}: malformed X-Hub-Signature header`);
  }

  if (pubkeyBytes.length !== 32) {
    throw new HubSignatureError(`hub response signature verification failed for ${verificationSubject}: ${pubkeyName} must be 32 bytes`);
  }
  if (signatureBytes.length !== 64) {
    throw new HubSignatureError(`hub response signature verification failed for ${verificationSubject}: X-Hub-Signature must be 64 bytes`);
  }

  const digest = new Uint8Array(createHash('sha256').update(bodyBytes).digest());
  const isValid = verify(pubkeyBytes, signatureBytes, digest);

  if (!isValid) {
    throw new HubSignatureError(`hub response signature verification failed for ${verificationSubject}: signature mismatch`);
  }
}

function getRequiredSignatureHeader(res: Response, verificationSubject: string): string {
  const signatureHex = res.headers.get(HUB_SIGNATURE_HEADER);
  if (!signatureHex) {
    throw new HubSignatureError(`hub response signature verification failed for ${verificationSubject}: missing X-Hub-Signature header`);
  }
  return signatureHex;
}

async function fetchWithBody(url: string, init?: RequestInit): Promise<{ res: Response; bodyBytes: Uint8Array; bodyText: string }> {
  const res = await fetch(url, init);
  const bodyBytes = new Uint8Array(await res.arrayBuffer());
  const bodyText = new TextDecoder().decode(bodyBytes);
  return { res, bodyBytes, bodyText };
}

function asVerifiedResult(res: Response, bodyText: string): HubFetchVerifiedResult {
  return {
    res,
    bodyText,
    json<T>(): T {
      return JSON.parse(bodyText) as T;
    },
  };
}

export async function hubFetchVerified(orgId: string, url: string, init?: RequestInit): Promise<HubFetchVerifiedResult> {
  const { res, bodyBytes, bodyText } = await fetchWithBody(url, init);

  const hubResponsePubkey = getOrgHubState(orgId)?.hubResponsePubkey;

  if (hubResponsePubkey) {
    const signatureHex = getRequiredSignatureHeader(res, orgId);
    verifyBody(orgId, bodyBytes, signatureHex, hubResponsePubkey, 'hub_response_pubkey');
  } else if (!warnedMissingPubkeyOrgs.has(orgId)) {
    warnedMissingPubkeyOrgs.add(orgId);
    console.warn(`hub response signature not verified for ${orgId}: no hub_response_pubkey published yet`);
  }

  return asVerifiedResult(res, bodyText);
}

export async function hubFetchVerifiedWithKey(
  responsePubkeyHex: string,
  url: string,
  init?: RequestInit,
): Promise<HubFetchVerifiedResult> {
  const { res, bodyBytes, bodyText } = await fetchWithBody(url, init);
  const signatureHex = getRequiredSignatureHeader(res, 'hub-level key');
  verifyBody('hub-level key', bodyBytes, signatureHex, responsePubkeyHex, 'response_pubkey');

  return asVerifiedResult(res, bodyText);
}
