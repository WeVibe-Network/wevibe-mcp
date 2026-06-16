import { beforeEach, describe, expect, it, vi } from 'vitest';
import { embedRetrievalCard } from '../src/embed-card.js';
import { computeLocalEmbedding } from '../src/embedding.js';
import { loadEmbeddingConfig } from '../src/embedding-config.js';
import type { ResolvedEmbeddingConfig } from '../src/embedding-config.js';
import { sanitizeForEmbedding } from '../src/retrieval-card.js';
import type { StructuredMemory } from '../src/retrieval-card.js';

vi.mock('../src/embedding.js', () => ({
  computeLocalEmbedding: vi.fn(),
}));

vi.mock('../src/embedding-config.js', () => ({
  loadEmbeddingConfig: vi.fn(),
}));

const openRouterConfig: ResolvedEmbeddingConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  model: 'openai/text-embedding-3-large',
  usePrefix: false,
};

const structuredMemory: StructuredMemory = {
  implement: 'Use parameterized SQL queries.',
  context: 'SQL mutation handlers',
  dnd: 'Build SQL with string concatenation.',
  stack: ['TypeScript', 'PostgreSQL'],
};

function buildVector(dim = 3072): number[] {
  return Array.from({ length: dim }, (_, index) => index / dim);
}

describe('embedRetrievalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEmbeddingConfig).mockReturnValue(openRouterConfig);
    vi.mocked(computeLocalEmbedding).mockResolvedValue(buildVector());
  });

  it('returns vector/card/model and calls computeLocalEmbedding as document embedding', async () => {
    const chat = vi.fn(async () => 'When writing SQL updates safely in API handlers.');

    const result = await embedRetrievalCard(
      structuredMemory,
      chat,
      { strictAnticipated: true },
    );

    const expectedCardText = [
      'Applies when: SQL mutation handlers',
      'Stack: TypeScript, PostgreSQL',
      'Implement: Use parameterized SQL queries.',
      'Avoid: Build SQL with string concatenation.',
      'Anticipated need: When writing SQL updates safely in API handlers.',
    ].join('\n');

    expect(result.vector).toHaveLength(3072);
    expect(result.cardText).toBe(expectedCardText);
    expect(result.embeddingModelId).toBe('openai/text-embedding-3-large');
    expect(computeLocalEmbedding).toHaveBeenCalledTimes(1);
    expect(computeLocalEmbedding).toHaveBeenCalledWith(
      sanitizeForEmbedding(expectedCardText),
      { role: 'document', prefix: true },
      openRouterConfig,
    );
  });

  it('fails loud when loadEmbeddingConfig throws', async () => {
    const loadError = new Error('OpenRouter API key missing or masked in dashboard.json; paste a real key');
    vi.mocked(loadEmbeddingConfig).mockImplementationOnce(() => {
      throw loadError;
    });

    const chat = vi.fn(async () => 'Unused in this scenario');

    await expect(
      embedRetrievalCard(structuredMemory, chat, { strictAnticipated: false }),
    ).rejects.toBe(loadError);

    expect(computeLocalEmbedding).not.toHaveBeenCalled();
  });
});
