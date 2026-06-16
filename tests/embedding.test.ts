import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeLocalEmbedding } from '../src/embedding.js';
import {
  EMBEDDING_DOCUMENT_PREFIX,
  EMBEDDING_QUERY_PREFIX,
} from '../src/config.js';
import type { ResolvedEmbeddingConfig } from '../src/embedding-config.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const openRouterConfig: ResolvedEmbeddingConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-test',
  model: 'openai/text-embedding-3-large',
  usePrefix: false,
};

function buildVector(dim = 3072): number[] {
  return Array.from({ length: dim }, (_, index) => index / dim);
}

function mockEmbeddingResponse(embedding = buildVector()): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ embedding }],
    }),
  });
}

function mockHttpFailure(status: number, details: string): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => details,
  });
}

function getCallBody(callIndex = 0): { model: string; input: string } {
  const call = mockFetch.mock.calls[callIndex] as [string, RequestInit];
  const request = call[1] as RequestInit;
  return JSON.parse(String(request.body));
}

describe('computeLocalEmbedding HTTP behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns data[0].embedding and posts OpenAI-compatible payload to /embeddings', async () => {
    const vector = buildVector(3072);
    mockEmbeddingResponse(vector);

    const result = await computeLocalEmbedding('vectorize me', undefined, openRouterConfig);

    expect(result).toEqual(vector);
    expect(result).toHaveLength(3072);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, request] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({
      Authorization: 'Bearer sk-or-test',
      'Content-Type': 'application/json',
    });

    expect(getCallBody()).toEqual({
      model: 'openai/text-embedding-3-large',
      input: 'vectorize me',
    });
  });

  it('suppresses prefix when config.usePrefix=false even if opts.prefix=true', async () => {
    mockEmbeddingResponse();

    await computeLocalEmbedding(
      'no prefix expected',
      { role: 'document', prefix: true },
      openRouterConfig,
    );

    expect(getCallBody().input).toBe('no prefix expected');
  });

  it('applies document/query prefixes when config.usePrefix=true', async () => {
    const prefixedConfig: ResolvedEmbeddingConfig = {
      ...openRouterConfig,
      usePrefix: true,
    };

    mockEmbeddingResponse();
    mockEmbeddingResponse();

    await computeLocalEmbedding('document body', { role: 'document', prefix: true }, prefixedConfig);
    await computeLocalEmbedding('query body', { role: 'query', prefix: true }, prefixedConfig);

    expect(getCallBody(0).input).toBe(`${EMBEDDING_DOCUMENT_PREFIX}document body`);
    expect(getCallBody(1).input).toBe(`${EMBEDDING_QUERY_PREFIX}query body`);
  });

  it.each([401, 403])('throws immediately on HTTP %s without retry', async (statusCode) => {
    mockHttpFailure(statusCode, 'auth failed');

    await expect(
      computeLocalEmbedding('blocked', undefined, openRouterConfig),
    ).rejects.toThrow(`(${statusCode})`);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 429 and succeeds later', async () => {
    vi.useFakeTimers();
    const vector = buildVector();

    mockHttpFailure(429, 'rate limited');
    mockEmbeddingResponse(vector);

    const promise = computeLocalEmbedding('retry me', undefined, openRouterConfig);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual(vector);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP 5xx and succeeds later', async () => {
    vi.useFakeTimers();

    mockHttpFailure(502, 'upstream bad gateway');
    mockEmbeddingResponse();

    const promise = computeLocalEmbedding('server hiccup', undefined, openRouterConfig);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toHaveLength(3072);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts on repeated network rejection', async () => {
    vi.useFakeTimers();

    const first = new Error('network down 1');
    const second = new Error('network down 2');
    const third = new Error('network down 3');

    mockFetch.mockRejectedValueOnce(first);
    mockFetch.mockRejectedValueOnce(second);
    mockFetch.mockRejectedValueOnce(third);

    const promise = computeLocalEmbedding('still offline', undefined, openRouterConfig);
    const rejection = expect(promise).rejects.toBe(third);
    await vi.runAllTimersAsync();

    await rejection;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: 'data array is empty',
      body: { data: [] },
      message: 'response missing data[0].embedding array',
    },
    {
      name: 'data[0] is missing embedding',
      body: { data: [{}] },
      message: 'response missing data[0].embedding array',
    },
    {
      name: 'embedding is empty array',
      body: { data: [{ embedding: [] }] },
      message: 'response missing data[0].embedding values',
    },
    {
      name: 'embedding has non-numeric values',
      body: { data: [{ embedding: ['a', 'b'] }] },
      message: 'response contains non-numeric values',
    },
  ])('throws on malformed response: $name', async ({ body, message }) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => body,
    });

    await expect(
      computeLocalEmbedding('bad response', undefined, openRouterConfig),
    ).rejects.toThrow(message);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
