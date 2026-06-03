import { decryptSymmetric, openEnvelope, sign, generateDek, deriveEpochKeys, sealToPubkey, generateIdentity } from './crypto.js';
import { loadIdentity, storeKeyEnvelope, loadKeyEnvelope } from './key-store.js';
import { buildWeVibeSignedAuth, getOrCreatePreIdentity, getPrePublicKeyHex, getPreSecretKeyHex } from './auth.js';
import { feeModelHash, inviteMemberMessage, rotateEpochMessage, type FeeModel } from './canonical.js';
import { generateRecoveryPhrase } from './recovery.js';
import { isVaultUnlocked, addOrgToVault, getVaultCache, updateVaultEntry, type VaultEntry } from './vault.js';
import { ensureCrypto } from './crypto-utils.js';
import type { OrgMembership } from './types.js';
import type { MemoryType } from './types.js';
import { umbralDecryptReencrypted } from './sidecar.js';

interface HubMemberOrgEntry {
  org_id: string;
  org_name: string;
  role: string;
  current_epoch: number;
  history_access_from_epoch: number;
  egress_mode: string;
  allowed_providers: string[];
  mod_pubkey?: string;
}

interface HubMemberOrgsResponse {
  orgs: HubMemberOrgEntry[];
}

interface HubKeyEnvelopeResponse {
  org_id: string;
  epoch_id: number;
  enc_envelope: string;
  search_envelope: string;
  mod_envelope: string | null;
}

interface EpochManifestResponse {
  umbral_pk?: string;
}

const epochUmbralPkCache = new Map<string, string>();

export interface QueryMemoryRequest {
  hubUrl: string;
  orgId: string;
  agentPubkey: string;
  keywordWeights: Array<{ keyword: string; weight: number }>;
  vector: number[];
  embeddingModelId: string;
  limit: number;
  agentSig: string;
}

export interface QueryMemoryResponse {
  results?: QueryMemoryResult[];
  contested?: boolean;
  receipt_id?: string;
}

export interface QueryMemoryResult {
  cid: string;
  org_id: string;
  epoch_id: number;
  memory_type: MemoryType;
  capsule: string;
  cfrag: string;
  umbral_ciphertext: string;
  content_flags?: string[];
  freshness_score?: number;
  retrieval_count?: number;
  acceptance_count?: number;
  keywords?: Array<{ keyword: string; weight: number }>;
  contributor_stats?: {
    account_age_days: number;
    contributions: number;
    serve_count: number;
    reports_upheld: number;
    false_reports_against: number;
  };
  scoring_breakdown?: {
    keyword_score: number;
    vector_score: number;
    gamma: number;
    delta: number;
    capped_boost: number;
    combined_score: number;
    keyword_matches: Array<{
      keyword: string;
      query_weight: number;
      memory_weight: number;
      product: number;
    }>;
    unmatched_query_keywords: string[];
  };
}

export async function queryOrgMemories(params: QueryMemoryRequest): Promise<QueryMemoryResponse> {
  await getOrCreatePreIdentity();
  const { headers } = await buildWeVibeSignedAuth();

  const requestBody = {
    org_id: params.orgId,
    agent_pubkey: params.agentPubkey,
    keyword_weights: params.keywordWeights,
    vector: params.vector,
    embedding_model_id: params.embeddingModelId,
    limit: params.limit,
    agent_sig: params.agentSig,
    pre_pubkey: getPrePublicKeyHex(),
  };

  const response = await fetch(`${params.hubUrl}/v1/orgs/${params.orgId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(`hub query failed: HTTP ${response.status}`);
  }

  return await response.json() as QueryMemoryResponse;
}

export async function registerPrePubkey(
  hubUrl: string,
  orgId: string,
  memberPubkey: string,
  prePubkeyHex: string,
): Promise<void> {
  try {
    const { headers } = await buildWeVibeSignedAuth();
    const response = await fetch(
      `${hubUrl}/v1/orgs/${orgId}/members/${memberPubkey}/pre-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ pre_pubkey: prePubkeyHex }),
      },
    );

    if (response.status === 404) {
      console.warn(`wevibe-mcp: PRE pubkey registration skipped for org ${orgId} — member not found`);
      return;
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn(
        `wevibe-mcp: PRE pubkey registration failed for org ${orgId}: HTTP ${response.status}${errBody ? ` — ${errBody}` : ''}`,
      );
      return;
    }

    console.warn(`wevibe-mcp: Registered PRE pubkey with hub for org ${orgId}`);
  } catch (error) {
    console.warn(`wevibe-mcp: PRE pubkey registration failed for org ${orgId}: ${error}`);
  }
}

async function fetchKeyEnvelope(
  hubUrl: string,
  orgId: string,
  _identity: { edPrivkey: Uint8Array; edPubkey: Uint8Array; xPrivkey: Uint8Array; xPubkey: Uint8Array },
): Promise<HubKeyEnvelopeResponse | null> {
  const { headers } = await buildWeVibeSignedAuth();

  try {
    const response = await fetch(
      `${hubUrl}/v1/orgs/${orgId}/keys/envelope`,
      { headers },
    );
    if (!response.ok) return null;
    return await response.json() as HubKeyEnvelopeResponse;
  } catch {
    return null;
  }
}

function packEpochKeyPair(epoch: number, key: Uint8Array): Uint8Array {
  const buf = new Uint8Array(36);
  const view = new DataView(buf.buffer);
  view.setUint32(0, epoch, true);
  buf.set(key, 4);
  return buf;
}

export async function loadMemberships(hubUrl: string): Promise<OrgMembership[]> {
  await ensureCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    throw new Error('no identity in keychain');
  }

  const { pubkeyHex, headers } = await buildWeVibeSignedAuth();

  let response: Response;
  try {
    response = await fetch(
      `${hubUrl}/v1/members/${pubkeyHex}/orgs`,
      { headers },
    );
  } catch (e) {
    throw new Error(`hub unavailable (${hubUrl}): ${e}`);
  }

  if (!response.ok) {
    throw new Error(`hub returned ${response.status} for member orgs list`);
  }

  let data: HubMemberOrgsResponse;
  try {
    data = await response.json() as HubMemberOrgsResponse;
  } catch {
    throw new Error('malformed hub response');
  }

  const memberships: OrgMembership[] = [];

  for (const org of data.orgs) {
    const encKeys = new Map<number, Uint8Array>();
    const searchKeys = new Map<number, Uint8Array>();

    const envResponse = await fetchKeyEnvelope(hubUrl, org.org_id, identity);

    if (envResponse?.enc_envelope) {
      try {
        const sealedEnc = new Uint8Array(Buffer.from(envResponse.enc_envelope, 'base64'));
        const unsealedEnc = openEnvelope(sealedEnc, identity.xPrivkey);
        const view = new DataView(unsealedEnc.buffer, unsealedEnc.byteOffset, unsealedEnc.byteLength);
        let offset = 0;
        while (offset + 36 <= unsealedEnc.length) {
          const epoch = view.getUint32(offset, true);
          const key = unsealedEnc.slice(offset + 4, offset + 36);
          encKeys.set(epoch, key);
          offset += 36;
        }
      } catch {
        // envelope unsealing/parsing failed — skip
      }
    }

    if (envResponse?.search_envelope) {
      try {
        const sealedSearch = new Uint8Array(Buffer.from(envResponse.search_envelope, 'base64'));
        const unsealedSearch = openEnvelope(sealedSearch, identity.xPrivkey);
        const view = new DataView(unsealedSearch.buffer, unsealedSearch.byteOffset, unsealedSearch.byteLength);
        let offset = 0;
        while (offset + 36 <= unsealedSearch.length) {
          const epoch = view.getUint32(offset, true);
          const key = unsealedSearch.slice(offset + 4, offset + 36);
          searchKeys.set(epoch, key);
          offset += 36;
        }
      } catch {
        // envelope unsealing/parsing failed — skip
      }
    }

    let modPrivkey: Uint8Array | null = null;
    if ((org.role === 'leader' || org.role === 'moderator') && envResponse?.mod_envelope) {
      try {
        const sealedMod = new Uint8Array(Buffer.from(envResponse.mod_envelope, 'base64'));
        modPrivkey = openEnvelope(sealedMod, identity.xPrivkey);
      } catch {
        // mod envelope unsealing failed — skip
      }
    }

    memberships.push({
      orgId: org.org_id,
      orgName: org.org_name,
      role: org.role as 'leader' | 'moderator' | 'member',
      currentEpoch: org.current_epoch,
      historyAccessFromEpoch: org.history_access_from_epoch,
      egressMode: org.egress_mode as 'local_only' | 'allowlist' | 'unrestricted',
      allowedProviders: org.allowed_providers,
      encKeys,
      searchKeys,
      modPubkey: org.mod_pubkey ? new Uint8Array(Buffer.from(org.mod_pubkey, 'hex')) : null,
      modPrivkey,
    });

    if (isVaultUnlocked() && (org.role === 'leader' || org.role === 'moderator') && modPrivkey) {
      const skModHex = Buffer.from(modPrivkey).toString('hex');
      await updateVaultEntry(org.org_id, {
        sk_mod_hex: skModHex,
        current_epoch: org.current_epoch,
      }).catch(() => {});
    }
  }

  return memberships;
}

async function fetchEpochManifest(
  hubUrl: string,
  orgId: string,
  epochId: number,
): Promise<EpochManifestResponse> {
  const { headers } = await buildWeVibeSignedAuth();

  const response = await fetch(
    `${hubUrl}/v1/orgs/${orgId}/epoch/${epochId}/manifest`,
    { headers },
  );

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`failed to fetch epoch manifest (${response.status})${errBody ? `: ${errBody}` : ''}`);
  }

  return await response.json() as EpochManifestResponse;
}

async function getEpochUmbralPk(
  hubUrl: string,
  orgId: string,
  epochId: number,
): Promise<string> {
  const cacheKey = `${orgId}:${epochId}`;
  const cached = epochUmbralPkCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const manifest = await fetchEpochManifest(hubUrl, orgId, epochId);
  if (!manifest.umbral_pk) {
    throw new Error(`epoch manifest missing umbral_pk for epoch ${epochId}`);
  }

  epochUmbralPkCache.set(cacheKey, manifest.umbral_pk);
  return manifest.umbral_pk;
}

export async function decryptMemoryBlob(
  _cid: string,
  capsuleHex: string,
  cfragHex: string,
  umbralCiphertextHex: string,
  ciphertext: Uint8Array,
  membership: OrgMembership,
  epochId: number,
  hubUrl: string,
): Promise<Uint8Array> {
  if (!capsuleHex || !cfragHex || !umbralCiphertextHex) {
    throw new Error('memory result missing required PRE fields (capsule, cfrag, umbral_ciphertext)');
  }

  await getOrCreatePreIdentity();
  const receivingSkHex = getPreSecretKeyHex();
  const delegatingPkHex = await getEpochUmbralPk(hubUrl, membership.orgId, epochId);

  const dekHex = await umbralDecryptReencrypted(
    capsuleHex,
    cfragHex,
    umbralCiphertextHex,
    receivingSkHex,
    delegatingPkHex,
  );

  const dek = new Uint8Array(Buffer.from(dekHex, 'hex'));
  if (dek.length !== 32) {
    throw new Error(`invalid DEK length from sidecar: expected 32 bytes, got ${dek.length}`);
  }

  return decryptSymmetric(ciphertext, dek);
}

export function checkEgressPolicy(membership: OrgMembership, provider: string | null): boolean {
  if (membership.egressMode === 'local_only') return provider === null;
  if (membership.egressMode === 'allowlist') return provider !== null && membership.allowedProviders.includes(provider);
  return true;
}

export interface CreateOrgParams {
  orgName: string;
  domain: string;
  hubUrl: string;
  leaderWallet?: string;
  feeModel?: FeeModel | null;
}

export interface CreateOrgResult {
  orgId: string;
  status: 'created' | 'error';
  epochSkHex?: string;
  epochPkHex?: string;
  error?: string;
}

export async function createOrg(params: CreateOrgParams): Promise<CreateOrgResult> {
  await ensureCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    return { orgId: '', status: 'error', error: 'no identity in keychain' };
  }

  const leaderPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
  const leaderX25519Hex = Buffer.from(identity.xPubkey).toString('hex');
  const leaderWallet = (params.leaderWallet ?? process.env.WEVIBE_LEADER_WALLET ?? '').trim();

  if (leaderWallet.length === 0) {
    return {
      orgId: '',
      status: 'error',
      error: 'leader wallet is required (set createOrg leaderWallet or WEVIBE_LEADER_WALLET)',
    };
  }

  const masterKey = generateDek();
  const epoch0Keys = deriveEpochKeys(masterKey, 0);

  const modIdentity = generateIdentity();
  const pkModHex = Buffer.from(modIdentity.xPubkey).toString('hex');

  const encPlaintext = packEpochKeyPair(0, epoch0Keys.encKey);
  const sealedEnc = sealToPubkey(encPlaintext, identity.xPubkey);
  const encEnvelopeB64 = Buffer.from(sealedEnc).toString('base64');

  const searchPlaintext = packEpochKeyPair(0, epoch0Keys.searchKey);
  const sealedSearch = sealToPubkey(searchPlaintext, identity.xPubkey);
  const searchEnvelopeB64 = Buffer.from(sealedSearch).toString('base64');

  const sealedMod = sealToPubkey(modIdentity.xPrivkey, identity.xPubkey);
  const modEnvelopeB64 = Buffer.from(sealedMod).toString('base64');

  if (!sealedMod || sealedMod.length === 0) {
    return { orgId: '', status: 'error', error: 'mod_envelope generation failed — cannot create org without leader mod envelope' };
  }

  const feeModel = params.feeModel ?? null;
  const canonical = new TextEncoder().encode([
    'wevibe.create_org.v1',
    `domain:${params.domain}`,
    `enc_envelope:${encEnvelopeB64}`,
    `fee_model_hash:${feeModelHash(feeModel)}`,
    `leader_pubkey:${leaderPubkeyHex}`,
    `leader_x25519_pubkey:${leaderX25519Hex}`,
    `mod_envelope:${modEnvelopeB64}`,
    `org_name:${params.orgName}`,
    `pk_mod:${pkModHex}`,
    `search_envelope:${searchEnvelopeB64}`,
  ].join('\n'));
  const sig = sign(identity.edPrivkey, canonical);
  const sigHex = Buffer.from(sig).toString('hex');

  const payload = {
    leader_pubkey: leaderPubkeyHex,
    leader_x25519_pubkey: leaderX25519Hex,
    leader_wallet: leaderWallet,
    org_name: params.orgName,
    domain: params.domain,
    fee_model: feeModel,
    pk_mod: pkModHex,
    signature: sigHex,
    enc_envelope: encEnvelopeB64,
    search_envelope: searchEnvelopeB64,
    mod_envelope: modEnvelopeB64,
  };

  let response: Response;
  try {
    response = await fetch(`${params.hubUrl}/v1/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { orgId: '', status: 'error', error: `hub unavailable: ${e}` };
  }

  if (!response.ok) {
    let errMsg: string;
    try {
      const errBody = await response.json() as { error?: string };
      errMsg = errBody.error ?? `HTTP ${response.status}`;
    } catch {
      errMsg = `HTTP ${response.status}`;
    }
    return { orgId: '', status: 'error', error: errMsg };
  }

  let responseBody: {
    org_id?: string;
    epoch_sk?: string;
    epoch_pk?: string;
  };
  try {
    responseBody = await response.json() as {
      org_id?: string;
      epoch_sk?: string;
      epoch_pk?: string;
    };
  } catch {
    return { orgId: '', status: 'error', error: 'create-org response missing JSON body' };
  }

  if (typeof responseBody.org_id !== 'string' || responseBody.org_id.length === 0) {
    return { orgId: '', status: 'error', error: 'create-org response missing org_id' };
  }

  const createdOrgId = responseBody.org_id;

  if (typeof responseBody.epoch_sk !== 'string' || responseBody.epoch_sk.length === 0) {
    return { orgId: createdOrgId, status: 'error', error: 'create-org response missing epoch_sk' };
  }

  if (typeof responseBody.epoch_pk !== 'string' || responseBody.epoch_pk.length === 0) {
    return { orgId: createdOrgId, status: 'error', error: 'create-org response missing epoch_pk' };
  }

  const epochSkBytes = Buffer.from(responseBody.epoch_sk, 'hex');
  if (epochSkBytes.length !== 32) {
    return { orgId: createdOrgId, status: 'error', error: `create-org response epoch_sk invalid length: ${epochSkBytes.length}` };
  }

  const epochPkBytes = Buffer.from(responseBody.epoch_pk, 'hex');
  if (epochPkBytes.length !== 33) {
    return { orgId: createdOrgId, status: 'error', error: `create-org response epoch_pk invalid length: ${epochPkBytes.length}` };
  }

  await storeKeyEnvelope(createdOrgId, 'master', masterKey);
  await storeKeyEnvelope(createdOrgId, 'mod-privkey', modIdentity.xPrivkey);
  await storeKeyEnvelope(createdOrgId, 'epoch-sk', epochSkBytes);
  await storeKeyEnvelope(createdOrgId, 'epoch-pk', epochPkBytes);

  if (isVaultUnlocked()) {
    const phrase = generateRecoveryPhrase(masterKey);
    const skModHex = Buffer.from(modIdentity.xPrivkey).toString('hex');
    const entry: VaultEntry = {
      org_id: createdOrgId,
      org_name: params.orgName,
      k_master_hex: Buffer.from(masterKey).toString('hex'),
      recovery_phrase: phrase,
      sk_mod_hex: skModHex,
      current_epoch: 0,
      created_at: new Date().toISOString(),
      last_verified_at: null,
    };
    await addOrgToVault(entry).catch(() => {});
  }

  return {
    orgId: createdOrgId,
    status: 'created',
    epochSkHex: responseBody.epoch_sk,
    epochPkHex: responseBody.epoch_pk,
  };
}

export interface InviteMemberParams {
  orgId: string;
  inviteePubkeyHex: string;
  inviteeX25519PubkeyHex: string;
  epochSkHex: string;
  prePubkeyHex: string;
  role: 'member' | 'moderator';
  hubUrl: string;
}

export interface InviteMemberResult {
  status: 'invited' | 'error';
  error?: string;
}

export async function inviteMember(params: InviteMemberParams): Promise<InviteMemberResult> {
  await ensureCrypto();

  if (!params.epochSkHex || Buffer.from(params.epochSkHex, 'hex').length !== 32) {
    return { status: 'error', error: 'epoch_sk must be a 32-byte hex string' };
  }

  if (!params.prePubkeyHex || Buffer.from(params.prePubkeyHex, 'hex').length !== 33) {
    return { status: 'error', error: 'pre_pubkey must be a 33-byte compressed secp256k1 hex string' };
  }

  const identity = await loadIdentity();
  if (!identity) {
    return { status: 'error', error: 'no identity in keychain' };
  }

  const masterKey = await loadKeyEnvelope(params.orgId, 'master');
  if (!masterKey) {
    return { status: 'error', error: 'no master key found for this org — only the org leader can invite members' };
  }

  const inviteeX25519Pubkey = new Uint8Array(Buffer.from(params.inviteeX25519PubkeyHex, 'hex'));

  let modEnvelopeB64 = '';
  if (params.role === 'moderator') {
    const skMod = await loadKeyEnvelope(params.orgId, 'mod-privkey');
    if (!skMod) {
      return { status: 'error', error: 'no mod private key found — leader local keychain may be missing SK_mod for this org' };
    }
    const sealedMod = sealToPubkey(skMod, inviteeX25519Pubkey);
    modEnvelopeB64 = Buffer.from(sealedMod).toString('base64');
  }

  let currentEpoch = 0;
  try {
    const orgResp = await fetch(`${params.hubUrl}/v1/orgs/${params.orgId}`);
    if (orgResp.ok) {
      const orgInfo = await orgResp.json() as { current_epoch?: number };
      currentEpoch = orgInfo.current_epoch ?? 0;
    }
  } catch {
    // Default to epoch 0 if hub unavailable
  }

  const epochKeys = deriveEpochKeys(masterKey, currentEpoch);

  const encPlaintext = packEpochKeyPair(currentEpoch, epochKeys.encKey);
  const sealedEnc = sealToPubkey(encPlaintext, inviteeX25519Pubkey);
  const encEnvelopeB64 = Buffer.from(sealedEnc).toString('base64');

  const searchPlaintext = packEpochKeyPair(currentEpoch, epochKeys.searchKey);
  const sealedSearch = sealToPubkey(searchPlaintext, inviteeX25519Pubkey);
  const searchEnvelopeB64 = Buffer.from(sealedSearch).toString('base64');

  const leaderPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');

  const canonical = inviteMemberMessage(
    params.orgId, params.inviteePubkeyHex, params.inviteeX25519PubkeyHex,
    params.role, leaderPubkeyHex,
    encEnvelopeB64, searchEnvelopeB64, modEnvelopeB64,
  );
  const sig = sign(identity.edPrivkey, canonical);
  const sigHex = Buffer.from(sig).toString('hex');

  const payload: Record<string, unknown> = {
    pubkey: params.inviteePubkeyHex,
    x25519_pubkey: params.inviteeX25519PubkeyHex,
    pre_pubkey: params.prePubkeyHex,
    epoch_sk: params.epochSkHex,
    role: params.role,
    signed_by: leaderPubkeyHex,
    signature: sigHex,
    enc_envelope: encEnvelopeB64,
    search_envelope: searchEnvelopeB64,
  };
  if (modEnvelopeB64) {
    payload.mod_envelope = modEnvelopeB64;
  }

  let response: Response;
  try {
    response = await fetch(`${params.hubUrl}/v1/orgs/${params.orgId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { status: 'error', error: `hub unavailable: ${e}` };
  }

  if (!response.ok) {
    let errMsg: string;
    try {
      const errBody = await response.json() as { error?: string };
      errMsg = errBody.error ?? `HTTP ${response.status}`;
    } catch {
      errMsg = `HTTP ${response.status}`;
    }
    return { status: 'error', error: errMsg };
  }

  return { status: 'invited' };
}

export interface RotateEpochParams {
  orgId: string;
  hubUrl: string;
}

export interface RotateEpochResult {
  status: 'rotated' | 'error';
  newEpoch?: number;
  membersRekeyed?: number;
  bufferedMoved?: number;
  error?: string;
}

export async function rotateEpoch(params: RotateEpochParams): Promise<RotateEpochResult> {
  await ensureCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    return { status: 'error', error: 'no identity in keychain' };
  }

  const masterKey = await loadKeyEnvelope(params.orgId, 'master');
  if (!masterKey) {
    return { status: 'error', error: 'no master key found for this org — only the org leader can rotate' };
  }

  let currentEpoch = 0;
  try {
    const orgResp = await fetch(`${params.hubUrl}/v1/orgs/${params.orgId}`);
    if (orgResp.ok) {
      const orgInfo = await orgResp.json() as { current_epoch?: number };
      currentEpoch = orgInfo.current_epoch ?? 0;
    }
  } catch {
    return { status: 'error', error: 'hub unavailable' };
  }

  const newEpoch = currentEpoch + 1;
  const newEpochKeys = deriveEpochKeys(masterKey, newEpoch);

  const newModIdentity = generateIdentity();
  const newPkModHex = Buffer.from(newModIdentity.xPubkey).toString('hex');

  let activeMembers: Array<{ pubkey: string; x25519_pubkey: string; role: string }> = [];
  try {
    const membersResp = await fetch(`${params.hubUrl}/v1/orgs/${params.orgId}/members`);
    if (membersResp.ok) {
      const allMembers = await membersResp.json() as Array<{ pubkey: string; x25519_pubkey: string; role: string; active: boolean }>;
      activeMembers = allMembers.filter(m => m.active);
    }
  } catch {
    return { status: 'error', error: 'failed to fetch member list' };
  }

  if (activeMembers.length === 0) {
    return { status: 'error', error: 'no active members found' };
  }

  const envelopes: Array<{ pubkey: string; enc_envelope: string; search_envelope: string; mod_envelope?: string | null }> = [];

  for (const member of activeMembers) {
    const memberX25519 = new Uint8Array(Buffer.from(member.x25519_pubkey, 'hex'));

    const encPlaintext = packEpochKeyPair(newEpoch, newEpochKeys.encKey);
    const sealedEnc = sealToPubkey(encPlaintext, memberX25519);
    const encEnvelopeB64 = Buffer.from(sealedEnc).toString('base64');

    const searchPlaintext = packEpochKeyPair(newEpoch, newEpochKeys.searchKey);
    const sealedSearch = sealToPubkey(searchPlaintext, memberX25519);
    const searchEnvelopeB64 = Buffer.from(sealedSearch).toString('base64');

    let modEnvelopeB64: string | null = null;
    if (member.role === 'leader' || member.role === 'moderator') {
      const sealedMod = sealToPubkey(newModIdentity.xPrivkey, memberX25519);
      modEnvelopeB64 = Buffer.from(sealedMod).toString('base64');
    }

    envelopes.push({
      pubkey: member.pubkey,
      enc_envelope: encEnvelopeB64,
      search_envelope: searchEnvelopeB64,
      mod_envelope: modEnvelopeB64,
    });
  }

  const leaderPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
  const canonical = rotateEpochMessage(params.orgId, newPkModHex, leaderPubkeyHex, envelopes);
  const sig = sign(identity.edPrivkey, canonical);
  const sigHex = Buffer.from(sig).toString('hex');

  const payload = {
    new_pk_mod: newPkModHex,
    signed_by: leaderPubkeyHex,
    signature: sigHex,
    envelopes: envelopes.map(e => ({
      pubkey: e.pubkey,
      enc_envelope: e.enc_envelope,
      search_envelope: e.search_envelope,
      mod_envelope: e.mod_envelope,
    })),
  };

  let response: Response;
  try {
    response = await fetch(`${params.hubUrl}/v1/orgs/${params.orgId}/epoch/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { status: 'error', error: `hub unavailable: ${e}` };
  }

  if (!response.ok) {
    let errMsg: string;
    try {
      const errBody = await response.json() as { error?: string };
      errMsg = errBody.error ?? `HTTP ${response.status}`;
    } catch {
      errMsg = `HTTP ${response.status}`;
    }
    return { status: 'error', error: errMsg };
  }

  let bufferedMoved = 0;
  let respBody: { buffered_moved?: number; epoch_sk?: string; epoch_pk?: string } = {};
  try {
    respBody = await response.json() as { buffered_moved?: number; epoch_sk?: string; epoch_pk?: string };
    bufferedMoved = respBody.buffered_moved ?? 0;
  } catch {
    // Response parsing optional
  }

  if (typeof respBody.epoch_sk === 'string' && respBody.epoch_sk.length > 0) {
    const epochSkBytes = Buffer.from(respBody.epoch_sk, 'hex');
    if (epochSkBytes.length === 32) {
      await storeKeyEnvelope(params.orgId, 'epoch-sk', epochSkBytes);
    }
  }

  if (typeof respBody.epoch_pk === 'string' && respBody.epoch_pk.length > 0) {
    const epochPkBytes = Buffer.from(respBody.epoch_pk, 'hex');
    if (epochPkBytes.length === 33) {
      await storeKeyEnvelope(params.orgId, 'epoch-pk', epochPkBytes);
    }
  }

  await storeKeyEnvelope(params.orgId, 'mod-privkey', newModIdentity.xPrivkey);

  if (isVaultUnlocked()) {
    await updateVaultEntry(params.orgId, {
      sk_mod_hex: Buffer.from(newModIdentity.xPrivkey).toString('hex'),
      current_epoch: newEpoch,
    }).catch(() => {});
  }

  return {
    status: 'rotated',
    newEpoch,
    membersRekeyed: activeMembers.length,
    bufferedMoved,
  };
}

interface HubKeywordEntry {
  keyword: string;
  created_at: string;
  deprecated: boolean;
  usage_count: number;
}

export async function getOrgKeywords(hubUrl: string, orgId: string): Promise<string[]> {
  const { headers } = await buildWeVibeSignedAuth();

  const response = await fetch(`${hubUrl}/v1/orgs/${orgId}/keywords`, { headers });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`failed to fetch org keywords (${response.status})${errBody ? `: ${errBody}` : ''}`);
  }

  const entries = await response.json() as HubKeywordEntry[];

  return entries
    .filter(e => !e.deprecated)
    .map(e => e.keyword);
}
