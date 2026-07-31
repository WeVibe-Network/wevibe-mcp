import type { LlmChatOptions, LlmProvider } from './llm.js';
import { logOp } from './logger.js';

type ResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }
  | { type: 'json_object' }
  | undefined;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ERROR_BODY_SNIPPET_LIMIT = 500;
const STREAMING_PROMPT_CHAR_THRESHOLD = 64000;
const STREAMING_CHUNK_IDLE_TIMEOUT_MS = 180000;
const FREE_SUFFIX_RE = /:free$/i;
const NO_ENDPOINTS_RE = /no endpoints?/i;
const NOT_A_VALID_MODEL_RE = /not a valid model/i;
const MODEL_UNAVAILABLE_RE = /model .* (not found|unavailable)/i;

function truncateBodySnippet(body: string): string {
  if (body.length <= ERROR_BODY_SNIPPET_LIMIT) {
    return body;
  }
  return `${body.slice(0, ERROR_BODY_SNIPPET_LIMIT)}…`;
}

export class LlmHttpError extends Error {
  constructor(public status: number, public bodySnippet: string) {
    super(`OpenAI-compatible provider returned ${status}: ${bodySnippet}`);
    this.name = 'LlmHttpError';
  }
}

export function stripFreeSuffix(model: string): string {
  const trimmedModel = model.trim();
  if (!FREE_SUFFIX_RE.test(trimmedModel)) {
    return trimmedModel;
  }
  return trimmedModel.slice(0, -':free'.length);
}

export interface FreeModelLapse {
  lapsed: boolean;
  http_status?: number;
  body_snippet?: string;
  lapsed_model?: string;
  proposed_paid_slug?: string;
}

export function classifyFreeModelLapse(err: unknown, model: string): FreeModelLapse {
  const trimmedModel = model.trim();
  if (!FREE_SUFFIX_RE.test(trimmedModel)) {
    return { lapsed: false };
  }
  if (!(err instanceof LlmHttpError)) {
    return { lapsed: false };
  }

  const bodySnippet = err.bodySnippet;
  const hasNoEndpoints = NO_ENDPOINTS_RE.test(bodySnippet);
  const bodySignalsUnavailable = hasNoEndpoints
    || NOT_A_VALID_MODEL_RE.test(bodySnippet)
    || MODEL_UNAVAILABLE_RE.test(bodySnippet);
  const isUnavailable = err.status === 404
    || bodySignalsUnavailable
    || (err.status === 400 && hasNoEndpoints);

  if (!isUnavailable) {
    return { lapsed: false };
  }

  return {
    lapsed: true,
    http_status: err.status,
    body_snippet: err.bodySnippet,
    lapsed_model: model,
    proposed_paid_slug: stripFreeSuffix(model),
  };
}

export class LlmEmptyResponseError extends Error {
  constructor(
    public finishReason: string | null,
    public completionTokens: number | undefined,
    public providerError: string | undefined,
  ) {
    super(
      `Empty response from OpenAI-compatible provider (finish_reason=${finishReason ?? 'none'} completion_tokens=${completionTokens ?? 'n/a'}${providerError ? ` error=${providerError}` : ''})`,
    );
    this.name = 'LlmEmptyResponseError';
  }
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err
      && typeof err === 'object'
      && 'name' in err
      && (err as { name?: string }).name === 'AbortError',
  );
}

function isRetryable(err: unknown): boolean {
  if (err instanceof LlmEmptyResponseError) {
    return true;
  }
  if (err instanceof LlmHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  if (isAbortError(err)) {
    return true;
  }
  if (err instanceof TypeError) {
    return true;
  }
  if (err instanceof Error) {
    return true;
  }
  return false;
}

function retryReason(err: unknown): string {
  if (err instanceof LlmEmptyResponseError) {
    return 'empty';
  }
  if (err instanceof LlmHttpError) {
    return `http_${err.status}`;
  }
  if (isAbortError(err)) {
    return 'timeout';
  }
  return 'network';
}

/**
 * Build the ordered list of response_format strategies to attempt.
 *
 * Providers disagree on what they accept:
 * - OpenRouter/OpenAI accept both `json_schema` and `json_object`.
 * - LM Studio / MiniMax accept `json_schema` (or `text`) but REJECT `json_object`
 *   with HTTP 400 ("'response_format.type' must be 'json_schema' or 'text'").
 * - With no constraint at all, weaker local models frequently emit an empty
 *   array, so a schema is strongly preferred when available.
 *
 * We therefore try the strongest available format first and degrade gracefully
 * only when the provider explicitly rejects the format.
 */
function buildFormatCascade(options?: LlmChatOptions): ResponseFormat[] {
  const cascade: ResponseFormat[] = [];
  if (options?.jsonSchema) {
    cascade.push({
      type: 'json_schema',
      json_schema: { name: options.jsonSchema.name, strict: true, schema: options.jsonSchema.schema },
    });
  }
  if (options?.jsonFormat || options?.jsonSchema) {
    cascade.push({ type: 'json_object' });
  }
  // Final fallback: no response_format, rely on the (already explicit) prompt.
  cascade.push(undefined);
  return cascade;
}

function isResponseFormatRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return lower.includes('response_format');
}

type StreamingChunk = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { code?: string | number; message?: string };
};

function extractStreamErrorMessage(payload: StreamingChunk): string | undefined {
  if (!payload.error) {
    return undefined;
  }
  if (typeof payload.error.message === 'string' && payload.error.message.trim().length > 0) {
    return payload.error.message;
  }
  return JSON.stringify(payload.error);
}

async function readSseChatCompletion(
  resp: Response,
  controller: AbortController,
  idleTimeoutMs: number,
): Promise<{ content: string; reasoningContent: string; finishReason: string | null; chunkCount: number; totalChars: number }> {
  if (!resp.body) {
    throw new LlmHttpError(resp.status, 'streaming response missing body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let idleTimeout: ReturnType<typeof setTimeout> | null = null;
  let idleReject: ((err: Error) => void) | null = null;

  const resetIdleGuard = () => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(() => {
      const err = new Error(`OpenAI-compatible streaming response idle for ${idleTimeoutMs}ms`);
      controller.abort();
      if (idleReject) {
        idleReject(err);
      }
    }, idleTimeoutMs);
  };

  let streamBuffer = '';
  let contentParts = '';
  let reasoningParts = '';
  let finishReason: string | null = null;
  let chunkCount = 0;
  let done = false;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(':')) {
      return;
    }
    if (!trimmed.startsWith('data:')) {
      return;
    }

    const payloadText = trimmed.slice('data:'.length).trim();
    if (payloadText.length === 0) {
      return;
    }
    if (payloadText === '[DONE]') {
      done = true;
      return;
    }

    let payload: StreamingChunk;
    try {
      payload = JSON.parse(payloadText) as StreamingChunk;
    } catch {
      throw new LlmHttpError(resp.status, truncateBodySnippet(payloadText));
    }

    const streamError = extractStreamErrorMessage(payload);
    if (streamError) {
      throw new LlmHttpError(resp.status, truncateBodySnippet(JSON.stringify(payload.error)));
    }

    const delta = payload.choices?.[0]?.delta;
    const chunkFinishReason = payload.choices?.[0]?.finish_reason;
    if (typeof chunkFinishReason === 'string' && chunkFinishReason.length > 0) {
      finishReason = chunkFinishReason;
    } else if (chunkFinishReason === null) {
      finishReason = null;
    }

    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      contentParts += delta.content;
    }
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      reasoningParts += delta.reasoning_content;
    }

    chunkCount += 1;
  };

  resetIdleGuard();

  try {
    while (!done) {
      const idlePromise: Promise<never> = new Promise((_, reject) => {
        idleReject = reject;
      });

      const readResult = await Promise.race<ReadableStreamReadResult<Uint8Array>>([
        reader.read(),
        idlePromise,
      ]);

      resetIdleGuard();
      idleReject = null;

      if (readResult.done) {
        break;
      }

      streamBuffer += decoder.decode(readResult.value, { stream: true });
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
        if (done) {
          break;
        }
      }
    }

    if (streamBuffer.length > 0 && !done) {
      processLine(streamBuffer);
    }

    return {
      content: contentParts,
      reasoningContent: reasoningParts,
      finishReason,
      chunkCount,
      totalChars: contentParts.length + reasoningParts.length,
    };
  } finally {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleReject = null;
    reader.releaseLock();
  }
}

export function createOpenAICompatibleProvider(baseUrl: string, model: string, apiKey: string): LlmProvider {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const provider: LlmProvider & { model: string } = {
    model,
    async chat(systemPrompt: string, userMessage: string, options?: LlmChatOptions): Promise<string> {
      const timeoutMs = options?.timeoutMs ?? 600000;
      const cascade = buildFormatCascade(options);
      const promptChars = systemPrompt.length + userMessage.length;
      const shouldUseStreaming = promptChars > STREAMING_PROMPT_CHAR_THRESHOLD;

      const runSingleAttempt = async (): Promise<string> => {
        let lastError: Error | null = null;
        for (let formatAttempt = 0; formatAttempt < cascade.length; formatAttempt += 1) {
          const responseFormat = cascade[formatAttempt];
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          const streamStart = Date.now();
          let streamChunks = 0;
          let streamChars = 0;
          let streamFinishReason: string | null = null;
          let streamOutcome: 'success' | 'empty' | 'error' = 'success';

          try {
            const reqBody: Record<string, unknown> = {
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
              ],
              temperature: options?.temperature ?? 0.2,
            };
            if (shouldUseStreaming) {
              reqBody.stream = true;
            }
            if (responseFormat) {
              reqBody.response_format = responseFormat;
            }

            const resp = await fetch(`${normalizedBaseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              signal: controller.signal,
              body: JSON.stringify(reqBody),
            });

            if (!resp.ok) {
              const errorBody = await resp.text();
              const requestError = new LlmHttpError(resp.status, truncateBodySnippet(errorBody));

              // If the provider rejected this specific response_format, degrade and retry.
              if (isResponseFormatRejection(resp.status, errorBody) && formatAttempt < cascade.length - 1) {
                lastError = requestError;
                continue;
              }
              throw requestError;
            }

            if (shouldUseStreaming) {
              const streamResult = await readSseChatCompletion(resp, controller, STREAMING_CHUNK_IDLE_TIMEOUT_MS);
              streamChunks = streamResult.chunkCount;
              streamChars = streamResult.totalChars;
              streamFinishReason = streamResult.finishReason;
              const streamResponseText = streamResult.content.trim().length > 0
                ? streamResult.content
                : streamResult.reasoningContent.trim().length > 0
                  ? streamResult.reasoningContent
                  : null;
              if (streamResponseText === null) {
                streamOutcome = 'empty';
                throw new LlmEmptyResponseError(
                  streamResult.finishReason,
                  streamResult.totalChars,
                  undefined,
                );
              }

              return streamResponseText;
            }

            const data = await resp.json() as {
              choices?: Array<{
                message?: { content?: string | null; reasoning_content?: string | null };
                finish_reason?: string | null;
              }>;
              error?: { code?: string | number; message?: string };
              usage?: { completion_tokens?: number };
            };
            const message = data.choices?.[0]?.message;
            const content = message?.content;
            const reasoningContent = message?.reasoning_content;
            const responseText = typeof content === 'string' && content.trim().length > 0
              ? content
              : typeof reasoningContent === 'string' && reasoningContent.trim().length > 0
                ? reasoningContent
                : null;
            if (responseText === null) {
              throw new LlmEmptyResponseError(
                data.choices?.[0]?.finish_reason ?? null,
                data.usage?.completion_tokens,
                data.error?.message,
              );
            }

            return responseText;
          } catch (err) {
            if (shouldUseStreaming) {
              streamOutcome = err instanceof LlmEmptyResponseError ? 'empty' : 'error';
            }
            throw err;
          } finally {
            clearTimeout(timeout);
            if (shouldUseStreaming) {
              logOp('extract', streamOutcome === 'success' ? 'info' : 'warn', {
                trace: options?.traceId,
                label: options?.logLabel,
                event: 'llm.stream',
                model,
                prompt_chars: promptChars,
                chunks: streamChunks,
                content_chars: streamChars,
                finish_reason: streamFinishReason,
                dur_ms: Date.now() - streamStart,
                outcome: streamOutcome,
              });
            }
          }
        }

        throw lastError ?? new Error('OpenAI-compatible provider failed to produce a response');
      };

      const maxAttempts = Math.max(1, options?.retry?.maxAttempts ?? 1);
      const backoffMs = options?.retry?.backoffMs ?? [];
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await runSingleAttempt();
        } catch (err) {
          lastError = err;
          if (!isRetryable(err) || attempt >= maxAttempts) {
            throw err;
          }

          const wait = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 600;
          logOp('extract', 'warn', {
            trace: options?.traceId,
            phase: 'llm_retry',
            label: options?.logLabel,
            model,
            attempt,
            max_attempts: maxAttempts,
            reason: retryReason(err),
            finish_reason: err instanceof LlmEmptyResponseError ? err.finishReason : undefined,
            status: err instanceof LlmHttpError ? err.status : undefined,
            backoff_ms: wait,
          });
          await delay(wait);
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };

  return provider;
}
