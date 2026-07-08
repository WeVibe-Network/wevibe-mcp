/**
 * Extraction budgeting bridges token windows (model limits) to transcript size (characters).
 *
 * We reserve 75% of the model context window for extraction input, then convert tokens ->
 * characters with a conservative chars/token constant so we under-fill and avoid overflow.
 */
// Conservative: truncation forensics measured ~3.7 chars/token on real code+prose
// transcripts. We use 3.5 so a token budget maps to slightly fewer chars and under-fills.
export const CHARS_PER_TOKEN = 3.5;
export const DEFAULT_CONTEXT_WINDOW = 32768; // safe fallback for local models without num_ctx hints
export const EXTRACTION_BUDGET_FRACTION = 0.75; // extraction input budget = 75% of context window

export function normalizeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (normalized.startsWith('openrouter/')) {
    return normalized.slice('openrouter/'.length);
  }
  return normalized;
}

export class ContextWindowResolutionError extends Error {
  readonly code = 'unknown_model_context';

  constructor(slug: string) {
    super(`unknown model context: ${slug} — could not resolve context window from the OpenRouter catalog (model absent or catalog unavailable)`);
    this.name = 'ContextWindowResolutionError';
  }
}

export function resolveContextWindow(params: {
  slug: string | undefined;
  isLocal: boolean;
  numCtxHint?: number;
  remoteMinWindow?: number; // pre-fetched min-across-providers window (undefined if model unknown)
}): number {
  const { slug, isLocal, numCtxHint, remoteMinWindow } = params;

  if (isLocal) {
    if (typeof numCtxHint === 'number' && Number.isFinite(numCtxHint) && numCtxHint > 0) return numCtxHint;
    return DEFAULT_CONTEXT_WINDOW;
  }
  // REMOTE: fail-closed on a missing/invalid min window — NEVER default to 32768.
  if (typeof remoteMinWindow === 'number' && Number.isFinite(remoteMinWindow) && remoteMinWindow > 0) {
    return remoteMinWindow;
  }
  throw new ContextWindowResolutionError(slug ?? '(unknown)');
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
  bufferChars: number,
): number {
  return budgetCharsValue - usedMemoriesChars - bufferChars;
}
