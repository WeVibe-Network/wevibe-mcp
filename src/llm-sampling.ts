/**
 * MCP sampling-based LLM provider.
 *
 * Uses the host agent's LLM via MCP's sampling/createMessage protocol.
 * The wevibe-mcp server requests a completion, the MCP client routes it
 * through whatever LLM the user's coding agent is connected to.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { LlmProvider, LlmChatOptions } from './llm.js';

export function createSamplingProvider(server: Server): LlmProvider {
  return {
    async chat(systemPrompt: string, userMessage: string, options?: LlmChatOptions): Promise<string> {
      const result = await server.createMessage({
        messages: [
          { role: 'user', content: { type: 'text', text: userMessage } },
        ],
        systemPrompt,
        maxTokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature,
        includeContext: 'none',
      });

      if (result.content.type === 'text') {
        return result.content.text;
      }

      throw new Error(`MCP sampling returned non-text content: ${result.content.type}`);
    },
  };
}
