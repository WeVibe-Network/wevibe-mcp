import { initCrypto } from './crypto.js';
import { loadIdentity } from './key-store.js';
import { loadMemberships, queryOrgMemories, decryptMemoryBlob } from './org-client.js';
import { dissect_to_keywords } from './session.js';
import { computeLocalEmbedding } from './embedding.js';
import { buildNeedCard, type NeedHarvest } from './retrieval-card.js';
import { deserializeMemoryResult } from './deserialize.js';
import { ocrSanitize } from './ocr-sanitize.js';
import { extractArtifacts } from './artifact-extract.js';
import { checkArtifactPolicy } from './artifact-policy.js';
import { transformMemoryContent } from './artifact-transform.js';
import { formatTrustPanel, type MemoryStats, type ContributorStats } from './trust-panel.js';
import { is_blacklisted } from './blacklist.js';
import { buildWeVibeSignedAuth } from './auth.js';
import { HUB_URL, EMBEDDING_MODEL } from './config.js';
import { getActiveHubUrlForOrg, pickActiveEndpoint } from './hub-resolver.js';
import { getOrgHubState, setOrgHubState } from './identity-sidecar.js';
import { HubSignatureError, hubFetchVerified } from './hub-fetch.js';

export interface RetrieveInput {
  query: string;
  limit?: number;
  org_id?: string;
  intent?: string;
  task?: string;
  description?: string;
  language?: string;
  stack?: string[];
  technologies?: string[];
  frameworks?: string[];
  deps?: string[];
  errorStrings?: string[];
  recentActivity?: string[];
  files?: string[];
  directory?: string;
  projectName?: string;
}

export interface MemoryOutput {
  cid: string;
  epoch_id: number;
  memory_type: string;
  score: number;
  keywords: Array<{ keyword: string; weight: number }>;
  matched_keywords: string[];
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

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized: string[] = [];
  for (const entry of values) {
    const value = nonEmptyString(entry);
    if (!value) {
      continue;
    }
    normalized.push(value);
  }
  return normalized;
}

function mergeDistinctStrings(...valueSets: unknown[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const valueSet of valueSets) {
    for (const value of normalizeStringArray(valueSet)) {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(value);
    }
  }

  return merged;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function optionalArray(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

function buildKeywordDescription(input: RetrieveInput, stack: string[]): string {
  const parts: string[] = [];
  const query = nonEmptyString(input.query);
  if (query) {
    parts.push(query);
  }

  const description = nonEmptyString(input.description);
  if (description && description !== query) {
    parts.push(description);
  }

  if (stack.length > 0) {
    parts.push(stack.join(' '));
  }

  return parts.join(' ').trim();
}

export function buildQueryHarvest(input: RetrieveInput): NeedHarvest {
  const stack = mergeDistinctStrings(input.stack, input.technologies);
  const frameworks = normalizeStringArray(input.frameworks);
  const deps = normalizeStringArray(input.deps);
  const errorStrings = mergeDistinctStrings(input.errorStrings, input.recentActivity);
  const files = normalizeStringArray(input.files);

  return {
    intent: nonEmptyString(input.intent),
    task: firstNonEmptyString(input.task, input.description, input.query),
    language: nonEmptyString(input.language),
    stack: optionalArray(stack),
    frameworks: optionalArray(frameworks),
    deps: optionalArray(deps),
    errorStrings: optionalArray(errorStrings),
    files: optionalArray(files),
  };
}

async function failoverAfterSignatureFailure(orgId: string, failedHubUrl: string): Promise<string | null> {
  const state = getOrgHubState(orgId);
  const endpoints = state?.hubEndpoints ?? [];
  if (endpoints.length === 0) {
    return null;
  }

  const failed = normalizeEndpoint(failedHubUrl);
  const next = await pickActiveEndpoint(endpoints, {
    skipEndpoint: (endpoint) => normalizeEndpoint(endpoint) === failed,
  });

  if (!next) {
    return null;
  }

  setOrgHubState(orgId, {
    activeHubEndpoint: next,
    updatedAt: new Date().toISOString(),
  });

  return next;
}

async function runWithHubSignatureFailover<T>(
  orgId: string,
  hubUrl: string,
  context: string,
  op: (hubUrl: string) => Promise<T>,
): Promise<{ hubUrl: string; result: T }> {
  try {
    const result = await op(hubUrl);
    return { hubUrl, result };
  } catch (error) {
    if (!(error instanceof HubSignatureError)) {
      throw error;
    }

    const nextHubUrl = await failoverAfterSignatureFailure(orgId, hubUrl);
    if (!nextHubUrl) {
      throw new Error(`${context}: hub response signature verification failed and no failover endpoint is available`);
    }

    try {
      const result = await op(nextHubUrl);
      return { hubUrl: nextHubUrl, result };
    } catch (retryError) {
      if (retryError instanceof HubSignatureError) {
        throw new Error(`${context}: hub response signature verification failed on failover endpoint ${nextHubUrl}`);
      }
      throw retryError;
    }
  }
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

  let activeHubUrl = getActiveHubUrlForOrg(membership.orgId) ?? HUB_URL;

  const harvest = buildQueryHarvest(input);
  const needCardText = buildNeedCard(harvest);
  const stackSignals = harvest.stack ?? [];
  const recentActivitySignals = harvest.errorStrings ?? [];
  const keywordDescription = buildKeywordDescription(input, stackSignals);

  const keywords = dissect_to_keywords({
    description: keywordDescription,
    technologies: stackSignals,
    recentActivity: recentActivitySignals,
    directory: nonEmptyString(input.directory) ?? '',
    projectName: nonEmptyString(input.projectName) ?? '',
  });

  if (keywords.length === 0) {
    return { status: 'error', error: `no keywords extracted for "${input.query}"` };
  }

  let queryVector: number[];
  try {
    queryVector = await computeLocalEmbedding(needCardText, { role: 'query', prefix: true });
  } catch (e) {
    return { status: 'error', error: `embedding failed: ${e}` };
  }

  let rawMemories: ReturnType<typeof deserializeMemoryResult>[] = [];
  try {
    const queryResult = await runWithHubSignatureFailover(
      membership.orgId,
      activeHubUrl,
      'hub query failed',
      (hubUrl) => queryOrgMemories({
        hubUrl,
        orgId: membership.orgId,
        agentPubkey: uint8ArrayToHex(identity.edPubkey),
        keywordWeights: keywords.map(kw => ({ keyword: kw.term, weight: kw.weight })),
        vector: queryVector,
        embeddingModelId: EMBEDDING_MODEL,
        limit: input.limit ?? 5,
        agentSig: 'stub',
      }),
    );

    activeHubUrl = queryResult.hubUrl;
    const data = queryResult.result;

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
      const ciphertextResult = await runWithHubSignatureFailover(
        membership.orgId,
        activeHubUrl,
        `hub ciphertext fetch failed for memory ${m.cid}`,
        (hubUrl) => hubFetchVerified(
          membership.orgId,
          `${hubUrl}/v1/orgs/${membership.orgId}/memories/${m.cid}`,
          { headers: authHeaders },
        ),
      );

      activeHubUrl = ciphertextResult.hubUrl;
      if (!ciphertextResult.result.res.ok) continue;

      const ctData = ciphertextResult.result.json<{ ciphertext_hex: string }>();
      const ciphertextBytes = new Uint8Array(Buffer.from(ctData.ciphertext_hex, 'hex'));

      const plaintextResult = await runWithHubSignatureFailover(
        membership.orgId,
        activeHubUrl,
        `hub decrypt failed for memory ${m.cid}`,
        (hubUrl) => decryptMemoryBlob(
          m.cid,
          m.capsule,
          m.cfrag,
          m.umbralCiphertext,
          ciphertextBytes,
          membership,
          m.epochId,
          hubUrl,
        ),
      );

      activeHubUrl = plaintextResult.hubUrl;
      const plaintext = Buffer.from(plaintextResult.result).toString('utf-8');

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
        matched_keywords: m.matchedKeywords ?? [],
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
