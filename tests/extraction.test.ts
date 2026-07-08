import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  annotateNearDuplicates,
  cosineSimilarity,
  extractMemories,
  computeEmbedding,
  dedupeOverlapCandidatesByExtractionHash,
  extractKeywords,
  NEAR_DUP_COSINE_THRESHOLD,
  planChunkSlices,
  runBounded,
} from '../src/extraction.js';
import { computeLocalEmbedding } from '../src/embedding.js';
import type { MemoryCandidate } from '../src/extraction.js';
import type { LlmChatOptions, LlmProvider } from '../src/llm.js';

vi.mock('../src/embedding.js', () => ({
  computeLocalEmbedding: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
}));

vi.mock('../src/embedding-config.js', () => ({
  loadEmbeddingConfig: vi.fn().mockReturnValue({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    model: 'text-embedding-3-large',
    usePrefix: false,
  }),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/key-store.js', () => ({
  getStore: vi.fn().mockReturnValue({
    async getPassword(_service: string, _account: string): Promise<string | null> {
      return null;
    },
    async setPassword(_service: string, _account: string, _value: string): Promise<void> {},
    async deletePassword(_service: string, _account: string): Promise<boolean> {
      return true;
    },
  }),
}));

function createMockLlmProvider(
  chatFn: (sys: string, user: string, options?: LlmChatOptions) => string | Promise<string>,
): LlmProvider {
  return {
    chat: async (systemPrompt: string, userMessage: string, options?: LlmChatOptions) => {
      return chatFn(systemPrompt, userMessage, options);
    },
  };
}

describe('extractMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('returns structured memories from a session with learnings', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify([
        {
          implement: 'Use ioredis for Redis Cluster and persist slot metadata across reconnects to prevent timeout storms.',
          context: 'Redis cluster with 6 nodes using TLS, nodejs 20 runtime.',
          dnd: 'Do not use node-redis for this cluster setup because slot cache resets on reconnect can trigger repeated timeouts.',
          stack: ['nodejs', 'redis', 'typescript'],
          memory_type: 'memory',
        },
      ])
    );

    const result = await extractMemories(
      'Working on Redis connection issues. Set up pool but getting timeouts...',
      { name: 'test-project', stack: ['nodejs', 'redis'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].implement).toContain('ioredis');
    expect(result.memories[0].context).toContain('Redis cluster');
    expect(result.memories[0].dnd).toContain('node-redis');
    expect(result.memories[0].stack).toContain('nodejs');
    expect(result.memories[0].memory_type).toBe('memory');
    expect(result.memories[0].preference_confidence).toBe(0.0);
    expect(result.memories[0].extraction_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('parses a fenced json array response', async () => {
    const provider = createMockLlmProvider(() =>
      '```json\n[\n  {\n    "implement": "Use PgBouncer transaction pooling for short-lived API requests.",\n    "context": "PostgreSQL 16 behind PgBouncer for Node.js API workers.",\n    "dnd": null,\n    "stack": ["postgresql", "pgbouncer", "nodejs"],\n    "memory_type": "memory"\n  }\n]\n```'
    );

    const result = await extractMemories(
      'Database pooling troubleshooting notes',
      { name: 'test-project', stack: ['postgresql', 'nodejs'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].implement).toContain('PgBouncer');
  });

  it('parses a bare array response', async () => {
    const provider = createMockLlmProvider(() => JSON.stringify([
      {
        implement: 'Set Node.js http keepAliveTimeout above ALB idle timeout to reduce socket resets.',
        context: 'Node.js 20 service behind AWS ALB with default idle settings.',
        dnd: null,
        stack: ['nodejs', 'aws'],
        memory_type: 'memory',
      },
    ]));

    const result = await extractMemories(
      'Socket reset debugging notes',
      { name: 'test-project', stack: ['nodejs', 'aws'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].implement).toContain('keepAliveTimeout');
  });

  it('accepts fused E2 contract-shaped output and routes keywords', async () => {
    const provider = createMockLlmProvider(() => JSON.stringify([
      {
        implement: 'Set X because Y; applies when Z.',
        context: 'node 20 mcp daemon',
        dnd: 'Do not set WEVIBE_MCP_HTTP_ONLY unset or the daemon respawn-loops.',
        stack: ['node', 'mcp'],
        memory_type: 'memory',
        preference_confidence: 0.1,
        keywords: [{ keyword: 'mcp' }, { keyword: 'daemon' }],
      },
    ]));

    const result = await extractMemories(
      'MCP daemon session transcript',
      { name: 'test-project', stack: ['node', 'mcp'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(1);
    const [memory] = result.memories;
    expect(memory.implement.length).toBeGreaterThan(0);
    expect(memory.memory_type).toBe('memory');
    expect(memory.keywords.suggestions.map(keyword => keyword.keyword)).toEqual(
      expect.arrayContaining(['mcp', 'daemon']),
    );
  });

  it('parses a wrapped {memories:[...]} response', async () => {
    const provider = createMockLlmProvider(() => JSON.stringify({
      memories: [
        {
          implement: 'Set Prisma pool timeout below Lambda max duration to avoid orphaned connections.',
          context: 'AWS Lambda + Prisma + RDS Proxy under bursty traffic.',
          dnd: null,
          stack: ['prisma', 'aws', 'postgresql'],
          memory_type: 'memory',
        },
      ],
    }));

    const result = await extractMemories(
      'Prisma timeout triage',
      { name: 'test-project', stack: ['prisma', 'aws'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].implement).toContain('Prisma pool timeout');
  });

  it('keeps memories classified as memory', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify([
        {
          implement: 'Keep TLS hostname validation enabled in staging to catch certificate chain regressions early.',
          context: 'Node.js API clients validating internal service certs.',
          dnd: 'Avoid setting NODE_TLS_REJECT_UNAUTHORIZED=0 because it hides cert failures until production.',
          stack: ['nodejs', 'tls'],
          memory_type: 'memory',
        },
      ])
    );

    const result = await extractMemories(
      'TLS troubleshooting session',
      { name: 'test-project', stack: ['nodejs', 'tls'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].memory_type).toBe('memory');
  });

  it('keeps implementation-style memories classified as memory', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify([
        {
          implement: 'Pin Prisma query engine binaries to linux-musl for Alpine-based containers to avoid runtime binary mismatch failures.',
          context: 'Prisma 5 on Node.js 20 running in Alpine-based Docker images.',
          dnd: null,
          stack: ['prisma', 'docker', 'nodejs'],
          memory_type: 'memory',
        },
      ])
    );

    const result = await extractMemories(
      'Prisma deployment investigation',
      { name: 'test-project', stack: ['prisma', 'docker'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].memory_type).toBe('memory');
  });

  it('drops memories with invalid memory_type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = createMockLlmProvider(() =>
      JSON.stringify([
        {
          implement: 'Some invalidly typed memory.',
          context: 'Some context.',
          dnd: null,
          stack: ['nodejs'],
          memory_type: 'preference',
        },
      ])
    );

    const result = await extractMemories(
      'Session with invalid type',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('extraction: dropping memory with invalid memory_type "preference"');
    warnSpy.mockRestore();
  });

  it('drops memories with missing memory_type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = createMockLlmProvider(() =>
      JSON.stringify([
        {
          implement: 'Memory missing type should be dropped.',
          context: 'Some context.',
          dnd: null,
          stack: ['typescript'],
        },
      ])
    );

    const result = await extractMemories(
      'Session with missing type',
      { name: 'test-project', stack: ['typescript'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('extraction: dropping memory with invalid memory_type "undefined"');
    warnSpy.mockRestore();
  });

  it('drops memories missing required implement', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify([
        {
          context: 'Node.js service with internal TLS cert rotation.',
          dnd: null,
          stack: ['nodejs', 'tls'],
          memory_type: 'memory',
        },
      ])
    );

    const result = await extractMemories(
      'Session where implement was omitted',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(0);
  });

  it('adds deterministic extraction_hash for identical canonical content', async () => {
    const provider = createMockLlmProvider(() => JSON.stringify([
      {
        implement: 'Set NODE_OPTIONS=--max-old-space-size=4096 for CI webpack builds to prevent OOM crashes.',
        context: 'GitHub Actions ubuntu-latest runners building a Next.js monorepo.',
        dnd: null,
        stack: ['nodejs', 'next.js', 'webpack'],
        memory_type: 'memory',
        preference_confidence: 0.1,
      },
      {
        implement: 'Set NODE_OPTIONS=--max-old-space-size=4096 for CI webpack builds to prevent OOM crashes.',
        context: 'GitHub Actions ubuntu-latest runners building a Next.js monorepo.',
        dnd: null,
        stack: ['nodejs', 'next.js', 'webpack'],
        memory_type: 'memory',
        preference_confidence: 0.9,
      },
    ]));

    const result = await extractMemories(
      'Build pipeline memory extraction',
      { name: 'test-project', stack: ['nodejs', 'next.js'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(2);
    expect(result.memories[0].extraction_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.memories[1].extraction_hash).toBe(result.memories[0].extraction_hash);
  });

  it('honors per-request systemPrompt and numCtx overrides', async () => {
    let capturedSystemPrompt = '';
    let capturedNumCtx: number | undefined;
    const provider = createMockLlmProvider((systemPrompt, _userMessage, options) => {
      capturedSystemPrompt = systemPrompt;
      capturedNumCtx = options?.numCtx;
      return '[]';
    });

    await extractMemories(
      'Any transcript',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' },
      {
        provider,
        systemPrompt: 'ORG EXTRACTION PROFILE PROMPT',
        numCtx: 65536,
      },
    );

    expect(capturedSystemPrompt).toBe('ORG EXTRACTION PROFILE PROMPT');
    expect(capturedNumCtx).toBe(65536);
  });

  it('returns empty array for routine session', async () => {
    const provider = createMockLlmProvider(() => '[]');

    const result = await extractMemories(
      'Routine commit: updated package.json dependencies',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(0);
  });

  it('throws when LLM provider throws', async () => {
    const provider = createMockLlmProvider(() => { throw new Error('network error'); });

    await expect(extractMemories(
      'Some coding session content',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' },
      { provider },
    )).rejects.toThrow('network error');
  });

  it('returns empty array on malformed LLM response', async () => {
    const provider = createMockLlmProvider(() => 'not valid json');

    const result = await extractMemories(
      'Some coding session content',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' },
      { provider },
    );

    expect(result.memories).toHaveLength(0);
  });

  it('passes user message with project context to LLM', async () => {
    let capturedUserMessage = '';
    const provider = createMockLlmProvider((_, user) => {
      capturedUserMessage = user;
      return '[]';
    });

    await extractMemories(
      'Session about a React performance issue',
      { name: 'my-web-app', stack: ['react', 'next.js', 'typescript'], directory: '/Users/dev/project' },
      { provider },
    );

    expect(capturedUserMessage).toContain('my-web-app');
    expect(capturedUserMessage).toContain('react');
    expect(capturedUserMessage).toContain('next.js');
  });

  it('dedupes overlap candidates after multi-chunk extraction merge', async () => {
    const TRANSCRIPT_BEGIN_MARKER = '===WEVIBE_TRANSCRIPT_BEGIN===';
    const TRANSCRIPT_END_MARKER = '===WEVIBE_TRANSCRIPT_END===';
    const duplicateImplement = 'Use staged rollout with feature flags for risky infra changes.';
    const capturedUserMessages: string[] = [];
    let callIndex = 0;

    const provider = createMockLlmProvider((_systemPrompt, userMessage) => {
      capturedUserMessages.push(userMessage);
      const uniqueSuffix = callIndex;
      callIndex += 1;

      return JSON.stringify([
        {
          implement: duplicateImplement,
          context: 'Deployment discipline for platform changes with non-trivial blast radius.',
          dnd: 'Do not ship wide-open changes without a kill switch.',
          stack: ['kubernetes', 'typescript'],
          memory_type: 'memory',
        },
        {
          implement: `Unique chunk memory ${uniqueSuffix}`,
          context: `Chunk-specific context ${uniqueSuffix}`,
          dnd: null,
          stack: ['typescript'],
          memory_type: 'memory',
        },
      ]);
    });

    const transcript = Array.from({ length: 1200 }, (_, i) => `line-${i.toString().padStart(4, '0')}: chunking regression note`)
      .join('\n');

    const result = await extractMemories(
      transcript,
      { name: 'chunk-test', stack: ['typescript'], directory: '/Users/test' },
      {
        provider,
        numCtx: 8000,
      },
    );

    const extractSlice = (userMessage: string): string => {
      const begin = userMessage.indexOf(`${TRANSCRIPT_BEGIN_MARKER}\n`);
      const end = userMessage.indexOf(`\n${TRANSCRIPT_END_MARKER}`);
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(begin);
      return userMessage.slice(begin + TRANSCRIPT_BEGIN_MARKER.length + 1, end);
    };

    expect(capturedUserMessages.length).toBeGreaterThan(0);
    const firstSliceLength = extractSlice(capturedUserMessages[0]!).length;
    const slices = planChunkSlices(transcript.length, firstSliceLength, 8000);

    expect(capturedUserMessages.length).toBeGreaterThanOrEqual(3);
    expect(capturedUserMessages.length).toBe(slices.length);
    expect(callIndex).toBe(capturedUserMessages.length);

    const duplicateCount = result.memories.filter(memory => memory.implement === duplicateImplement).length;
    expect(duplicateCount).toBe(1);
    expect(result.memories).toHaveLength(callIndex + 1);
  });
});

describe('extraction retry wiring', () => {
  const projectContext = { name: 'retry-test', stack: ['typescript'], directory: '/Users/test' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('remote passes retry policy', async () => {
    const capturedOptions: LlmChatOptions[] = [];
    const provider = Object.assign(
      createMockLlmProvider((_systemPrompt, _userMessage, options) => {
        capturedOptions.push(options ?? {});
        return '[]';
      }),
      { model: 'openrouter/moonshotai/kimi-k2.6' },
    );

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          data: {
            endpoints: [
              { context_length: 131072 },
              { context_length: 262144 },
            ],
          },
        };
      },
    });

    await extractMemories(
      'Short transcript that should stay in tier-1 extraction.',
      projectContext,
      {
        provider,
        isLocal: false,
        traceId: 'trace-retry-remote',
      },
    );

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.retry).toEqual({ maxAttempts: 3, backoffMs: [600, 1500] });
    expect(capturedOptions[0]?.timeoutMs).toBe(600000);
    expect(capturedOptions[0]?.logLabel).toBe('tier1');
  });

  it('local omits retry (R-33)', async () => {
    const capturedOptions: LlmChatOptions[] = [];
    const provider = createMockLlmProvider((_systemPrompt, _userMessage, options) => {
      capturedOptions.push(options ?? {});
      return '[]';
    });

    await extractMemories(
      'Short local transcript that should stay in tier-1 extraction.',
      projectContext,
      {
        provider,
        isLocal: true,
        traceId: 'trace-retry-local',
      },
    );

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.retry).toBeUndefined();
    expect(capturedOptions[0]?.timeoutMs).toBe(600000);
    expect(capturedOptions[0]?.logLabel).toBe('tier1');
  });

  it('chunked extraction labels each call with chunk index', async () => {
    const capturedOptions: LlmChatOptions[] = [];
    const provider = createMockLlmProvider((_systemPrompt, _userMessage, options) => {
      capturedOptions.push(options ?? {});
      return '[]';
    });

    const transcript = Array.from(
      { length: 1200 },
      (_, i) => `line-${i.toString().padStart(4, '0')}: chunk retry wiring fixture`,
    ).join('\n');

    await extractMemories(
      transcript,
      projectContext,
      {
        provider,
        isLocal: true,
        numCtx: 8000,
        traceId: 'trace-retry-chunked',
      },
    );

    expect(capturedOptions.length).toBeGreaterThan(1);
    for (const options of capturedOptions) {
      expect(options.logLabel).toMatch(/^chunk-\d+$/);
      expect(options.retry).toBeUndefined();
      expect(options.timeoutMs).toBe(600000);
    }
  });
});

describe('extraction chunk helpers', () => {
  it('plans chunk slices with overlap and caps at transcript end', () => {
    expect(planChunkSlices(100, 40, 10)).toEqual([
      { start: 0, end: 40 },
      { start: 30, end: 70 },
      { start: 60, end: 100 },
    ]);
  });

  it('returns a single slice when room covers the full transcript', () => {
    expect(planChunkSlices(100, 150, 10)).toEqual([
      { start: 0, end: 100 },
    ]);
  });

  it('guarantees forward progress when overlap is at least room', () => {
    expect(planChunkSlices(100, 40, 50)).toEqual([
      { start: 0, end: 40 },
      { start: 40, end: 80 },
      { start: 80, end: 100 },
    ]);
  });

  it('runBounded limits in-flight work and preserves result ordering', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await runBounded(items, 3, async item => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return item * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(result).toEqual(items.map(item => item * 2));
  });

  it('runBounded propagates worker failures', async () => {
    await expect(runBounded([0, 1, 2, 3], 3, async item => {
      if (item === 2) {
        throw new Error('boom');
      }
      return item;
    })).rejects.toThrow('boom');
  });

  it('dedupes overlapping candidates by extraction hash and preserves passthrough records', () => {
    const duplicateA = {
      implement: 'Set connection pooling to avoid DB socket exhaustion.',
      context: 'Node.js API with bursty traffic patterns.',
      dnd: null,
      stack: ['nodejs', 'postgresql'],
      memory_type: 'memory',
      preference_confidence: 0.2,
    };
    const duplicateB = {
      implement: 'Set connection pooling to avoid DB socket exhaustion.',
      context: 'Node.js API with bursty traffic patterns.',
      dnd: null,
      stack: ['nodejs', 'postgresql'],
      memory_type: 'memory',
      preference_confidence: 0.8,
    };
    const distinct = {
      implement: 'Enable prepared statements to reduce parse overhead.',
      context: 'PostgreSQL under frequent repeat queries.',
      dnd: null,
      stack: ['postgresql'],
      memory_type: 'memory',
    };
    const passthrough = {
      context: 'Missing implement should remain passthrough for downstream filtering.',
      memory_type: 'memory',
    };

    const deduped = dedupeOverlapCandidatesByExtractionHash([
      duplicateA,
      duplicateB,
      distinct,
      passthrough,
    ]);

    const duplicateCount = deduped.filter(candidate => {
      if (candidate === null || typeof candidate !== 'object') {
        return false;
      }
      return (candidate as Record<string, unknown>).implement === duplicateA.implement;
    }).length;

    expect(duplicateCount).toBe(1);
    expect(deduped).toHaveLength(3);
    expect(deduped).toContain(passthrough);
    expect(deduped.some(candidate => {
      if (candidate === null || typeof candidate !== 'object') {
        return false;
      }
      return (candidate as Record<string, unknown>).implement === distinct.implement;
    })).toBe(true);
  });
});

describe('extractKeywords', () => {
  const testVocab = ['docker', 'kubernetes', 'nginx', 'postgresql', 'redis', 'typescript', 'golang'];

  function assertUnionBaseWeights(result: Awaited<ReturnType<typeof extractKeywords>>): void {
    const allKeywords = [...result.classified, ...result.suggestions];
    expect(allKeywords.length).toBeGreaterThan(0);

    for (const keyword of allKeywords) {
      expect(Number.isFinite(keyword.base_weight)).toBe(true);
      expect(keyword.base_weight).toBeGreaterThan(0);
    }

    const unionBaseWeightSum = allKeywords.reduce((sum, keyword) => sum + keyword.base_weight, 0);
    expect(Math.abs(unionBaseWeightSum - 1.0)).toBeLessThanOrEqual(1e-6);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('returns classified keywords with normalized weights summing to 1.0', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify({
        classified: [
          { keyword: 'docker', weight: 0.9 },
          { keyword: 'kubernetes', weight: 0.7 },
        ],
        suggestions: [],
      })
    );

    const result = await extractKeywords(
      'Set up a Docker container running PostgreSQL with Kubernetes orchestration.',
      ['docker', 'kubernetes'],
      testVocab,
      provider,
    );

    expect(result.classified).toHaveLength(2);
    const weights = result.classified.map(kw => kw.weight);
    const sum = weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
    expect(result.suggestions).toHaveLength(0);
    assertUnionBaseWeights(result);
  });

  it('returns suggestions with normalized weights summing to 1.0', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify({
        classified: [],
        suggestions: [
          { keyword: 'load_balancing', weight: 0.8, rationale: 'Describes the traffic distribution pattern used' },
          { keyword: 'reverse_proxy', weight: 0.6, rationale: 'Acts as intermediary for API servers' },
        ],
      })
    );

    const result = await extractKeywords(
      'Configured nginx as a load balancer in front of the API servers.',
      ['nginx'],
      testVocab,
      provider,
    );

    expect(result.suggestions).toHaveLength(2);
    const sugWeights = result.suggestions.map(kw => kw.weight);
    const sugSum = sugWeights.reduce((a, b) => a + b, 0);
    expect(sugSum).toBeCloseTo(1.0, 10);
    assertUnionBaseWeights(result);
  });

  it('returns classified and suggested keywords with normalized separate distributions', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify({
        classified: [{ keyword: 'nginx', weight: 0.6 }],
        suggestions: [
          { keyword: 'load_balancing', weight: 0.8, rationale: 'Describes the traffic distribution pattern used' },
        ],
      })
    );

    const result = await extractKeywords(
      'Configured nginx as a load balancer in front of the API servers.',
      ['nginx'],
      testVocab,
      provider,
    );

    expect(result.classified).toHaveLength(1);
    expect(result.classified[0].keyword).toBe('nginx');
    expect(result.classified[0].weight).toBe(1.0);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].keyword).toBe('load_balancing');
    expect(result.suggestions[0].weight).toBe(1.0);
    expect(result.suggestions[0].rationale).toBe('Describes the traffic distribution pattern used');
    assertUnionBaseWeights(result);
  });

  it('drops classified keywords not in vocabulary', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify({
        classified: [
          { keyword: 'docker', weight: 0.8 },
          { keyword: 'not_in_vocab', weight: 0.6 },
        ],
        suggestions: [],
      })
    );

    const result = await extractKeywords(
      'Docker deployment with custom orchestration.',
      ['docker'],
      testVocab,
      provider,
    );

    expect(result.classified).toHaveLength(1);
    expect(result.classified[0].keyword).toBe('docker');
  });

  it('drops suggestions already in vocabulary', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify({
        classified: [],
        suggestions: [
          { keyword: 'docker', weight: 0.9, rationale: 'Already in vocab' },
        ],
      })
    );

    const result = await extractKeywords(
      'Some memory about docker',
      [],
      testVocab,
      provider,
    );

    expect(result.suggestions).toHaveLength(0);
  });

  it('drops suggestions with invalid keyword pattern', async () => {
    const provider = createMockLlmProvider(() =>
      JSON.stringify({
        classified: [],
        suggestions: [
          { keyword: 'Invalid-Name', weight: 0.5, rationale: 'Has hyphens' },
          { keyword: 'good_suggestion', weight: 0.7, rationale: 'Valid pattern' },
        ],
      })
    );

    const result = await extractKeywords(
      'Some memory',
      [],
      testVocab,
      provider,
    );

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].keyword).toBe('good_suggestion');
  });
});

describe('computeEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 3072-dimension embedding vector', async () => {
    const result = await computeEmbedding('test query text');

    expect(result).toHaveLength(3072);
    expect(result[0]).toBeCloseTo(0.1);
  });

  it('delegates to computeLocalEmbedding', async () => {
    const { computeLocalEmbedding } = await import('../src/embedding.js');
    await computeEmbedding('test query');

    expect(computeLocalEmbedding).toHaveBeenCalledWith(
      'test query',
      undefined,
      expect.objectContaining({
        baseUrl: expect.any(String),
        apiKey: expect.any(String),
        model: expect.any(String),
        usePrefix: expect.any(Boolean),
      }),
    );
  });
});

describe('near-duplicate detection', () => {
  const DEFAULT_EMBEDDING = new Array(3072).fill(0.1);

  afterEach(() => {
    vi.mocked(computeLocalEmbedding).mockReset();
    vi.mocked(computeLocalEmbedding).mockResolvedValue(DEFAULT_EMBEDDING);
  });

  it('computes cosine similarity and guards invalid vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it('flags intra-session and injected near-duplicates while keeping distinct memories', async () => {
    const makeMemory = (implement: string, context: string, extractionHash: string): MemoryCandidate => ({
      implement,
      context,
      dnd: null,
      stack: ['typescript'],
      memory_type: 'memory',
      preference_confidence: 0,
      extraction_hash: extractionHash,
      keywords: {
        classified: [],
        suggestions: [],
      },
      mc1: {
        mc_version: 1,
        org_id: 'test-org',
        keywords: [],
      },
    });

    const memories: MemoryCandidate[] = [
      makeMemory('alpha implementation', 'alpha context', 'hash-a'),
      makeMemory('alpha implementation variant', 'alpha context variant', 'hash-b'),
      makeMemory('clearly distinct implementation', 'clearly distinct context', 'hash-c'),
      makeMemory('served-memory overlap implementation', 'served-memory overlap context', 'hash-d'),
    ];
    const injectedTexts = ['served memory that was already injected'];

    const textToVector = new Map<string, number[]>([
      [`${memories[0].implement}\n${memories[0].context}`, [1, 0, 0, 0]],
      [`${memories[1].implement}\n${memories[1].context}`, [0.96, 0.28, 0, 0]],
      [`${memories[2].implement}\n${memories[2].context}`, [0, 1, 0, 0]],
      [`${memories[3].implement}\n${memories[3].context}`, [0, 0, 1, 0]],
      [injectedTexts[0], [0, 0, 0.97, 0.24]],
    ]);

    vi.mocked(computeLocalEmbedding).mockImplementation(async (text: string) => {
      const vector = textToVector.get(text);
      if (!vector) {
        throw new Error(`missing test embedding for ${text}`);
      }
      return vector;
    });

    await annotateNearDuplicates(memories, injectedTexts, {
      traceId: 'trace-near-dup-test',
      exactHashCollapsed: 1,
    });

    expect(memories[0].near_dup?.source).toBe('intra_session');
    expect(memories[0].near_dup?.matched).toBe(memories[1].extraction_hash);
    expect(memories[0].near_dup?.score ?? 0).toBeGreaterThanOrEqual(NEAR_DUP_COSINE_THRESHOLD);

    expect(memories[2].near_dup).toBeUndefined();

    expect(memories[3].near_dup?.source).toBe('injected_memory');
    expect(memories[3].near_dup?.matched).toBe('injected:1');
    expect(memories[3].near_dup?.score ?? 0).toBeGreaterThanOrEqual(NEAR_DUP_COSINE_THRESHOLD);
  });
});
