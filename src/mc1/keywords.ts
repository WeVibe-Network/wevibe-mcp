export const KEYWORD_TERM_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const MAX_KEYWORDS_PER_MEMORY = 20;

/** Normalize one candidate term: trim, lowercase, validate pattern. Returns null if invalid. */
export function normalizeKeywordTerm(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!KEYWORD_TERM_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

/** The shared vocab-constraint convention (one file, two consumers).
 * Lowercases + validates each candidate, keeps only those present in `vocabulary`
 * (a term not in vocab is DROPPED — the write-side keyword gate), dedupes preserving
 * first-seen order, caps at MAX_KEYWORDS_PER_MEMORY. Empty result is valid (INV-7). */
export function constrainKeywordsToVocab(
  candidates: readonly string[],
  vocabulary: Iterable<string>,
): string[] {
  const normalizedVocabulary = new Set<string>();
  for (const entry of vocabulary) {
    const normalized = normalizeKeywordTerm(entry);
    if (normalized !== null) {
      normalizedVocabulary.add(normalized);
    }
  }

  const constrained: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (constrained.length >= MAX_KEYWORDS_PER_MEMORY) {
      break;
    }

    const normalized = normalizeKeywordTerm(candidate);
    if (normalized === null || !normalizedVocabulary.has(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    constrained.push(normalized);
  }

  return constrained;
}

/**
 * INV-7 org-domain-as-query-signal BOOST bridge (query side). Up-weights query keywords
 * whose normalized term is in the org's controlled vocabulary, and RENORMALIZES to sum≈1.
 * Boost-not-gate: out-of-vocab terms are KEPT (never dropped) — absent vocab match must
 * never exclude a memory. Reuses the SAME normalizeKeywordTerm + vocab-Set mechanism as
 * constrainKeywordsToVocab (the memory-side gate), but boosts instead of dropping.
 */
export function boostKeywordsByVocab(
  keywords: readonly { term: string; weight: number }[],
  vocabulary: Iterable<string>,
  boostFactor = 2,
): { term: string; weight: number }[] {
  const normalizedVocabulary = new Set<string>();
  for (const entry of vocabulary) {
    const normalized = normalizeKeywordTerm(entry);
    if (normalized !== null) {
      normalizedVocabulary.add(normalized);
    }
  }

  if (keywords.length === 0 || normalizedVocabulary.size === 0) {
    return keywords.map(kw => ({ ...kw }));
  }

  const boosted = keywords.map(kw => {
    const normalized = normalizeKeywordTerm(kw.term);
    const inVocab = normalized !== null && normalizedVocabulary.has(normalized);
    return { term: kw.term, weight: inVocab ? kw.weight * boostFactor : kw.weight };
  });

  const total = boosted.reduce((sum, kw) => sum + kw.weight, 0);
  if (total > 0) {
    for (const kw of boosted) {
      kw.weight = kw.weight / total;
    }
  }

  return boosted;
}
