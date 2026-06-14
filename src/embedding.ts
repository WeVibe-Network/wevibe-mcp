import {
  EMBEDDING_BASE_URL,
  EMBEDDING_API_KEY,
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  EMBEDDING_QUERY_PREFIX,
  EMBEDDING_DOCUMENT_PREFIX,
} from './config.js';

const EXPECTED_DIM = EMBEDDING_DIM;

export type EmbeddingRole = 'document' | 'query';

function getEmbeddingsEndpoint(): string {
  return `${EMBEDDING_BASE_URL.replace(/\/$/, '')}/embeddings`;
}

function getEmbeddingModel(): string {
  return EMBEDDING_MODEL;
}

export async function computeLocalEmbedding(
  text: string,
  opts?: { role?: EmbeddingRole; prefix?: boolean },
): Promise<number[]> {
  const prompt = opts?.prefix === true
    ? `${opts.role === 'query' ? EMBEDDING_QUERY_PREFIX : EMBEDDING_DOCUMENT_PREFIX}${text}`
    : text;

  const endpoint = getEmbeddingsEndpoint();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({
      model: getEmbeddingModel(),
      input: prompt,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`embeddings request failed at /v1/embeddings (${response.status}): ${details}`);
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

  if (embedding.length !== EXPECTED_DIM) {
    throw new Error(
      `Embedding dimension mismatch from /v1/embeddings: got ${embedding.length}, expected ${EXPECTED_DIM}. ` +
      `Model ${getEmbeddingModel()} may not match Qdrant collection expectations.`
    );
  }

  return embedding;
}
