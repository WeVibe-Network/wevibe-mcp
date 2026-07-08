import type { LlmChatOptions, LlmProvider } from './llm.js';
import { logOp } from './logger.js';

type ResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }
  | { type: 'json_object' }
  | undefined;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ERROR_BODY_SNIPPET_LIMIT = 500;
const FREE_SUFFIX_RE = /:free$/i;
const NO_ENDPOINTS_RE = /no endpoints?/i;
const NOT_A_VALID_MODEL_RE = /not a valid model/i;
const MODEL_UNAVAILABLE_RE = /model .* (not found|unavailable)/i;

export const DEFAULT_LLM_TIMEOUT_MS = 600000;

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

export function createOpenAICompatibleProvider(baseUrl: string, model: string, apiKey: string): LlmProvider {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const provider: LlmProvider & { model: string } = {
    model,
    async chat(systemPrompt: string, userMessage: string, options?: LlmChatOptions): Promise<string> {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
      const cascade = buildFormatCascade(options);

      const runSingleAttempt = async (): Promise<string> => {
        let lastError: Error | null = null;
        for (let formatAttempt = 0; formatAttempt < cascade.length; formatAttempt += 1) {
          const responseFormat = cascade[formatAttempt];
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);

          try {
            const reqBody: Record<string, unknown> = {
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
              ],
              temperature: options?.temperature ?? 0.2,
            };
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
          } finally {
            clearTimeout(timeout);
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
