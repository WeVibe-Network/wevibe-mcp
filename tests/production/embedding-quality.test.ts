import { describe, it, expect } from 'vitest';
import { computeLocalEmbedding } from '../../src/embedding.js';

process.env.WEVIBE_EMBEDDING_BASE_URL ??= 'http://127.0.0.1:1234/v1';

const RUN_EMBEDDING_QUALITY_TESTS = process.env.RUN_EMBEDDING_QUALITY_TESTS === '1';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe.skipIf(!RUN_EMBEDDING_QUALITY_TESTS)('Embedding quality', () => {

  it('semantically similar texts have high cosine similarity (>0.7)', async () => {
    const a = await computeLocalEmbedding('How to configure Nginx as a reverse proxy');
    const b = await computeLocalEmbedding('Setting up Nginx reverse proxy configuration');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.7);
  }, 60000);

  it('semantically different texts have low cosine similarity (<0.4)', async () => {
    const a = await computeLocalEmbedding('Nginx reverse proxy configuration for file uploads');
    const b = await computeLocalEmbedding('How to bake a chocolate cake with frosting');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(0.4);
  }, 60000);

  it('domain-relevant query matches domain-relevant document', async () => {
    const query = await computeLocalEmbedding('SSH key management for Solana trading bots');
    const relevant = await computeLocalEmbedding('When deploying Solana trading bots on VPS, use SSH agent forwarding to avoid storing private keys on the server');
    const irrelevant = await computeLocalEmbedding('React useState hook for managing form validation state');
    
    const simRelevant = cosineSimilarity(query, relevant);
    const simIrrelevant = cosineSimilarity(query, irrelevant);
    
    expect(simRelevant).toBeGreaterThan(simIrrelevant);
  }, 60000);

  it('produces consistent vectors for the same input', async () => {
    const a = await computeLocalEmbedding('test query for consistency');
    const b = await computeLocalEmbedding('test query for consistency');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.999);
  }, 60000);

  it('produces 3072-dimensional vectors', async () => {
    const vec = await computeLocalEmbedding('dimension check');
    expect(vec).toHaveLength(3072);
  }, 60000);
});
