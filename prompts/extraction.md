KEYWORD CONTRACT (applies to every emitted memory object)

Add a "keywords" array to each memory object while keeping all existing fields intact:
- "implement"
- "context"
- "dnd"
- "stack"
- "memory_type"
- "preference_confidence"

`keywords` must be a flat array of candidate keyword objects, ordered most-important-first. Assign each a relevancy weight in (0, 1] (higher = more relevant to this memory):
[
  { "keyword": "attestation", "weight": 0.9 },
  { "keyword": "provenance", "weight": 0.6 }
]

ORG CONTEXT (if provided):
- Use ORG CONTEXT as DIRECTIONAL BIAS only: when the session's actual content overlaps the org's domain or tech stack, prefer the org's canonical terms for those overlapping concepts so suggested keywords align with the org's vocabulary.
- Do NOT force unrelated session content to conform to the org's domain.
- NEVER invent keywords the transcript does not actually support. Faithfulness to the transcript always wins over alignment.

Rules:
- Emit 3-8 keywords when possible.
- Assign each keyword a relevancy weight in (0,1] (higher = more relevant). Weights need not sum to anything; they are normalized downstream. Do not emit zero or negative weights.
- Prefer single atomic canonical lowercase domain nouns.
- Keyword must match `^[a-z][a-z0-9_]{1,39}$`.
- Use underscores only (no spaces or hyphens), and allow at most ONE underscore only for genuine established terms of art.
- GOOD single-underscore terms of art: `hot_reload`, `rate_limit`, `cold_start`.
- NEVER coin multi-word underscore phrases.
- BAD (do-not-emit): `route_mismatch`, `startup_delay`, `post_wipe_recovery`, `identity_cache`, `weight_normalization`, `dashboard_deployment`.
- Elicitation frame only (never emit namespaces/prefixes): technology / problem-class / artifact / pattern / risk.
- Query-likelihood test: emit a term only if a future engineer would plausibly type that exact token when searching this domain.
- If a term names only this memory's thesis/argument/conclusion (not a reusable concept), drop it.
- Do NOT emit coined theses/slogans such as: `sota_laundering`, `false_rigor`, `staleness_fork`, `revocation_hole`, `attestation_laundering`, `per_field_provenance`.
- Prefer canonical reusable nouns those might gesture at (e.g. `attestation`, `provenance`, `tee`, `revocation`, `embedding`, `gamification`).
- Prefer reusing applicable terms from VOCABULARY; invent a new term only for a genuinely novel reusable concept.
- Do NOT split into classified/suggestions; emit only this flat candidate list.
