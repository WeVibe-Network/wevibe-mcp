import { decryptSymmetric, openEnvelope, sign, generateDek, deriveEpochKeys, sealToPubkey, generateIdentity } from './crypto.js';
import { loadIdentity, storeKeyEnvelope, loadKeyEnvelope } from './key-store.js';
import { buildWeVibeSignedAuth, getOrCreatePreIdentity, getPrePublicKeyHex, getPreSecretKeyHex } from './auth.js';
import { feeModelHash, inviteMemberMessage, rotateEpochMessage, type FeeModel } from './canonical.js';
import { generateRecoveryPhrase } from './recovery.js';
import { isVaultUnlocked, addOrgToVault, getVaultCache, updateVaultEntry, type VaultEntry } from './vault.js';
import { ensureCrypto } from './crypto-utils.js';
import type { OrgMembership } from './types.js';
import type { MemoryType } from './types.js';
import { umbralDecryptReencrypted, umbralDeriveEpochKeypair, umbralGenerateKfrag } from './sidecar.js';
import { hubFetchVerified } from './hub-fetch.js';
import { HUB_URL } from './config.js';
import { hkdfSync } from 'node:crypto';

interface HubMemberOrgEntry {
  org_id: string;
  org_name: string;
  role: string;
  can_contribute?: boolean;
  can_moderate?: boolean;
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
const UMBRAL_EPOCH_SEED_LEN_BYTES = 32;

function epochUmbralSeed(masterKey: Uint8Array, epoch: number): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterKey),
      Buffer.alloc(0),
      Buffer.from(`wevibe-umbral-epoch-${epoch}`),
      UMBRAL_EPOCH_SEED_LEN_BYTES,
    ),
  );
}

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
  matched_keywords?: string[];
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

function sanitizeRecallLogValue(value: string): string {
  return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export async function queryOrgMemories(params: QueryMemoryRequest): Promise<QueryMemoryResponse> {
  await getOrCreatePreIdentity();
  const { headers } = await buildWeVibeSignedAuth();
  const prePubkey = getPrePublicKeyHex();

  const requestBody = {
    org_id: params.orgId,
    agent_pubkey: params.agentPubkey,
    keyword_weights: params.keywordWeights,
    vector: params.vector,
    embedding_model_id: params.embeddingModelId,
    limit: params.limit,
    agent_sig: params.agentSig,
    pre_pubkey: prePubkey,
  };

  console.error(
    '[recall] hub query request org=%s hubUrl=%s vector_len=%d keyword_count=%d embedding_model_id=%s limit=%d pre_pubkey_present=%s',
    params.orgId,
    params.hubUrl,
    params.vector.length,
    params.keywordWeights.length,
    sanitizeRecallLogValue(params.embeddingModelId),
    params.limit,
    prePubkey && prePubkey.length > 0 ? 'yes' : 'no',
  );

  const response = await hubFetchVerified(params.orgId, `${params.hubUrl}/v1/orgs/${params.orgId}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(requestBody),
  });

  console.error('[recall] hub query response org=%s hubUrl=%s status=%d', params.orgId, params.hubUrl, response.res.status);

  if (!response.res.ok) {
    const body = sanitizeRecallLogValue(response.bodyText.slice(0, 500));
    console.error('[recall] hub query org=%s status=%d body=%s', params.orgId, response.res.status, body);
    throw new Error(`hub query failed: HTTP ${response.res.status} body=${body}`);
  }

  return response.json<QueryMemoryResponse>();
}

export async function registerPrePubkey(
  hubUrl: string,
  orgId: string,
  memberPubkey: string,
  prePubkeyHex: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const { headers } = await buildWeVibeSignedAuth();
    const response = await hubFetchVerified(
      orgId,
      `${hubUrl}/v1/orgs/${orgId}/members/${memberPubkey}/pre-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ pre_pubkey: prePubkeyHex }),
      },
    );

    if (response.res.status === 404) {
      console.warn(`wevibe-mcp: PRE pubkey registration skipped for org ${orgId} — member not found`);
      return { ok: false, status: 404, error: 'member not found' };
    }

    if (!response.res.ok) {
      const errBody = response.bodyText;
      console.warn(
        `wevibe-mcp: PRE pubkey registration failed for org ${orgId}: HTTP ${response.res.status}${errBody ? ` — ${errBody}` : ''}`,
      );
      return {
        ok: false,
        status: response.res.status,
        error: errBody || `HTTP ${response.res.status}`,
      };
    }

    console.info(`wevibe-mcp: PRE pubkey registration succeeded for org ${orgId}`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`wevibe-mcp: PRE pubkey registration failed for org ${orgId}: ${message}`);
    return { ok: false, error: message };
  }
}

async function fetchKeyEnvelope(
  hubUrl: string,
  orgId: string,
  _identity: { edPrivkey: Uint8Array; edPubkey: Uint8Array; xPrivkey: Uint8Array; xPubkey: Uint8Array },
): Promise<HubKeyEnvelopeResponse | null> {
  const { headers } = await buildWeVibeSignedAuth();

  try {
    const response = await hubFetchVerified(
      orgId,
      `${hubUrl}/v1/orgs/${orgId}/keys/envelope`,
      { headers },
    );
    if (!response.res.ok) return null;
    return response.json<HubKeyEnvelopeResponse>();
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
    // Non-org-scoped route: no single org hub_response_pubkey applies.
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
    if ((org.role === 'leader' || org.can_moderate) && envResponse?.mod_envelope) {
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
      role: org.role as 'leader' | 'member',
      canContribute: org.can_contribute ?? false,
      canModerate: org.can_moderate ?? false,
      currentEpoch: org.current_epoch,
      historyAccessFromEpoch: org.history_access_from_epoch,
      egressMode: org.egress_mode as 'local_only' | 'allowlist' | 'unrestricted',
      allowedProviders: org.allowed_providers,
      encKeys,
      searchKeys,
      modPubkey: org.mod_pubkey ? new Uint8Array(Buffer.from(org.mod_pubkey, 'hex')) : null,
      modPrivkey,
    });

    if (isVaultUnlocked() && (org.role === 'leader' || org.can_moderate) && modPrivkey) {
      const skModHex = Buffer.from(modPrivkey).toString('hex');
      await updateVaultEntry(org.org_id, {
        sk_mod_hex: skModHex,
        current_epoch: org.current_epoch,
      }).catch(() => {});
    }
  }

  return memberships;
}

async function fetchCurrentEpoch(hubUrl: string, orgId: string): Promise<number> {
  const response = await hubFetchVerified(orgId, `${hubUrl}/v1/orgs/${orgId}`);

  if (!response.res.ok) {
    throw new Error(`failed to fetch org ${orgId} (${response.res.status})${response.bodyText ? `: ${response.bodyText}` : ''}`);
  }

  const orgInfo = response.json<{ current_epoch?: number }>();
  return typeof orgInfo.current_epoch === 'number' ? orgInfo.current_epoch : 0;
}

async function fetchEpochManifest(
  hubUrl: string,
  orgId: string,
  epochId: number,
): Promise<EpochManifestResponse> {
  const { headers } = await buildWeVibeSignedAuth();

  const response = await hubFetchVerified(
    orgId,
    `${hubUrl}/v1/orgs/${orgId}/epoch/${epochId}/manifest`,
    { headers },
  );

  if (!response.res.ok) {
    throw new Error(`failed to fetch epoch manifest (${response.res.status})${response.bodyText ? `: ${response.bodyText}` : ''}`);
  }

  return response.json<EpochManifestResponse>();
}

export async function getEpochUmbralPk(
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
  error?: string;
}

export interface OrgCryptoSetup {
  payload: {
    leader_pubkey: string;
    leader_x25519_pubkey: string;
    leader_wallet: string;
    org_name: string;
    domain: string;
    fee_model: FeeModel | null;
    pk_mod: string;
    umbral_pk: string;
    signature: string;
    enc_envelope: string;
    search_envelope: string;
    mod_envelope: string;
  };
  recoveryPhrase: string;
  masterKeyHex: string;
  modPrivkeyHex: string;
}

export async function buildOrgCryptoSetup(params: CreateOrgParams): Promise<OrgCryptoSetup> {
  await ensureCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    throw new Error('no identity in keychain');
  }

  const leaderPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
  const leaderX25519Hex = Buffer.from(identity.xPubkey).toString('hex');
  const leaderWallet = (params.leaderWallet ?? process.env.WEVIBE_LEADER_WALLET ?? '').trim();

  if (leaderWallet.length === 0) {
    throw new Error('leader wallet is required (set createOrg leaderWallet or WEVIBE_LEADER_WALLET)');
  }

  const masterKey = generateDek();
  const epoch0Keys = deriveEpochKeys(masterKey, 0);

  let epoch0UmbralPkHex: string;
  try {
    const epochSeed = epochUmbralSeed(masterKey, 0);
    const { publicKeyHex } = await umbralDeriveEpochKeypair(epochSeed.toString('hex'));
    epoch0UmbralPkHex = publicKeyHex;
  } catch (error) {
    throw new Error(`failed to derive epoch Umbral public key locally: ${(error as Error).message}`);
  }

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
    throw new Error('mod_envelope generation failed — cannot create org without leader mod envelope');
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
    umbral_pk: epoch0UmbralPkHex,
    signature: sigHex,
    enc_envelope: encEnvelopeB64,
    search_envelope: searchEnvelopeB64,
    mod_envelope: modEnvelopeB64,
  };

  const recoveryPhrase = generateRecoveryPhrase(masterKey);

  return {
    payload,
    recoveryPhrase,
    masterKeyHex: Buffer.from(masterKey).toString('hex'),
    modPrivkeyHex: Buffer.from(modIdentity.xPrivkey).toString('hex'),
  };
}

export async function persistOrgKeys(
  orgId: string,
  masterKeyHex: string,
  modPrivkeyHex: string,
  orgName: string,
): Promise<void> {
  const masterKey = new Uint8Array(Buffer.from(masterKeyHex, 'hex'));
  const modPrivkey = new Uint8Array(Buffer.from(modPrivkeyHex, 'hex'));

  await storeKeyEnvelope(orgId, 'master', masterKey);
  await storeKeyEnvelope(orgId, 'mod-privkey', modPrivkey);

  if (isVaultUnlocked()) {
    const entry: VaultEntry = {
      org_id: orgId,
      org_name: orgName,
      k_master_hex: masterKeyHex,
      recovery_phrase: generateRecoveryPhrase(masterKey),
      sk_mod_hex: modPrivkeyHex,
      current_epoch: 0,
      created_at: new Date().toISOString(),
      last_verified_at: null,
    };
    await addOrgToVault(entry).catch(() => {});
  }
}

export async function createOrg(params: CreateOrgParams): Promise<CreateOrgResult> {
  let setup: OrgCryptoSetup;
  try {
    setup = await buildOrgCryptoSetup(params);
  } catch (error) {
    return {
      orgId: '',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let response: Response;
  try {
    // Non-org-scoped route: org does not exist yet, so no org-scoped pubkey applies.
    response = await fetch(`${params.hubUrl}/v1/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(setup.payload),
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

  let responseBody: { org_id?: string };
  try {
    responseBody = await response.json() as { org_id?: string };
  } catch {
    return { orgId: '', status: 'error', error: 'create-org response missing JSON body' };
  }

  if (typeof responseBody.org_id !== 'string' || responseBody.org_id.length === 0) {
    return { orgId: '', status: 'error', error: 'create-org response missing org_id' };
  }

  const createdOrgId = responseBody.org_id;

  await persistOrgKeys(createdOrgId, setup.masterKeyHex, setup.modPrivkeyHex, params.orgName);

  return { orgId: createdOrgId, status: 'created' };
}

export async function provisionRecall(orgId: string): Promise<void> {
  await ensureCrypto();

  const masterKey = await loadKeyEnvelope(orgId, 'master');
  if (!masterKey) {
    throw new Error(`no master key found for org ${orgId} — only the org leader can provision recall`);
  }

  const currentEpoch = await fetchCurrentEpoch(HUB_URL, orgId);

  let epochSkHex: string;
  try {
    const epochSeed = epochUmbralSeed(masterKey, currentEpoch);
    ({ secretKeyHex: epochSkHex } = await umbralDeriveEpochKeypair(epochSeed.toString('hex')));
  } catch {
    throw new Error(`failed to derive epoch Umbral keypair locally for org ${orgId}`);
  }

  await getOrCreatePreIdentity();
  const prePubkeyHex = getPrePublicKeyHex();
  const kfragHex = await umbralGenerateKfrag(epochSkHex, prePubkeyHex);

  const identity = await loadIdentity();
  if (!identity) {
    throw new Error('no identity in keychain');
  }

  const edPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');

  const registerPrePubkeyResult = await registerPrePubkey(HUB_URL, orgId, edPubkeyHex, prePubkeyHex);
  if (!registerPrePubkeyResult.ok) {
    throw new Error(`failed to register PRE pubkey for recall provisioning: ${registerPrePubkeyResult.error ?? 'unknown'}`);
  }

  const { headers } = await buildWeVibeSignedAuth();
  const response = await hubFetchVerified(
    orgId,
    `${HUB_URL}/v1/orgs/${orgId}/members/${edPubkeyHex}/kfrag`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        epoch_id: currentEpoch,
        pre_pubkey: prePubkeyHex,
        kfrag: kfragHex,
      }),
    },
  );

  if (!response.res.ok) {
    throw new Error(`failed to provision recall kfrag: HTTP ${response.res.status}${response.bodyText ? ` — ${response.bodyText}` : ''}`);
  }
}

export interface InviteMemberParams {
  orgId: string;
  inviteePubkeyHex: string;
  inviteeX25519PubkeyHex: string;
  epochSkHex: string;
  prePubkeyHex: string;
  canContribute: boolean;
  canModerate: boolean;
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
  if (params.canModerate) {
    const skMod = await loadKeyEnvelope(params.orgId, 'mod-privkey');
    if (!skMod) {
      return { status: 'error', error: 'no mod private key found — leader local keychain may be missing SK_mod for this org' };
    }
    const sealedMod = sealToPubkey(skMod, inviteeX25519Pubkey);
    modEnvelopeB64 = Buffer.from(sealedMod).toString('base64');
  }

  let currentEpoch = 0;
  try {
    const orgResp = await hubFetchVerified(params.orgId, `${params.hubUrl}/v1/orgs/${params.orgId}`);
    if (orgResp.res.ok) {
      const orgInfo = orgResp.json<{ current_epoch?: number }>();
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
    'member', leaderPubkeyHex,
    encEnvelopeB64, searchEnvelopeB64, modEnvelopeB64,
    params.canContribute, params.canModerate,
  );
  const sig = sign(identity.edPrivkey, canonical);
  const sigHex = Buffer.from(sig).toString('hex');

  const payload: Record<string, unknown> = {
    pubkey: params.inviteePubkeyHex,
    x25519_pubkey: params.inviteeX25519PubkeyHex,
    pre_pubkey: params.prePubkeyHex,
    epoch_sk: params.epochSkHex,
    role: 'member',
    can_contribute: params.canContribute,
    can_moderate: params.canModerate,
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
    const verified = await hubFetchVerified(params.orgId, `${params.hubUrl}/v1/orgs/${params.orgId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    response = verified.res;
    if (!response.ok) {
      let errMsg: string;
      try {
        const errBody = verified.json<{ error?: string }>();
        errMsg = errBody.error ?? `HTTP ${response.status}`;
      } catch {
        errMsg = `HTTP ${response.status}`;
      }
      return { status: 'error', error: errMsg };
    }
  } catch (e) {
    return { status: 'error', error: `hub unavailable: ${e}` };
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
    const orgResp = await hubFetchVerified(params.orgId, `${params.hubUrl}/v1/orgs/${params.orgId}`);
    if (orgResp.res.ok) {
      const orgInfo = orgResp.json<{ current_epoch?: number }>();
      currentEpoch = orgInfo.current_epoch ?? 0;
    }
  } catch {
    return { status: 'error', error: 'hub unavailable' };
  }

  const newEpoch = currentEpoch + 1;
  const newEpochKeys = deriveEpochKeys(masterKey, newEpoch);

  const newModIdentity = generateIdentity();
  const newPkModHex = Buffer.from(newModIdentity.xPubkey).toString('hex');

  let activeMembers: Array<{ pubkey: string; x25519_pubkey: string; role: string; can_moderate?: boolean }> = [];
  try {
    const membersResp = await hubFetchVerified(params.orgId, `${params.hubUrl}/v1/orgs/${params.orgId}/members`);
    if (membersResp.res.ok) {
      const allMembers = membersResp.json<Array<{ pubkey: string; x25519_pubkey: string; role: string; can_moderate?: boolean; active: boolean }>>();
      activeMembers = allMembers
        .filter(m => m.active)
        .map(m => ({
          pubkey: m.pubkey,
          x25519_pubkey: m.x25519_pubkey,
          role: m.role,
          can_moderate: m.can_moderate,
        }));
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
    if (member.role === 'leader' || member.can_moderate) {
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
    const verified = await hubFetchVerified(params.orgId, `${params.hubUrl}/v1/orgs/${params.orgId}/epoch/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    response = verified.res;
    if (!response.ok) {
      let errMsg: string;
      try {
        const errBody = verified.json<{ error?: string }>();
        errMsg = errBody.error ?? `HTTP ${response.status}`;
      } catch {
        errMsg = `HTTP ${response.status}`;
      }
      return { status: 'error', error: errMsg };
    }

    let bufferedMoved = 0;
    let respBody: { buffered_moved?: number; epoch_sk?: string; epoch_pk?: string } = {};
    try {
      respBody = verified.json<{ buffered_moved?: number; epoch_sk?: string; epoch_pk?: string }>();
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
  } catch (e) {
    return { status: 'error', error: `hub unavailable: ${e}` };
  }
}

interface HubKeywordEntry {
  keyword: string;
  created_at: string;
  deprecated: boolean;
  usage_count: number;
}

interface HubKeywordCandidate {
  keyword: string;
  distinct_contributors: number;
  distinct_occasions: number;
  commonly_suggested: boolean;
}

export interface OrgInfo {
  org_name?: string;
  domain?: string;
  description?: string;
  tech_stack?: string;
  focus_areas?: string;
}

export async function getOrgInfo(hubUrl: string, orgId: string): Promise<OrgInfo | null> {
  try {
    const { headers } = await buildWeVibeSignedAuth();
    const response = await hubFetchVerified(orgId, `${hubUrl}/v1/orgs/${orgId}`, { headers });

    if (!response.res.ok) {
      return null;
    }

    return response.json<OrgInfo>();
  } catch {
    return null;
  }
}

export async function getOrgKeywords(hubUrl: string, orgId: string): Promise<string[]> {
  const { headers } = await buildWeVibeSignedAuth();

  const response = await hubFetchVerified(orgId, `${hubUrl}/v1/orgs/${orgId}/keywords`, { headers });

  if (!response.res.ok) {
    throw new Error(`failed to fetch org keywords (${response.res.status})${response.bodyText ? `: ${response.bodyText}` : ''}`);
  }

  const entries = response.json<HubKeywordEntry[]>();

  return entries
    .filter(e => !e.deprecated)
    .map(e => e.keyword);
}

export async function getOrgKeywordCandidates(hubUrl: string, orgId: string, limit: number): Promise<string[]> {
  const { headers } = await buildWeVibeSignedAuth();

  const response = await hubFetchVerified(orgId, `${hubUrl}/v1/orgs/${orgId}/keywords/candidates`, { headers });

  if (!response.res.ok) {
    throw new Error(`failed to fetch org keyword candidates (${response.res.status})${response.bodyText ? `: ${response.bodyText}` : ''}`);
  }

  const entries = response.json<HubKeywordCandidate[]>();

  return entries
    .slice(0, limit)
    .map(entry => entry.keyword);
}
