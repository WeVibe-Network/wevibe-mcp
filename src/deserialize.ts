import type { MemoryResult, ContentFlag } from './types.js';
import type { MemoryType } from './types.js';

interface RawMemoryResult {
  cid: string;
  org_id: string;
  epoch_id: number;
  memory_type: string;
  capsule: string;
  cfrag: string;
  umbral_ciphertext: string;
  content_flags: string[];
  freshness_score: number;
  retrieval_count: number;
  acceptance_count: number;
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

function requireStringField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`memory result missing ${fieldName}`);
  }
  return value;
}

function requireMemoryType(value: unknown): MemoryType {
	if (value === 'memory') {
		return value;
	}
	throw new Error('memory result missing or invalid memory_type');
}

export function deserializeMemoryResult(raw: RawMemoryResult): MemoryResult {
  return {
    cid: raw.cid,
    orgId: raw.org_id,
    epochId: raw.epoch_id,
    memoryType: requireMemoryType(raw.memory_type),
    capsule: requireStringField(raw.capsule, 'capsule'),
    cfrag: requireStringField(raw.cfrag, 'cfrag'),
    umbralCiphertext: requireStringField(raw.umbral_ciphertext, 'umbral_ciphertext'),
    contentFlags: (raw.content_flags ?? []) as ContentFlag[],
    freshnessScore: raw.freshness_score ?? 0,
    retrievalCount: raw.retrieval_count ?? 0,
    acceptanceCount: raw.acceptance_count ?? 0,
    keywords: (raw.keywords ?? []).map(kw => ({
      keyword: kw.keyword,
      weight: kw.weight,
    })),
    matchedKeywords: raw.matched_keywords ?? [],
    contributorStats: raw.contributor_stats,
    breakdown: raw.scoring_breakdown,
  };
}
