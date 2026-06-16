import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeLocalEmbedding } from '../src/embedding.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockEmbeddingResponse(): void {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ embedding: new Array(3072).fill(0.1) }],
    }),
  });
}

function getInputFromRequest(): string {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, request] = mockFetch.mock.calls[0] as [string, RequestInit];
  expect(url.endsWith('/embeddings')).toBe(true);
  const body = JSON.parse(request.body as string) as { input?: string };
  expect(typeof body.input).toBe('string');
  return body.input as string;
}

describe('computeLocalEmbedding prefix support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockEmbeddingResponse();
  });

  it('prepends document prefix when prefix=true and role=document', async () => {
    await computeLocalEmbedding('document text', { prefix: true, role: 'document' });

    expect(getInputFromRequest()).toBe('search_document: document text');
  });

  it('prepends query prefix when prefix=true and role=query', async () => {
    await computeLocalEmbedding('query text', { prefix: true, role: 'query' });

    expect(getInputFromRequest()).toBe('search_query: query text');
  });

  it('keeps prompt unchanged when opts are omitted', async () => {
    await computeLocalEmbedding('plain text');

    expect(getInputFromRequest()).toBe('plain text');
  });
});
