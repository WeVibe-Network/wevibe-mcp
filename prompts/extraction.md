KEYWORD CONTRACT (applies to every emitted memory object)

Add a "keywords" array to each memory object while keeping all existing fields intact:
- "implement"
- "context"
- "dnd"
- "stack"
- "memory_type"
- "preference_confidence"

`keywords` must be a flat RANKED array of candidate keyword objects, most important first (array order is rank):
[
  { "keyword": "attestation" },
  { "keyword": "provenance" }
]

Rules:
- Emit 3-8 keywords when possible.
- Do NOT output weights. A `weight` field may appear but is ignored downstream.
- Keyword must be a single atomic canonical lowercase domain noun matching `^[a-z][a-z0-9_]{1,39}$`.
- Use underscores only (no spaces or hyphens).
- Elicitation frame only (never emit namespaces/prefixes): technology / problem-class / artifact / pattern / risk.
- Query-likelihood test: emit a term only if a future engineer would plausibly type that exact token when searching this domain.
- If a term names only this memory's thesis/argument/conclusion (not a reusable concept), drop it.
- Do NOT emit coined theses/slogans such as: `sota_laundering`, `false_rigor`, `staleness_fork`, `revocation_hole`, `attestation_laundering`, `per_field_provenance`.
- Prefer canonical reusable nouns those might gesture at (e.g. `attestation`, `provenance`, `tee`, `revocation`, `embedding`, `gamification`).
- Prefer reusing applicable terms from VOCABULARY; invent a new term only for a genuinely novel reusable concept.
- Do NOT split into classified/suggestions; emit only this flat candidate list.
