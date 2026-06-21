import { computeLocalEmbedding } from './embedding.js';
import { loadEmbeddingConfig } from './embedding-config.js';
import {
  buildAnticipatedNeed,
  buildRetrievalCard,
  type StructuredMemory,
} from './retrieval-card.js';

export type ChatAdapter = (system: string, user: string) => Promise<string>;

export async function embedRetrievalCard(
  structured: StructuredMemory,
  chat: ChatAdapter,
  opts: { strictAnticipated: boolean },
): Promise<{ vector: number[]; cardText: string; embeddingModelId: string }> {
  const embeddingConfig = loadEmbeddingConfig();
  const cardBase = buildRetrievalCard(structured);

  let anticipatedNeed = '';
  try {
    anticipatedNeed = await buildAnticipatedNeed(structured, chat);
  } catch (error) {
    if (opts.strictAnticipated) {
      throw error;
    }
  }

  const cardText = anticipatedNeed
    ? `${cardBase}\nAnticipated need: ${anticipatedNeed}`
    : cardBase;

  const vector = await computeLocalEmbedding(
    cardText,
    { role: 'document', prefix: true },
    embeddingConfig,
  );

  return { vector, cardText, embeddingModelId: embeddingConfig.model };
}
