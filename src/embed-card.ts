import { computeLocalEmbedding } from './embedding.js';
import {
  buildAnticipatedNeed,
  buildRetrievalCard,
  sanitizeForEmbedding,
  type StructuredMemory,
} from './retrieval-card.js';

export type ChatAdapter = (system: string, user: string) => Promise<string>;

export async function embedRetrievalCard(
  structured: StructuredMemory,
  chat: ChatAdapter,
  opts: { strictAnticipated: boolean },
): Promise<{ vector: number[]; cardText: string }> {
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

  const vector = await computeLocalEmbedding(sanitizeForEmbedding(cardText), { role: 'document', prefix: true });

  return { vector, cardText };
}
