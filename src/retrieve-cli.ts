import { initCrypto } from './crypto.js';
import { loadIdentity } from './key-store.js';
import { loadMemberships, queryOrgMemories, decryptMemoryBlob } from './org-client.js';
import { dissect_to_keywords } from './session.js';
import { computeLocalEmbedding } from './embedding.js';
import { deserializeMemoryResult } from './deserialize.js';
import { ocrSanitize } from './ocr-sanitize.js';
import { extractArtifacts } from './artifact-extract.js';
import { checkArtifactPolicy } from './artifact-policy.js';
import { transformMemoryContent } from './artifact-transform.js';
import { formatTrustPanel, type MemoryStats, type ContributorStats } from './trust-panel.js';
import { is_blacklisted } from './blacklist.js';
import { buildWeVibeSignedAuth } from './auth.js';
import { HUB_URL, EMBEDDING_MODEL } from './config.js';

export interface RetrieveInput {
  query: string;
  limit?: number;
  org_id?: string;
}

export interface MemoryOutput {
  cid: string;
  epoch_id: number;
  memory_type: string;
  score: number;
  keywords: Array<{ keyword: string; weight: number }>;
  text: string;
  redacted_count: number;
  annotations: string[];
  breakdown?: Record<string, unknown>;
  memory_stats: MemoryStats;
  contributor_stats: ContributorStats;
  trust_panel: string;
}

export interface RetrieveOutput {
  status: 'ok';
  memories: MemoryOutput[];
  org_allowed_providers: string[];
}

export interface ErrorOutput {
  status: 'error';
  error: string;
}

export type Output = RetrieveOutput | ErrorOutput;

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function retrieve(input: RetrieveInput): Promise<Output> {
  await initCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    return { status: 'error', error: 'no identity found in keychain' };
  }

  let memberships: Awaited<ReturnType<typeof loadMemberships>>;
  try {
    memberships = await loadMemberships(HUB_URL);
  } catch (e) {
    return { status: 'error', error: `failed to load org memberships: ${e}` };
  }

  if (memberships.length === 0) {
    return { status: 'error', error: 'no org membership found' };
  }

  const membership = input.org_id
    ? memberships.find(m => m.orgId === input.org_id)
    : memberships[0];

  if (!membership) {
    return { status: 'error', error: `org ${input.org_id} not found in memberships` };
  }

  const keywords = dissect_to_keywords({
    description: input.query,
    technologies: [],
    recentActivity: [],
    directory: '',
    projectName: '',
  });

  if (keywords.length === 0) {
    return { status: 'error', error: `no keywords extracted for "${input.query}"` };
  }

  let queryVector: number[];
  try {
    queryVector = await computeLocalEmbedding(input.query);
  } catch (e) {
    return { status: 'error', error: `embedding failed: ${e}` };
  }

  let rawMemories: ReturnType<typeof deserializeMemoryResult>[] = [];
  try {
    const data = await queryOrgMemories({
      hubUrl: HUB_URL,
      orgId: membership.orgId,
      agentPubkey: uint8ArrayToHex(identity.edPubkey),
      keywordWeights: keywords.map(kw => ({ keyword: kw.term, weight: kw.weight })),
      vector: queryVector,
      embeddingModelId: EMBEDDING_MODEL,
      limit: input.limit ?? 5,
      agentSig: 'stub',
    });

    if (data.results) {
      for (const r of data.results) {
        rawMemories.push(deserializeMemoryResult(r as unknown as Parameters<typeof deserializeMemoryResult>[0]));
      }
    }
  } catch (e) {
    return { status: 'error', error: `hub query failed: ${e}` };
  }

  const memories: MemoryOutput[] = [];
  const { headers: authHeaders } = await buildWeVibeSignedAuth();

  for (const m of rawMemories) {
    try {
      const ctResp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/memories/${m.cid}`, {
        headers: authHeaders,
      });
      if (!ctResp.ok) continue;
      const ctData = await ctResp.json() as { ciphertext_hex: string };
      const ciphertextBytes = new Uint8Array(Buffer.from(ctData.ciphertext_hex, 'hex'));

      const plaintextBytes = await decryptMemoryBlob(
        m.cid,
        m.capsule,
        m.cfrag,
        m.umbralCiphertext,
        ciphertextBytes,
        membership,
        m.epochId,
        HUB_URL,
      );
      const plaintext = Buffer.from(plaintextBytes).toString('utf-8');

      let sanitizedPlaintext: string;
      try {
        sanitizedPlaintext = ocrSanitize(plaintext);
      } catch {
        sanitizedPlaintext = plaintext;
      }

      const extraction = extractArtifacts(sanitizedPlaintext);
      const policyResults = checkArtifactPolicy(
        extraction.artifacts,
        membership.egressMode,
        membership.allowedProviders,
      );
      const transformed = transformMemoryContent(sanitizedPlaintext, policyResults);

      const memoryStats: MemoryStats = {
          retrieval_count: m.retrievalCount ?? 0,
          acceptance_count: m.acceptanceCount ?? 0,
        };
        const contributorStats: ContributorStats = m.contributorStats ?? {
          account_age_days: 0,
          contributions: 0,
          serve_count: 0,
          reports_upheld: 0,
          false_reports_against: 0,
        };
        const trustPanelText = formatTrustPanel({
          content: transformed.text,
          memory_stats: memoryStats,
          contributor_stats: contributorStats,
        });

      memories.push({
        cid: m.cid,
        epoch_id: m.epochId,
        memory_type: m.memoryType,
        score: m.freshnessScore,
        keywords: m.keywords,
        text: transformed.text,
        redacted_count: transformed.redactedCount,
        annotations: transformed.annotations,
        breakdown: m.breakdown as unknown as Record<string, unknown> | undefined,
        memory_stats: memoryStats,
        contributor_stats: contributorStats,
        trust_panel: trustPanelText,
      });
    } catch {
      continue;
    }
  }

  const preFilterCount = memories.length;
  const filteredMemories = memories.filter(m => {
    const packId = (m as { pack_id?: string }).pack_id;
    return !packId || !is_blacklisted(packId);
  });
  if (preFilterCount > filteredMemories.length) {
    console.error(`[wevibe-blacklist] Filtered ${preFilterCount - filteredMemories.length} blacklisted memories`);
  }

  return { status: 'ok', memories: filteredMemories, org_allowed_providers: membership.allowedProviders };
}
