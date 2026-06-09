import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeLocalEmbedding } from '../src/embedding.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockEmbeddingResponse(): void {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      embedding: new Array(768).fill(0.1),
    }),
  });
}

function getPromptFromRequest(): string {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [, request] = mockFetch.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(request.body as string) as { prompt?: string };
  expect(typeof body.prompt).toBe('string');
  return body.prompt as string;
}

describe('computeLocalEmbedding prefix support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockEmbeddingResponse();
  });

  it('prepends search_document prefix when prefix=true and role=document', async () => {
    await computeLocalEmbedding('document text', { prefix: true, role: 'document' });

    expect(getPromptFromRequest()).toBe('search_document: document text');
  });

  it('prepends search_query prefix when prefix=true and role=query', async () => {
    await computeLocalEmbedding('query text', { prefix: true, role: 'query' });

    expect(getPromptFromRequest()).toBe('search_query: query text');
  });

  it('keeps prompt unchanged when opts are omitted', async () => {
    await computeLocalEmbedding('plain text');

    expect(getPromptFromRequest()).toBe('plain text');
  });
});
