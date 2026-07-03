import { computeLocalEmbedding } from './embedding.js';
import { loadEmbeddingConfig } from './embedding-config.js';
import {
  buildRetrievalCard,
  type StructuredMemory,
} from './retrieval-card.js';

export async function embedRetrievalCard(
  structured: StructuredMemory,
): Promise<{ vector: number[]; cardText: string; embeddingModelId: string }> {
  const embeddingConfig = loadEmbeddingConfig();
  const cardText = buildRetrievalCard(structured);

  const vector = await computeLocalEmbedding(
    cardText,
    { role: 'document', prefix: true },
    embeddingConfig,
  );

  return { vector, cardText, embeddingModelId: embeddingConfig.model };
}
