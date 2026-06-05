import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractMemories, computeEmbedding, extractKeywords } from '../src/extraction.js';
import { setLlmProvider } from '../src/llm.js';
import type { LlmProvider } from '../src/llm.js';

vi.mock('../src/embedding.js', () => ({
  computeLocalEmbedding: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
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

function createMockLlmProvider(chatFn: (sys: string, user: string) => string | Promise<string>): LlmProvider {
  return {
    chat: async (systemPrompt: string, userMessage: string) => {
      return chatFn(systemPrompt, userMessage);
    },
  };
}

describe('extractMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('returns structured memories from a session with learnings', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify([
        {
          insight: 'ioredis solved Redis cluster timeouts by persisting slot metadata across reconnects.',
          context: 'Redis cluster with 6 nodes using TLS, nodejs 20 runtime.',
          avoid: 'Avoid node-redis for clustered Redis: it drops slot cache on reconnect and causes timeouts.',
          stack: ['nodejs', 'redis', 'typescript'],
          memory_type: 'memory',
        },
      ])
    ));

    const result = await extractMemories(
      'Working on Redis connection issues. Set up pool but getting timeouts...',
      { name: 'test-project', stack: ['nodejs', 'redis'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].insight).toContain('ioredis');
    expect(result.memories[0].context).toContain('Redis cluster');
    expect(result.memories[0].avoid).toContain('node-redis');
    expect(result.memories[0].stack).toContain('nodejs');
    expect(result.memories[0].memory_type).toBe('memory');
  });

  it('keeps memories classified as memory', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify([
        {
          insight: 'Do not disable TLS hostname validation in staging because it masks certificate chain regressions.',
          context: 'Node.js API clients validating internal service certs.',
          avoid: 'Avoid setting NODE_TLS_REJECT_UNAUTHORIZED=0 because it hides cert failures until production.',
          stack: ['nodejs', 'tls'],
          memory_type: 'memory',
        },
      ])
    ));

    const result = await extractMemories(
      'TLS troubleshooting session',
      { name: 'test-project', stack: ['nodejs', 'tls'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].memory_type).toBe('memory');
  });

  it('keeps implementation-style memories classified as memory', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify([
        {
          insight: 'Pinning Prisma query engine binaries to linux-musl fixed runtime failures in Alpine containers.',
          context: 'Prisma 5 on Node.js 20 running in Alpine-based Docker images.',
          avoid: null,
          stack: ['prisma', 'docker', 'nodejs'],
          memory_type: 'memory',
        },
      ])
    ));

    const result = await extractMemories(
      'Prisma deployment investigation',
      { name: 'test-project', stack: ['prisma', 'docker'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].memory_type).toBe('memory');
  });

  it('drops memories with invalid memory_type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify([
        {
          insight: 'Some invalidly typed memory.',
          context: 'Some context.',
          avoid: null,
          stack: ['nodejs'],
          memory_type: 'preference',
        },
      ])
    ));

    const result = await extractMemories(
      'Session with invalid type',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('extraction: dropping memory with invalid memory_type "preference"');
    warnSpy.mockRestore();
  });

  it('drops memories with missing memory_type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify([
        {
          insight: 'Memory missing type should be dropped.',
          context: 'Some context.',
          avoid: null,
          stack: ['typescript'],
        },
      ])
    ));

    const result = await extractMemories(
      'Session with missing type',
      { name: 'test-project', stack: ['typescript'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('extraction: dropping memory with invalid memory_type "undefined"');
    warnSpy.mockRestore();
  });

  it('returns empty array for routine session', async () => {
    setLlmProvider(createMockLlmProvider(() => '[]'));

    const result = await extractMemories(
      'Routine commit: updated package.json dependencies',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(0);
  });

  it('returns empty array when LLM provider throws', async () => {
    setLlmProvider(createMockLlmProvider(() => { throw new Error('network error'); }));

    const result = await extractMemories(
      'Some coding session content',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(0);
  });

  it('returns empty array on malformed LLM response', async () => {
    setLlmProvider(createMockLlmProvider(() => 'not valid json'));

    const result = await extractMemories(
      'Some coding session content',
      { name: 'test-project', stack: ['nodejs'], directory: '/Users/test' }
    );

    expect(result.memories).toHaveLength(0);
  });

  it('passes user message with project context to LLM', async () => {
    let capturedUserMessage = '';
    setLlmProvider(createMockLlmProvider((_, user) => {
      capturedUserMessage = user;
      return '[]';
    }));

    await extractMemories(
      'Session about a React performance issue',
      { name: 'my-web-app', stack: ['react', 'next.js', 'typescript'], directory: '/Users/dev/project' }
    );

    expect(capturedUserMessage).toContain('my-web-app');
    expect(capturedUserMessage).toContain('react');
    expect(capturedUserMessage).toContain('next.js');
  });
});

describe('extractKeywords', () => {
  const testVocab = ['docker', 'kubernetes', 'nginx', 'postgresql', 'redis', 'typescript', 'golang'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('returns classified keywords with normalized weights summing to 1.0', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify({
        classified: [
          { keyword: 'docker', weight: 0.9 },
          { keyword: 'kubernetes', weight: 0.7 },
        ],
        suggestions: [],
      })
    ));

    const result = await extractKeywords(
      'Set up a Docker container running PostgreSQL with Kubernetes orchestration.',
      ['docker', 'kubernetes'],
      testVocab,
    );

    expect(result.classified).toHaveLength(2);
    const weights = result.classified.map(kw => kw.weight);
    const sum = weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
    expect(result.suggestions).toHaveLength(0);
  });

  it('returns suggestions with normalized weights summing to 1.0', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify({
        classified: [],
        suggestions: [
          { keyword: 'load_balancing', weight: 0.8, rationale: 'Describes the traffic distribution pattern used' },
          { keyword: 'reverse_proxy', weight: 0.6, rationale: 'Acts as intermediary for API servers' },
        ],
      })
    ));

    const result = await extractKeywords(
      'Configured nginx as a load balancer in front of the API servers.',
      ['nginx'],
      testVocab,
    );

    expect(result.suggestions).toHaveLength(2);
    const sugWeights = result.suggestions.map(kw => kw.weight);
    const sugSum = sugWeights.reduce((a, b) => a + b, 0);
    expect(sugSum).toBeCloseTo(1.0, 10);
  });

  it('returns classified and suggested keywords with normalized separate distributions', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify({
        classified: [{ keyword: 'nginx', weight: 0.6 }],
        suggestions: [
          { keyword: 'load_balancing', weight: 0.8, rationale: 'Describes the traffic distribution pattern used' },
        ],
      })
    ));

    const result = await extractKeywords(
      'Configured nginx as a load balancer in front of the API servers.',
      ['nginx'],
      testVocab,
    );

    expect(result.classified).toHaveLength(1);
    expect(result.classified[0].keyword).toBe('nginx');
    expect(result.classified[0].weight).toBe(1.0);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].keyword).toBe('load_balancing');
    expect(result.suggestions[0].weight).toBe(1.0);
    expect(result.suggestions[0].rationale).toBe('Describes the traffic distribution pattern used');
  });

  it('drops classified keywords not in vocabulary', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify({
        classified: [
          { keyword: 'docker', weight: 0.8 },
          { keyword: 'not_in_vocab', weight: 0.6 },
        ],
        suggestions: [],
      })
    ));

    const result = await extractKeywords(
      'Docker deployment with custom orchestration.',
      ['docker'],
      testVocab,
    );

    expect(result.classified).toHaveLength(1);
    expect(result.classified[0].keyword).toBe('docker');
  });

  it('drops suggestions already in vocabulary', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify({
        classified: [],
        suggestions: [
          { keyword: 'docker', weight: 0.9, rationale: 'Already in vocab' },
        ],
      })
    ));

    const result = await extractKeywords(
      'Some memory about docker',
      [],
      testVocab,
    );

    expect(result.suggestions).toHaveLength(0);
  });

  it('drops suggestions with invalid keyword pattern', async () => {
    setLlmProvider(createMockLlmProvider(() =>
      JSON.stringify({
        classified: [],
        suggestions: [
          { keyword: 'Invalid-Name', weight: 0.5, rationale: 'Has hyphens' },
          { keyword: 'good_suggestion', weight: 0.7, rationale: 'Valid pattern' },
        ],
      })
    ));

    const result = await extractKeywords(
      'Some memory',
      [],
      testVocab,
    );

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].keyword).toBe('good_suggestion');
  });
});

describe('computeEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 768-dimension embedding vector', async () => {
    const result = await computeEmbedding('test query text');

    expect(result).toHaveLength(768);
    expect(result[0]).toBeCloseTo(0.1);
  });

  it('delegates to computeLocalEmbedding', async () => {
    const { computeLocalEmbedding } = await import('../src/embedding.js');
    await computeEmbedding('test query');

    expect(computeLocalEmbedding).toHaveBeenCalledWith('test query');
  });
});
