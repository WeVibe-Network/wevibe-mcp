import {
  EMBEDDING_BASE_URL,
  EMBEDDING_API_KEY,
  EMBEDDING_MODEL,
  EMBEDDING_QUERY_PREFIX,
  EMBEDDING_DOCUMENT_PREFIX,
} from './config.js';
import type { ResolvedEmbeddingConfig } from './embedding-config.js';

export type EmbeddingRole = 'document' | 'query';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEmbeddingsEndpoint(): string {
  return `${EMBEDDING_BASE_URL.replace(/\/$/, '')}/embeddings`;
}

function getEmbeddingModel(): string {
  return EMBEDDING_MODEL;
}

export async function computeLocalEmbedding(
  text: string,
  opts?: { role?: EmbeddingRole; prefix?: boolean },
  config?: ResolvedEmbeddingConfig,
): Promise<number[]> {
  const shouldApplyPrefix = opts?.prefix === true && (config ? config.usePrefix : true);
  const prompt = shouldApplyPrefix
    ? `${opts.role === 'query' ? EMBEDDING_QUERY_PREFIX : EMBEDDING_DOCUMENT_PREFIX}${text}`
    : text;

  const endpoint = config
    ? `${config.baseUrl.replace(/\/$/, '')}/embeddings`
    : getEmbeddingsEndpoint();
  const apiKey = config?.apiKey ?? EMBEDDING_API_KEY;
  const model = config?.model ?? getEmbeddingModel();

  const maxAttempts = 3;
  const retryBackoffMs = [600, 1500];
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: prompt,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
      await delay(retryBackoffMs[attempt - 1]);
      continue;
    }

    if (!response.ok) {
      const details = await response.text();
      const requestError = new Error(
        `embeddings request failed at /v1/embeddings (${response.status}): ${details}`,
      );

      if (response.status !== 429 && response.status < 500) {
        throw requestError;
      }

      lastError = requestError;
      if (attempt === maxAttempts) {
        throw requestError;
      }
      await delay(retryBackoffMs[attempt - 1]);
      continue;
    }

    const body = await response.json() as { data?: unknown };
    const firstItem = Array.isArray(body.data) ? body.data[0] : undefined;
    const rawEmbedding =
      firstItem && typeof firstItem === 'object'
        ? (firstItem as { embedding?: unknown }).embedding
        : undefined;

    if (!Array.isArray(rawEmbedding)) {
      throw new Error('embeddings endpoint /v1/embeddings response missing data[0].embedding array');
    }

    const embedding = rawEmbedding.map((value) => {
      if (typeof value !== 'number') {
        throw new Error('embeddings endpoint /v1/embeddings response contains non-numeric values');
      }
      return value;
    });

    if (embedding.length === 0) {
      throw new Error('embeddings endpoint /v1/embeddings response missing data[0].embedding values');
    }

    return embedding;
  }

  throw lastError;
}
