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
const smallSystemPrompt = 'sys';
const smallUserMessage = 'user';
const streamingSystemPrompt = 's'.repeat(40001);
const streamingUserMessage = 'u'.repeat(24000);

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

function createSseBody(lines: string[], options?: { close?: boolean }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.map((line) => `${line}\n`).join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      if (options?.close ?? true) {
        controller.close();
      }
    },
  });
}

function mockStreamingSuccess(lines: string[], options?: { close?: boolean }): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: createSseBody(lines, options),
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

  it('small prompt stays on non-streaming path and omits stream key', async () => {
    mockChatSuccess('{"candidates":["small"]}');

    const provider = buildProvider();
    const result = await provider.chat(smallSystemPrompt, smallUserMessage);

    expect(result).toBe('{"candidates":["small"]}');
    const sentBody = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(Object.hasOwn(sentBody, 'stream')).toBe(false);
  });

  it('large prompt uses streaming and accumulates delta content to final string', async () => {
    mockStreamingSuccess([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
      ': keepalive',
      'data: {"choices":[{"delta":{"content":"{\\"candidates\\":"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"[]}"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]);

    const provider = buildProvider();
    const result = await provider.chat(streamingSystemPrompt, streamingUserMessage, { jsonFormat: true });

    expect(result).toBe('{"candidates":[]}');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sentBody.stream).toBe(true);
  });

  it('stream idle watchdog aborts stalled chunk stream', async () => {
    vi.useFakeTimers();

    const stalledBody = {
      getReader() {
        return {
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
          releaseLock: () => undefined,
        };
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: stalledBody,
    });

    const provider = buildProvider();
    const promise = provider.chat('x'.repeat(64001), 'user');
    const capturedError = promise.catch((err) => err);
    await vi.advanceTimersByTimeAsync(180001);

    const error = await capturedError;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('idle for 180000ms');
  });

  it('streaming outcome log records counts and no content', async () => {
    const spy = vi.spyOn(logger, 'logOp');
    mockStreamingSuccess([
      'data: {"choices":[{"delta":{"content":"secret-output"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]);

    const provider = buildProvider();
    await expect(provider.chat(streamingSystemPrompt, streamingUserMessage, { traceId: 'trace-1' })).resolves.toBe('secret-output');

    expect(spy).toHaveBeenCalledWith(
      'extract',
      'info',
      expect.objectContaining({
        event: 'llm.stream',
        trace: 'trace-1',
        prompt_chars: streamingSystemPrompt.length + streamingUserMessage.length,
        chunks: 1,
        content_chars: 'secret-output'.length,
        finish_reason: 'stop',
        outcome: 'success',
      }),
    );
    const loggedFields = spy.mock.calls.find((call) => call[2]?.event === 'llm.stream')?.[2] as Record<string, unknown>;
    expect(JSON.stringify(loggedFields)).not.toContain('secret-output');
    expect(JSON.stringify(loggedFields)).not.toContain(streamingSystemPrompt);
    expect(JSON.stringify(loggedFields)).not.toContain(streamingUserMessage);
    spy.mockRestore();
  });
});
