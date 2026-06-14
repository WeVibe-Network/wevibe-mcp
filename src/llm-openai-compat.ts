import type { LlmChatOptions, LlmProvider } from './llm.js';

type ResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }
  | { type: 'json_object' }
  | undefined;

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
      const timeoutMs = options?.timeoutMs ?? 300000;
      const cascade = buildFormatCascade(options);

      let lastError: Error | null = null;
      for (let attempt = 0; attempt < cascade.length; attempt++) {
        const responseFormat = cascade[attempt];
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
            // If the provider rejected this specific response_format, degrade and retry.
            if (isResponseFormatRejection(resp.status, errorBody) && attempt < cascade.length - 1) {
              lastError = new Error(`OpenAI-compatible provider returned ${resp.status}: ${errorBody}`);
              continue;
            }
            throw new Error(`OpenAI-compatible provider returned ${resp.status}: ${errorBody}`);
          }

          const data = await resp.json() as {
            choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
          };
          const message = data.choices?.[0]?.message;
          const content = message?.content;
          const reasoningContent = message?.reasoning_content;
          const responseText = typeof content === 'string' && content.trim().length > 0
            ? content
            : typeof reasoningContent === 'string' && reasoningContent.trim().length > 0
              ? reasoningContent
              : null;
          if (responseText === null) throw new Error('Empty response from OpenAI-compatible provider');

          return responseText;
        } finally {
          clearTimeout(timeout);
        }
      }

      throw lastError ?? new Error('OpenAI-compatible provider failed to produce a response');
    },
  };

  return provider;
}
