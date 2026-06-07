import type { LlmChatOptions, LlmProvider } from './llm.js';

export function createOpenAICompatibleProvider(baseUrl: string, model: string, apiKey: string): LlmProvider {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const provider: LlmProvider & { model: string } = {
    model,
    async chat(systemPrompt: string, userMessage: string, options?: LlmChatOptions): Promise<string> {
      const timeoutMs = options?.timeoutMs ?? 300000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await fetch(`${normalizedBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            temperature: options?.temperature ?? 0.2,
            ...(options?.jsonFormat ? { response_format: { type: 'json_object' } } : {}),
          }),
        });

        if (!resp.ok) {
          const errorBody = await resp.text();
          throw new Error(`OpenAI-compatible provider returned ${resp.status}: ${errorBody}`);
        }

        const data = await resp.json() as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('Empty response from OpenAI-compatible provider');

        return content;
      } finally {
        clearTimeout(timeout);
      }
    },
  };

  return provider;
}
