/**
 * LLM provider abstraction for wevibe-mcp.
 *
 * All LLM calls (keyword extraction, memory extraction, re-ranking,
 * disambiguation) go through this interface. The concrete provider
 * is set once at startup. There is one provider. There are no fallbacks.
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

let _provider: LlmProvider | null = null;

/**
 * Set the global LLM provider. Called once at startup.
 * There is one provider. There are no fallbacks.
 */
export function setLlmProvider(provider: LlmProvider): void {
  _provider = provider;
}

/**
 * Get the global LLM provider.
 * Throws if not set — the system does not function without an LLM.
 */
export function getLlmProvider(): LlmProvider {
  if (!_provider) {
    throw new Error('LLM provider not configured. MCP sampling must be available.');
  }
  return _provider;
}

/**
 * Check if an LLM provider is configured.
 */
export function hasLlmProvider(): boolean {
  return _provider !== null;
}
