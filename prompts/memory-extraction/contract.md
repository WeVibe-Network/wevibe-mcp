Output ONLY a JSON array. Each element is one memory object with these keys:
- "implement": string (REQUIRED) — what TO do and how, phrased as "<do this> because <reason or consequence>; applies when <condition>". Specific and actionable.
- "context": string — environment, versions, conditions where this applies. Reusable applicability only; never "during this session" or "for this task".
- "dnd": string or null — what NOT to do and the EXACT consequence (negative knowledge); null if there is no negative signal.
- "stack": array of lowercase strings — the specific technologies involved.
- "memory_type": string — always exactly "memory".
- "preference_confidence": number — a value from 0.00 to 1.00 (up to two decimal places). Lower = more factual/durable; higher = more taste/subjective.
- "keywords": array (REQUIRED) — follow the KEYWORD CONTRACT supplied in the user message: a flat, rank-ordered array of {"keyword": "..."} objects.
Do NOT output any other key. Do NOT output "extraction_hash" (the engine computes it).
Do NOT wrap the array in markdown code fences and do NOT add any prose before or after it.
Output the bare JSON array only. If nothing durable was learned, output exactly: []
