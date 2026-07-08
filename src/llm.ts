/**
 * LLM provider abstraction for wevibe-mcp.
 *
 * All LLM calls (keyword extraction, memory extraction, re-ranking,
 * disambiguation) go through this interface.
 */

export interface LlmJsonSchema {
  /** Schema name (identifier passed to the provider). */
  name: string;
  /** A standard JSON Schema object describing the expected output. */
  schema: Record<string, unknown>;
}

export interface LlmRetryPolicy {
  /** Total attempts INCLUDING the first (1 = no retry). */
  maxAttempts: number;
  /** Backoff ms before attempt N+1, indexed [attempt-1]; last value reused if fewer entries. */
  backoffMs: number[];
}

export interface LlmChatOptions {
  temperature?: number;
  /**
   * Request JSON output. Providers enforce this differently:
   * - With `jsonSchema` present, grammar-constrained structured output is used
   *   (`response_format: json_schema`), which works on both OpenRouter and LM Studio.
   * - Without a schema, providers fall back to JSON mode (`response_format: json_object`),
   *   which OpenRouter/OpenAI accept but some local engines (LM Studio) reject.
   */
  jsonFormat?: boolean;
  /**
   * Optional JSON Schema for structured output. Strongly preferred over bare
   * `jsonFormat` because it is the only mode LM Studio/MiniMax accept AND it
   * makes output shape deterministic across providers.
   */
  jsonSchema?: LlmJsonSchema;
  timeoutMs?: number;
  /** Correlation id threaded from the caller for retry logging (header-derived; never signed body). */
  traceId?: string;
  /** Short label of the logical call site (e.g. "chunk-2", "tier1") for retry logs. */
  logLabel?: string;
  /**
   * Retry-with-reroute for transient remote failures (empty response, HTTP 429/5xx, network/timeout).
   * Omit (or set maxAttempts=1) to disable; required for local providers to avoid hammering local models.
   */
  retry?: LlmRetryPolicy;
  numCtx?: number;
}

export interface LlmProvider {
  /**
   * Send a chat completion request to the LLM.
   * Returns the text content of the response.
   * Throws on failure (timeout, unavailable, parse error).
   */
  chat(systemPrompt: string, userMessage: string, options?: LlmChatOptions): Promise<string>;
}
