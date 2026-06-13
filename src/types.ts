export interface Keyword {
  term: string;
  weight: number;
}

export interface RetrievedKeyword {
  keyword: string;
  weight: number;
}

export interface SessionContext {
  projectName: string;
  technologies: string[];
  recentActivity: string[];
  directory: string;
  description: string;
}

export interface ProjectManifest {
  type: 'npm' | 'python' | 'rust' | 'go' | 'unknown';
  name: string | null;
  version: string | null;
  dependencies: string[];
  devDependencies: string[];
  rawPath: string;
}

export interface KeywordMatchDetail {
  keyword: string;
  query_weight: number;
  memory_weight: number;
  product: number;
}

export interface ScoringBreakdown {
  keyword_score: number;
  vector_score: number;
  gamma: number;
  delta: number;
  capped_boost: number;
  combined_score: number;
  keyword_matches: KeywordMatchDetail[];
  unmatched_query_keywords: string[];
}

export interface MemoryResult {
  cid: string;
  orgId: string;
  epochId: number;
  memoryType: MemoryType;
  capsule: string;
  cfrag: string;
  umbralCiphertext: string;
  contentFlags: ContentFlag[];
  freshnessScore: number;
  retrievalCount: number;
  acceptanceCount: number;
  keywords: RetrievedKeyword[];
  contributorStats?: {
    account_age_days: number;
    contributions: number;
    serve_count: number;
    reports_upheld: number;
    false_reports_against: number;
  };
  breakdown?: ScoringBreakdown;
  matchedKeywords?: string[];
}

export interface OrgMembership {
  orgId: string;
  orgName: string;
  role: 'leader' | 'member';
  canContribute: boolean;
  canModerate: boolean;
  currentEpoch: number;
  historyAccessFromEpoch: number;
  egressMode: 'local_only' | 'allowlist' | 'unrestricted';
  allowedProviders: string[];
  encKeys: Map<number, Uint8Array>;
  searchKeys: Map<number, Uint8Array>;
  modPubkey: Uint8Array | null;
  modPrivkey: Uint8Array | null;
}

export interface BlacklistEntry {
  cid: string;
  reason: string;
  addedAt: string;
}

export type ContentFlag =
  | 'url'
  | 'package_install'
  | 'endpoint'
  | 'config'
  | 'connection_string';

export type MemoryType = 'memory';

export interface BufferData {
  session_id: string;
  org_id: string;
  epoch_id: number;
  task_description: string;
  approach_notes: string[];
  errors_encountered: string[];
  stack: string[];
  created_at: string;
  updated_at: string;
  contributed: boolean;
  wallet?: string;
  project_name?: string;
  started_at?: string;
  technologies?: string[];
  task_descriptions?: string[];
  recall_queries?: string[];
  tool_calls?: Array<{ summary?: string; tool?: string }>;
  directory?: string;
}

export type ProvenanceTier = 'commitllm' | 'proxy-attested' | 'unattested' | `custom:${string}`;

export interface AttestationMetadata {
  provenance: ProvenanceTier;
  attestor_signature: string;
  attestation_timestamp: string;
  model_identity: string;
  session_hash: string;
  difficulty_grade?: number;
  quality_grade?: number;
  domain_tags: string[];
  challenge_params: {
    audit_tier: 'full' | 'sampled';
    tokens_challenged: number;
    total_tokens: number;
  };
}

export interface MemorySubmission {
  raw_notes: string;
  org_id: string;
  epoch_id: number;
  memory_type?: MemoryType;
  stack_hint?: string[];
  attestation?: AttestationMetadata;
}
