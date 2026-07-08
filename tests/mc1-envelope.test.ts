import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractMemories } from '../src/extraction.js';
import {
  MC_VERSION,
  Mc1WriteEnvelopeSchema,
  validateMc1WriteEnvelope,
} from '../src/mc1/index.js';
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

vi.mock('../src/org-client.js', () => ({
  getOrgInfo: vi.fn().mockResolvedValue({ org_name: 'Test Org' }),
  getOrgKeywords: vi.fn().mockResolvedValue(['redis', 'typescript', 'caching']),
  getOrgKeywordCandidates: vi.fn().mockResolvedValue([]),
}));

const ORG_VOCAB = ['redis', 'typescript', 'caching'];
const ABS_PATH = '/Users/jerry/wevibe-workspace/wevibe-mcp/src/foo.ts';
const PROJECT_CONTEXT = {
  name: 'demo',
  stack: ['redis', 'typescript'],
  directory: '/Users/jerry/wevibe-workspace/wevibe-mcp',
};
const ORG_CONTEXT = { orgId: 'org_test', hubUrl: 'http://hub.local' };

function createMockLlmProvider(
  chatFn: (sys: string, user: string, options?: LlmChatOptions) => string | Promise<string>,
): LlmProvider {
  return {
    chat: async (systemPrompt: string, userMessage: string, options?: LlmChatOptions) => {
      return chatFn(systemPrompt, userMessage, options);
    },
  };
}

function createEnvelopeProvider(): LlmProvider {
  return createMockLlmProvider(() => JSON.stringify([
    {
      implement: `Use redis caching in TypeScript service. File ${ABS_PATH}`,
      context: `Cache tuning happened in ${ABS_PATH} for better caching hit ratio.`,
      dnd: 'Do not use unbounded cache TTL values.',
      stack: ['redis', 'typescript', 'nodejs'],
      memory_type: 'memory',
      keywords: [
        { keyword: 'redis', weight: 0.9 },
        { keyword: 'TypeScript', weight: 0.7 },
        { keyword: 'GraphQL', weight: 0.4 },
      ],
    },
  ]));
}

describe('MC-1 envelope acceptance (write side)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('creates a full valid envelope on the extraction path', async () => {
    const provider = createEnvelopeProvider();
    const result = await extractMemories(
      'transcript with redis and cache debugging',
      PROJECT_CONTEXT,
      {
        provider,
        orgContext: ORG_CONTEXT,
      },
    );

    expect(result.memories).toHaveLength(1);
    const mem = result.memories[0];

    expect(mem.mc1).toBeDefined();
    expect(() => validateMc1WriteEnvelope(mem.mc1)).not.toThrow();
    expect(mem.mc1.mc_version).toBe(1);
    expect(mem.mc1.mc_version).toBe(MC_VERSION);
    expect(mem.mc1.org_id).toBe('org_test');
    expect(Mc1WriteEnvelopeSchema.safeParse(mem.mc1).success).toBe(true);
  });

  it('scrubs paths to relative identity-free values (INV-12)', async () => {
    const result = await extractMemories(
      'transcript with absolute developer machine path leakage',
      PROJECT_CONTEXT,
      {
        provider: createEnvelopeProvider(),
        orgContext: ORG_CONTEXT,
      },
    );

    expect(result.memories).toHaveLength(1);
    const paths = result.memories[0].mc1.paths;

    expect(paths).toBeDefined();
    expect(paths).toContain('src/foo.ts');

    for (const path of paths ?? []) {
      expect(path.startsWith('/')).toBe(false);
      expect(path).not.toMatch(/^[A-Za-z]:[\\/]/);
      expect(path).not.toContain('/Users/');
      expect(path.toLowerCase()).not.toContain('jerry');
    }
  });

  it('constrains envelope keywords to org vocabulary terms only', async () => {
    const result = await extractMemories(
      'transcript mentioning redis and typescript cache work',
      PROJECT_CONTEXT,
      {
        provider: createEnvelopeProvider(),
        orgContext: ORG_CONTEXT,
      },
    );

    expect(result.memories).toHaveLength(1);
    const keywords = result.memories[0].mc1.keywords;
    expect(Array.isArray(keywords)).toBe(true);
    expect(keywords.length).toBeGreaterThan(0);

    for (const keyword of keywords) {
      expect(keyword).toBe(keyword.toLowerCase());
      expect(ORG_VOCAB).toContain(keyword);
    }

    expect(keywords).toEqual(expect.arrayContaining(['redis', 'typescript']));
    expect(keywords).not.toContain('graphql');
  });

  it('uses the shared mc1 module import and avoids inline schema copy', () => {
    const extractionSource = readFileSync(new URL('../src/extraction.ts', import.meta.url), 'utf8');

    expect(extractionSource).toMatch(/from ['"]\.\/mc1(\/index)?\.js['"]/);
  });
});
