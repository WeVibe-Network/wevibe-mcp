import { OLLAMA_EMBEDDING_HOST, EMBEDDING_MODEL } from './config.js';

const EXPECTED_DIM = 768;

function getOllamaHost(): string {
  return OLLAMA_EMBEDDING_HOST.replace(/\/$/, '');
}

function getEmbeddingModel(): string {
  return EMBEDDING_MODEL;
}

export async function computeLocalEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${getOllamaHost()}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: getEmbeddingModel(),
      prompt: text,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`ollama embeddings request failed (${response.status}): ${details}`);
  }

  const body = await response.json() as { embedding?: unknown };
  if (!Array.isArray(body.embedding)) {
    throw new Error('ollama embeddings response missing embedding array');
  }

  const embedding = body.embedding.map((value) => {
    if (typeof value !== 'number') {
      throw new Error('ollama embeddings response contains non-numeric values');
    }
    return value;
  });

  if (embedding.length !== EXPECTED_DIM) {
    throw new Error(
      `Embedding dimension mismatch: got ${embedding.length}, expected ${EXPECTED_DIM}. ` +
      `Model ${getEmbeddingModel()} may not match Qdrant collection expectations.`
    );
  }

  return embedding;
}
