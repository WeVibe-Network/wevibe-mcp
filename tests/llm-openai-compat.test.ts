import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenAICompatibleProvider,
  LlmEmptyResponseError,
  LlmHttpError,
} from '../src/llm-openai-compat.js';
import * as logger from '../src/logger.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const providerBaseUrl = 'https://openrouter.ai/api/v1';
const providerModel = 'moonshotai/kimi-k2.6';
const providerApiKey = 'test-key';

const retryingJsonOptions = {
  retry: { maxAttempts: 3, backoffMs: [600, 1500] },
  jsonFormat: true,
  jsonSchema: { name: 'x', schema: { type: 'object' } },
};

function buildProvider() {
  return createOpenAICompatibleProvider(providerBaseUrl, providerModel, providerApiKey);
}

function mockChatSuccess(content = '{"candidates":[]}'): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  });
}

function mockChatEmpty(finishReason = 'length'): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '' }, finish_reason: finishReason }],
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

describe('createOpenAICompatibleProvider retry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('empty response retries then succeeds', async () => {
    vi.useFakeTimers();

    mockChatEmpty('length');
    mockChatSuccess('{"candidates":["ok"]}');

    const provider = buildProvider();
    const promise = provider.chat('sys', 'user', retryingJsonOptions);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('{"candidates":["ok"]}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('HTTP 500 retries then succeeds', async () => {
    vi.useFakeTimers();

    mockHttpFailure(500, 'boom');
    mockChatSuccess('{"candidates":["ok"]}');

    const provider = buildProvider();
    const promise = provider.chat('sys', 'user', retryingJsonOptions);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('{"candidates":["ok"]}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('HTTP 429 retries then succeeds', async () => {
    vi.useFakeTimers();

    mockHttpFailure(429, 'rate limited');
    mockChatSuccess('{"candidates":["ok"]}');

    const provider = buildProvider();
    const promise = provider.chat('sys', 'user', retryingJsonOptions);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('{"candidates":["ok"]}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('HTTP 400 non-format rejection is terminal without retry', async () => {
    mockHttpFailure(400, 'bad request');

    const provider = buildProvider();
    const promise = provider.chat('sys', 'user', retryingJsonOptions);

    await expect(promise).rejects.toBeInstanceOf(LlmHttpError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('all retry attempts empty fails loudly with finish reason', async () => {
    vi.useFakeTimers();

    mockChatEmpty('length');
    mockChatEmpty('length');
    mockChatEmpty('length');

    const provider = buildProvider();
    const promise = provider.chat('sys', 'user', retryingJsonOptions);
    const capturedError = promise.catch((err) => err);
    await vi.runAllTimersAsync();

    const error = await capturedError;
    expect(error).toBeInstanceOf(LlmEmptyResponseError);
    expect((error as Error).message).toContain('finish_reason=length');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('no retry policy defaults to single attempt for local path safety', async () => {
    mockChatEmpty('length');

    const provider = buildProvider();
    const promise = provider.chat('sys', 'user', {
      jsonFormat: true,
      jsonSchema: { name: 'x', schema: { type: 'object' } },
    });

    await expect(promise).rejects.toBeInstanceOf(LlmEmptyResponseError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retry log records real empty-response reason fields', async () => {
    vi.useFakeTimers();

    const spy = vi.spyOn(logger, 'logOp');
    mockChatEmpty('length');
    mockChatSuccess('{"candidates":[]}');

    const provider = buildProvider();
    const promise = provider.chat('sys', 'user', {
      ...retryingJsonOptions,
      traceId: 'trace-1',
      logLabel: 'chunk-2',
    });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('{"candidates":[]}');
    expect(spy).toHaveBeenCalledWith(
      'extract',
      'warn',
      expect.objectContaining({
        phase: 'llm_retry',
        reason: 'empty',
        finish_reason: 'length',
      }),
    );
    spy.mockRestore();
  });
});
