/**
 * LLM provider abstraction for wevibe-mcp.
 *
 * All LLM calls (keyword extraction, memory extraction, re-ranking,
 * disambiguation) go through this interface. The concrete provider
 * is set once at startup. There is one provider. There are no fallbacks.
 */

export interface LlmChatOptions {
  temperature?: number;
  jsonFormat?: boolean;
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
