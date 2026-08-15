process.env.WEVIBE_KEYSTORE_TEST = '1';
process.env.WEVIBE_RECALL_MODE = 'test';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deserializeMemoryResult } from '../src/deserialize.js';
import type { Output } from '../src/retrieve-cli.js';
import {
  encryptSymmetric,
  generateDek,
  generateIdentity,
  sealToPubkey,
} from '../src/crypto.js';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);

const HUB_URL = 'https://hub.test.example';
const ORG_ID = 'org-1';
const LEADER_PLAINTEXT = 'the leader owns this memory about redis config';

// Fixed deterministic 32-byte identity seed (test-only material, not a secret).
const LEADER_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256);

type LeaderIdentity = {
  edPrivkey: Uint8Array;
  edPubkey: Uint8Array;
  xPrivkey: Uint8Array;
  xPubkey: Uint8Array;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Hub-shaped query result exactly as the hub emits it (wevibe-hub
// internal/api/handlers/retrieval.go): all wire fields present, PRE fields hex.
function goodResult(cid: string): Record<string, unknown> {
  return {
    cid,
    org_id: ORG_ID,
    epoch_id: 0,
    memory_type: 'memory',
    capsule: 'aa11'.repeat(16),
    cfrag: 'bb22'.repeat(16),
    umbral_ciphertext: 'cc33'.repeat(16),
    content_flags: [],
    freshness_score: 0.9,
    retrieval_count: 1,
    acceptance_count: 1,
    keywords: [],
    matched_keywords: [],
    contributor_stats: {
      account_age_days: 1,
      contributions: 1,
      serve_count: 0,
      reports_upheld: 0,
      false_reports_against: 0,
    },
    scoring_breakdown: {
      keyword_score: 0.45,
      vector_score: 0.45,
      gamma: 0,
      delta: 0,
      capped_boost: 0,
      combined_score: 0.9,
      keyword_matches: [],
      unmatched_query_keywords: [],
    },
  };
}

// The hub emits undecryptable results INLINE with EMPTY capsule/cfrag/
// umbral_ciphertext when umbral re-encryption fails (retrieval.go:382-396).
function undecryptableResult(cid: string): Record<string, unknown> {
  return { ...goodResult(cid), capsule: '', cfrag: '', umbral_ciphertext: '' };
}

interface HubRouterOpts {
  modEnvelopeB64: string;
  modPubkeyHex: string;
  queryResults: Array<Record<string, unknown>>;
  ciphertextHex: string;
}

// URL-routing fetch stub (substring match, ordered). Anything unmatched is a 404.
function hubRouter(opts: HubRouterOpts): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, _init) => {
    const url = String(input);

    // 1. serving-address: raw fetch (getHubResponsePubkey, org-client.ts:278-298).
    if (url.includes('/v1/hub/serving-address')) {
      return jsonResponse({ response_pubkey: '00', serving_address: 'wevibe1abc' });
    }

    // 2. member orgs list (loadMemberships, org-client.ts:330-334).
    if (url.includes('/v1/members/') && url.endsWith('/orgs')) {
      return jsonResponse({
        orgs: [{
          org_id: ORG_ID,
          org_name: 'Test Org',
          role: 'leader',
          can_contribute: true,
          can_moderate: true,
          current_epoch: 0,
          history_access_from_epoch: 0,
          egress_mode: 'unrestricted',
          allowed_providers: [],
          mod_pubkey: opts.modPubkeyHex,
        }],
      });
    }

    // 3. key envelopes (fetchKeyEnvelope, org-client.ts:252-270). mod_envelope is
    //    REAL: sealToPubkey(modPrivkey, leader.xPubkey) — loadMemberships opens it
    //    with the real openEnvelope for the leader role.
    if (url.includes(`/v1/orgs/${ORG_ID}/keys/envelope`)) {
      return jsonResponse({ enc_envelope: '', search_envelope: '', mod_envelope: opts.modEnvelopeB64 });
    }

    // 4. org vocabulary (getOrgKeywords, org-client.ts:1235-1249). Wire shape is a
    //    bare JSON array of keyword entries — return the empty vocabulary.
    if (url.includes(`/v1/orgs/${ORG_ID}/keywords`)) {
      return jsonResponse([]);
    }

    // 5. recall query (queryOrgMemories, org-client.ts:126-178).
    if (url.includes(`/v1/orgs/${ORG_ID}/query`)) {
      return jsonResponse({ results: opts.queryResults, contested: false });
    }

    // 6. GetMemory ciphertext (retrieve-cli.ts:432-437) — served for EVERY cid in the
    //    results so the undecryptable sibling fails on the empty-PRE guard itself, not
    //    earlier on a missing ciphertext.
    if (url.includes(`/v1/orgs/${ORG_ID}/memories/`)) {
      return jsonResponse({ ciphertext_hex: opts.ciphertextHex });
    }

    // 7. epoch umbral manifest (fetchEpochManifest, org-client.ts:447-465).
    if (url.includes(`/v1/orgs/${ORG_ID}/epoch/0/manifest`)) {
      return jsonResponse({ umbral_pk: 'aabbccdd' });
    }

    return jsonResponse({ error: `unmatched test route: ${url}` }, 404);
  };
}

// Registers every seam mock EXCEPT the modules under test (org-client, deserialize,
// key-store, crypto stay REAL), then runs the real retrieve() and returns its output.
async function runLeaderRecall(queryResults: Array<Record<string, unknown>>): Promise<Output> {
  vi.resetModules();

  // Logger first: the REAL key-store (imported next through the post-reset registry)
  // depends on it, and logOp must be a no-op so no per-op log files are written (R-13).
  // Keep the real `fp` — org-client and key-store import it.
  vi.doMock('../src/logger.js', async () => {
    const actual = await vi.importActual<typeof import('../src/logger.js')>('../src/logger.js');
    return {
      ...actual,
      logOp: vi.fn(),
      newTraceId: vi.fn().mockReturnValue('trace-test'),
    };
  });

  // REAL key-store, dynamically imported AFTER resetModules so this instance is the
  // SAME one the real org-client resolves — testStoreMap/identity state is per-instance,
  // and the leader recall invariant runs against the real in-memory test store.
  const keyStore = await import('../src/key-store.js');
  keyStore.clearTestStore();
  await keyStore.storeIdentitySeed(LEADER_SEED);
  const identity = await keyStore.loadIdentity();
  if (!identity) {
    throw new Error('leader-recall-invariant test setup: loadIdentity() returned null');
  }
  const leader = identity as LeaderIdentity;
  const edPubkeyHex = Buffer.from(leader.edPubkey).toString('hex');

  // REAL mod identity + REAL envelope sealing: loadMemberships opens mod_envelope with
  // the real openEnvelope(leader.xPrivkey) because role=leader.
  const modIdentity = generateIdentity();
  const modEnvelopeB64 = Buffer.from(
    sealToPubkey(modIdentity.xPrivkey, leader.xPubkey),
  ).toString('base64');
  const modPubkeyHex = Buffer.from(modIdentity.xPubkey).toString('hex');

  // REAL memory encryption: DEK + AES ciphertext. The mocked umbral layer returns
  // dekHex, and the real decryptSymmetric must recover LEADER_PLAINTEXT.
  const dek = generateDek();
  const dekHex = Buffer.from(dek).toString('hex');
  const ciphertextHex = Buffer.from(
    encryptSymmetric(new TextEncoder().encode(LEADER_PLAINTEXT), dek),
  ).toString('hex');

  // Pass-through hub fetch: no signature machinery, plain fetch + text + json(),
  // same factory shape as org-client.test.ts:53-80 / rotation.test.ts:56-83.
  vi.doMock('../src/hub-fetch.js', async () => {
    const actual = await vi.importActual<typeof import('../src/hub-fetch.js')>('../src/hub-fetch.js');
    const passthrough = async (_subject: string, url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      const bodyText = await res.text();
      return {
        res,
        bodyText,
        json<T>(): T {
          return bodyText ? JSON.parse(bodyText) as T : ({} as T);
        },
      };
    };
    return {
      ...actual,
      hubFetchVerified: vi.fn(passthrough),
      hubFetchVerifiedWithKey: vi.fn(passthrough),
    };
  });

  vi.doMock('../src/umbral.js', () => ({
    umbralDecryptReencrypted: vi.fn().mockResolvedValue(dekHex),
    umbralDeriveEpochKeypair: vi.fn(),
    umbralGenerateKfrag: vi.fn(),
    umbralEncrypt: vi.fn(),
  }));

  vi.doMock('../src/auth.js', () => ({
    // loadMemberships destructures pubkeyHex for the member-orgs URL (org-client.ts:325).
    buildWeVibeSignedAuth: vi.fn().mockResolvedValue({ pubkeyHex: edPubkeyHex, headers: {} }),
    getOrCreatePreIdentity: vi.fn().mockResolvedValue(undefined),
    getPreSecretKeyHex: vi.fn().mockReturnValue('01'.repeat(32)),
    getPrePublicKeyHex: vi.fn().mockReturnValue('02'.repeat(33)),
  }));

  // Mocking ensureIdentity skips the PRE-registration side-effects; retrieve proceeds
  // into the REAL loadMemberships next.
  vi.doMock('../src/identity-runtime.js', () => ({
    ensureIdentity: vi.fn().mockResolvedValue(leader),
  }));

  vi.doMock('../src/vault.js', () => ({
    isVaultUnlocked: vi.fn().mockReturnValue(false),
    updateVaultEntry: vi.fn(),
    addOrgToVault: vi.fn(),
    getVaultCache: vi.fn().mockReturnValue(null),
  }));

  vi.doMock('../src/session.js', () => ({
    dissect_to_keywords: vi.fn().mockReturnValue([]),
  }));

  vi.doMock('../src/mc1/keywords.js', () => ({
    boostKeywordsByVocab: vi.fn().mockImplementation((keywords: Array<{ term: string; weight: number }>) => keywords),
  }));

  vi.doMock('../src/embedding.js', () => ({
    computeLocalEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    EXPECTED_EMBEDDING_DIM: 768,
  }));

  vi.doMock('../src/embedding-config.js', () => ({
    loadEmbeddingConfig: vi.fn().mockReturnValue({
      baseUrl: 'https://embed.test.example',
      apiKey: 'test',
      model: 'test-embed',
      usePrefix: false,
    }),
  }));

  vi.doMock('../src/retrieval-card.js', () => ({
    buildNeedCard: vi.fn().mockReturnValue('need-card'),
    buildPromptDigest: vi.fn().mockReturnValue('prompt-digest'),
  }));

  vi.doMock('../src/query-scrub.js', () => ({
    scrubQueryHarvestInput: vi.fn().mockImplementation((input: unknown) => input),
  }));

  vi.doMock('../src/artifact-extract.js', () => ({
    extractArtifacts: vi.fn().mockReturnValue({
      artifacts: [],
      summary: {
        url: 0,
        domain: 0,
        ip_address: 0,
        shell_command: 0,
        package_install: 0,
        config_directive: 0,
        credential_like: 0,
      },
    }),
  }));

  vi.doMock('../src/artifact-policy.js', () => ({
    checkArtifactPolicy: vi.fn().mockReturnValue([]),
  }));

  vi.doMock('../src/artifact-transform.js', () => ({
    transformMemoryContent: vi.fn().mockImplementation((text: string) => ({
      text,
      annotations: [],
      redactedCount: 0,
      annotatedCount: 0,
    })),
  }));

  vi.doMock('../src/trust-panel.js', () => ({
    formatTrustPanel: vi.fn().mockReturnValue(''),
  }));

  vi.doMock('../src/config.js', () => ({
    HUB_URL,
    EMBEDDING_MODEL: 'test-embedding-model',
  }));

  vi.doMock('../src/hub-resolver.js', () => ({
    getActiveHubUrlForOrg: vi.fn().mockReturnValue(null),
    pickActiveEndpoint: vi.fn().mockImplementation((endpoints: string[]) => endpoints[0]),
  }));

  vi.doMock('../src/identity-sidecar.js', () => ({
    getOrgHubState: vi.fn().mockReturnValue(null),
    setOrgHubState: vi.fn(),
  }));

  mockFetch.mockReset();
  mockFetch.mockImplementation(hubRouter({ modEnvelopeB64, modPubkeyHex, queryResults, ciphertextHex }));

  const { retrieve } = await import('../src/retrieve-cli.js');
  return retrieve({
    query: 'redis config',
    org_id: ORG_ID,
    technologies: ['redis'],
    recentActivity: [],
  });
}

describe('D1 leader-recall invariant (DECISIONS.md §28)', () => {
  describe('deserializeMemoryResult leniency — WO-INV1-I1 regression guard', () => {
    // The hub OMITs capsule/cfrag/umbral_ciphertext keys entirely when emitting an
    // undecryptable result, so the raw object reaching deserialize has NO such keys.
    // The cast mirrors the real seam (retrieve-cli.ts:408) — this must NOT throw,
    // it must pass the empty PRE fields through to the per-memory decrypt guard.
    it('passes ABSENT capsule/cfrag/umbral_ciphertext through as empty strings', () => {
      const raw = { cid: 'c1', org_id: 'org-1', epoch_id: 0, memory_type: 'memory' };

      const result = deserializeMemoryResult(raw as unknown as Parameters<typeof deserializeMemoryResult>[0]);

      expect(result.cid).toBe('c1');
      expect(result.orgId).toBe('org-1');
      expect(result.epochId).toBe(0);
      expect(result.memoryType).toBe('memory');
      expect(result.capsule).toBe('');
      expect(result.cfrag).toBe('');
      expect(result.umbralCiphertext).toBe('');
    });

    it('still throws on an invalid memory_type', () => {
      const raw = { cid: 'c2', org_id: 'org-1', epoch_id: 0, memory_type: 'note' };

      expect(() =>
        deserializeMemoryResult(raw as unknown as Parameters<typeof deserializeMemoryResult>[0]),
      ).toThrow('memory result missing or invalid memory_type');
    });
  });

  describe('retrieve — leader recalls its own org memories', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('THE LEADER RECALLS ITS OWN ORG MEMORY AS PLAINTEXT (not ciphertext, not empty)', async () => {
      const goodCid = 'cid-leader-own';

      const result = await runLeaderRecall([goodResult(goodCid)]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(`expected retrieve status=ok, got error=${'error' in result ? result.error : 'unknown'}`);
      }
      // No decrypt_failed / no_membership / filtered reason — a clean leader recall.
      expect(result.reason_code).toBeUndefined();
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].cid).toBe(goodCid);
      // REAL crypto end-to-end: the surfaced text is exactly the leader's plaintext —
      // equality with the plaintext also proves it is NOT ciphertext-like.
      expect(result.memories[0].text).toBe(LEADER_PLAINTEXT);
      expect(result.org_allowed_providers).toEqual([]);
    });

    it('an UNDECRYPTABLE sibling does NOT abort the leader recall — the good memory still surfaces', async () => {
      const goodCid = 'cid-leader-own-survivor';
      const badCid = 'cid-undecryptable-sibling';

      const result = await runLeaderRecall([goodResult(goodCid), undecryptableResult(badCid)]);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        throw new Error(`expected retrieve status=ok, got error=${'error' in result ? result.error : 'unknown'}`);
      }
      // The good sibling decrypted: NOT an error, NOT empty, NOT decrypt_failed.
      expect(result.reason_code).toBeUndefined();
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].cid).toBe(goodCid);
      expect(result.memories[0].text).toBe(LEADER_PLAINTEXT);
    });
  });
});
