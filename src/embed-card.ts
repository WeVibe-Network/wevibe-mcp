import { computeLocalEmbedding } from './embedding.js';
import { loadEmbeddingConfig } from './embedding-config.js';
import { logOp, fp } from './logger.js';
import {
  buildRetrievalCard,
  type StructuredMemory,
} from './retrieval-card.js';

export async function embedRetrievalCard(
  structured: StructuredMemory,
): Promise<{ vector: number[]; cardText: string; embeddingModelId: string }> {
  const started = Date.now();
  let embeddingModelIdForLog: string | undefined;

  try {
    const embeddingConfig = loadEmbeddingConfig();
    const embeddingModelId = embeddingConfig.model;
    embeddingModelIdForLog = embeddingModelId;
    const cardText = buildRetrievalCard(structured);

    const vector = await computeLocalEmbedding(
      cardText,
      { role: 'document', prefix: true },
      embeddingConfig,
    );

    logOp('dashboard.embed', 'info', {
      status: 'ok',
      model_fp: fp(embeddingModelId),
      card_len: cardText.length,
      vector_dim: vector.length,
      dur_ms: Date.now() - started,
    });

    return { vector, cardText, embeddingModelId };
  } catch (e) {
    logOp('dashboard.embed', 'error', {
      status: 'err',
      model_fp: fp(embeddingModelIdForLog),
      dur_ms: Date.now() - started,
      err: (e as Error).message,
    });
    throw e;
  }
}
