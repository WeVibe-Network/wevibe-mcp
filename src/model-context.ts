import type { OpenRouterCatalog, OpenRouterModelEntry } from './openrouter-catalog.js';

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

function effectiveWindow(entry: OpenRouterModelEntry): number | undefined {
  const a = typeof entry.contextLength === 'number' && entry.contextLength > 0
    ? entry.contextLength
    : undefined;
  const b = typeof entry.topProviderContextLength === 'number' && entry.topProviderContextLength > 0
    ? entry.topProviderContextLength
    : undefined;
  if (a !== undefined && b !== undefined) {
    return Math.min(a, b);
  }
  return a ?? b;
}

export function resolveContextWindow(params: {
  slug: string | undefined;
  isLocal: boolean;
  numCtxHint?: number;
  catalog?: OpenRouterCatalog;
}): number {
  const {
    slug,
    isLocal,
    numCtxHint,
    catalog,
  } = params;

  if (isLocal) {
    // LOCAL (ollama/lm_studio): unchanged — use the num_ctx hint, else the safe default.
    if (typeof numCtxHint === 'number' && Number.isFinite(numCtxHint) && numCtxHint > 0) {
      return numCtxHint;
    }
    return DEFAULT_CONTEXT_WINDOW;
  }

  // REMOTE (OpenRouter): exact id match on the normalized slug; FAIL-CLOSED on miss.
  const entry = catalog?.get(normalizeSlug(slug ?? ''));
  if (!entry) {
    throw new ContextWindowResolutionError(slug ?? '(unknown)');
  }

  const eff = effectiveWindow(entry);
  if (eff === undefined || eff <= 0) {
    throw new ContextWindowResolutionError(slug ?? '(unknown)');
  }

  return eff;
}

export function resolveMaxOutputTokens(desiredReserveTokens: number, entry?: OpenRouterModelEntry): number {
  const cap = entry?.maxCompletionTokens;
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
    return Math.min(desiredReserveTokens, Math.floor(cap));
  }
  return desiredReserveTokens;
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
