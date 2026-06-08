Output ONLY a JSON array. Each element has EXACTLY these keys and no others:
- "implement": string (REQUIRED) — what TO do and how, phrased as "<do this> because <reason or consequence>; applies when <condition>". Specific and actionable.
- "context": string — environment, versions, conditions where this applies. Reusable applicability only; never "during this session" or "for this task".
- "dnd": string or null — what NOT to do and the EXACT consequence (negative knowledge); null if there is no negative signal.
- "stack": array of lowercase strings — the specific technologies involved.
- "memory_type": string — always exactly "memory".
- "preference_confidence": number — EXACTLY one of 0.0, 0.2, 0.5, 0.8.
Do NOT output any other key. Do NOT output "extraction_hash" (the engine computes it). Do NOT output keywords.
Do NOT wrap the array in markdown code fences and do NOT add any prose before or after it.
Output the bare JSON array only. If nothing durable was learned, output exactly: []
