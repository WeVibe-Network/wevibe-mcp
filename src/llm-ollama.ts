/**
 * Ollama-based LLM provider for the admin CLI context.
 *
 * The admin CLI runs outside the MCP server context and uses Ollama directly
 * for keyword extraction during moderation approval.
 */

import type { LlmProvider, LlmChatOptions } from './llm.js';

export function createOllamaProvider(ollamaUrl: string, model: string): LlmProvider {
  const provider: LlmProvider & { model: string } = {
    model,
    async chat(systemPrompt: string, userMessage: string, options?: LlmChatOptions): Promise<string> {
      const resp = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(options?.timeoutMs ?? 300000),
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: false,
          options: {
            temperature: options?.temperature ?? 0.2,
            ...(options?.numCtx ? { num_ctx: options.numCtx } : {}),
          },
          format: options?.jsonFormat ? 'json' : undefined,
          think: false,
        }),
      });

      if (!resp.ok) throw new Error(`Ollama returned ${resp.status}`);

      const data = await resp.json() as { message?: { content?: string } };
      if (!data.message?.content) throw new Error('Empty response from Ollama');

      return data.message.content;
    },
  };

  return provider;
}
