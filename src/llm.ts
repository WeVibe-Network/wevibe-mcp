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
  maxTokens?: number;
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
