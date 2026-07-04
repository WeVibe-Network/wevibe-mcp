/**
 * Extraction budgeting bridges token windows (model limits) to transcript size (characters).
 *
 * We reserve 75% of the model context window for extraction input, then convert tokens ->
 * characters with a conservative chars/token constant so we under-fill and avoid overflow.
 * Budget accounting has two blocks:
 * - A: shared used memories already selected for this request.
 * - B: intra-session extracted text from prior chunks (accumulated) when chunking.
 */
// Conservative: truncation forensics measured ~3.7 chars/token on real code+prose
// transcripts. We use 3.5 so a token budget maps to slightly fewer chars and under-fills.
export const CHARS_PER_TOKEN = 3.5;
export const DEFAULT_CONTEXT_WINDOW = 32768; // safe fallback for unknown models (prior DEFAULT_EXTRACTION_NUM_CTX)
export const EXTRACTION_BUDGET_FRACTION = 0.75; // extraction input budget = 75% of context window

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic Claude Opus/Sonnet published at 200k context.
  'anthropic/claude-opus': 200000,
  'anthropic/claude-sonnet': 200000,

  // OpenAI GPT-5 family (including Codex variants) published at 400k context.
  'openai/gpt-5': 400000,

  // Google Gemini 2.5 Pro / Gemini 3 Pro published at 1M context.
  'google/gemini-2.5-pro': 1000000,
  'google/gemini-3-pro': 1000000,

  // Z-AI GLM 5.x family conservatively treated as 200k context.
  'z-ai/glm-5': 200000,

  // MiniMax M3 conservatively pinned to 200k when 1M claims are uncertain.
  'minimax/m3': 200000,
  'minimax/minimax-m3': 200000,

  // DeepSeek V3/R1 published at 128k context.
  'deepseek/deepseek-v3': 128000,
  'deepseek/deepseek-r1': 128000,

  // Qwen family conservatively pinned to 32,768 context.
  'qwen/qwen': 32768,
};

const MODEL_CONTEXT_PREFIXES = Object.keys(MODEL_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length);

export function normalizeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (normalized.startsWith('openrouter/')) {
    return normalized.slice('openrouter/'.length);
  }
  return normalized;
}

export function resolveContextWindow(slug: string | undefined, numCtxHint?: number): number {
  const normalized = normalizeSlug(slug ?? '');

  for (const key of MODEL_CONTEXT_PREFIXES) {
    if (normalized.startsWith(key)) {
      return MODEL_CONTEXT_WINDOWS[key];
    }
  }

  if (typeof numCtxHint === 'number' && Number.isFinite(numCtxHint) && numCtxHint > 0) {
    return numCtxHint;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

export function budgetChars(contextWindowTokens: number): number {
  return Math.floor(EXTRACTION_BUDGET_FRACTION * contextWindowTokens * CHARS_PER_TOKEN);
}

export function fitsSinglePass(
  transcriptChars: number,
  usedMemoriesChars: number,
  bufferChars: number,
  budgetCharsValue: number,
): boolean {
  return transcriptChars + usedMemoriesChars + bufferChars <= budgetCharsValue;
}

export function chunkRoomChars(
  budgetCharsValue: number,
  usedMemoriesChars: number,
  accumulatedExtractedChars: number,
  bufferChars: number,
): number {
  return budgetCharsValue - usedMemoriesChars - accumulatedExtractedChars - bufferChars;
}
