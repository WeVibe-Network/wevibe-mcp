import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractMemories, computeEmbedding, extractKeywords } from '../src/extraction.js';
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
