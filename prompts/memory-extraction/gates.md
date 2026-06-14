HOW TO SELECT MEMORIES. Apply these gates to every candidate. Do the classification SILENTLY and FIRST; compose prose only for the survivors. Never output your reasoning, scores, or tags.

1. PROVENANCE (do this before composing anything). For each candidate insight, locate where it came from in the transcript and tag it:
   - ASSIGNED — it appears in the setup / work order / user instruction: something the worker was TOLD to do, stated with no in-session reason (e.g. "delete these IDs", "rename X to Y", "write the report to path P", "do not run git here").
   - LEARNED — it EMERGED during execution: a command failed, a constraint was hit, a correction happened, a discovery was made, OR an existing convention/invariant was uncovered that explains WHY an instruction exists.
   KEEP a candidate only if (a) it is LEARNED, or (b) an ASSIGNED instruction can be restated as the durable RULE it instantiates AND the transcript supplies the reason. If you cannot point to an in-session cause, DROP it.

2. RECALL VALUE (rate internally, never output). 0 = one-shot task parameter; 1 = recurs only if this exact artifact/list/path recurs; 2 = reusable for this repo/subsystem/tool/workflow; 3 = prevents data loss, security, corruption, or repeat-debugging, or captures a core invariant. Keep only recall value >= 2.

3. BECAUSE-TEST. Every "implement" must encode mechanism + justification: "<do this> because <causal reason or consequence>; applies when <condition>". If you cannot state a non-circular "because" grounded in the transcript, the candidate is an instruction, not a learning — DROP it.

4. SCOPED SPECIFICITY. Specificity must attach to the REUSABLE MECHANISM, never the one-off payload.
   KEEP: exact flags, versions, config keys, error strings, causal thresholds, directive names, commands.
   STRIP: session-instance identifiers — specific IDs to delete/keep, target file paths, report destinations, ticket/PR names, raw line numbers.
   TEST: mentally remove every instance-identifier; if nothing of reusable substance remains, the candidate was pure instruction — DROP it. Also DROP generic advice with no mechanism ("write tests", "use caching", "handle errors").

5. ABSTRACTION + GROUNDING. Generalize AT MOST one level above the transcript and preserve scope (this repo / this document / this tool / this workflow / this version). ALLOWED: "MASTER.md keeps open gaps only; resolved gaps move to implementation reports." NOT ALLOWED: "All teams should manage gap logs this way." A LEARNED generalization must be supported by a transcript span you could point to (a stated rule, an observed failure+fix, the final accepted implementation, or file/config/test content). Do NOT invent a "convention" from a single instruction that carries no stated reason.

6. WHEN AN INSTRUCTION IS DURABLE. A manager/work-order instruction is KEPT (restated as a rule) only if BOTH: (a) it carries a standing-rule signal — "always", "never", "policy", "convention", "invariant", "in this repo", "workers must", or it explains a reusable reason/consequence; AND (b) you can ground it (confirmed by an edit, a doc/config, or a stated reason). Otherwise it is one-shot task scope — DROP it.

7. dnd (negative knowledge) — only when DURABLE.
   - Mine failures actively: errors, regressions, silent failures, ordering hazards, resource thresholds, version-mismatch footguns, security anti-patterns. "It broke when…" moments are the highest-value targets.
   - A dnd must be SELF-CONTAINED: name the EXACT trigger AND EXACT consequence (not "avoid bad config" but "do not set worker_threads above 4 on a t2.micro or the OOM killer terminates node").
   - Pack the error string / symptom a future coder would search by into the dnd or implement text (there is no separate symptom field).
   - Pair every guardrail with the correct alternative in "implement" — UNLESS the transcript never demonstrated the fix; never fabricate an alternative.
   - dnd = null when there is no negative signal; do not force balance.
   - Provenance applies: "do not run git for THIS task" is ASSIGNED scope — DROP it; keep the durable footgun ("destructive git on a shared tree destroys uncommitted work irrecoverably").
   - NEVER broaden a scoped prohibition into a false universal; narrow it to its real reusable scope and consequence.
   - One hazard = one memory: keep the failure + its symptom + its fix together; do not split them across memories.

8. PREFERENCE (preference_confidence). Emit a number from 0.00 to 1.00, up to two decimal places.
   - CLOSER TO 0.00 = FACT — reproducible/measurable behavior, error code, API fact, OR an observed in-session failure. High confidence the knowledge is durable and verifiable.
   - MID-RANGE (e.g., 0.30–0.60) = MIXED/CONVENTION — blends substance with judgment; "THIS org/project/repo does X" conventions; subjective tradeoffs the contributor is flagging without claiming universal truth.
   - CLOSER TO 1.00 = TASTE — stylistic claim, personal preference, or weak technical justification. The contributor is signaling low confidence this guidance generalizes.
   Score SUBSTANCE not tone: a strongly-worded fact stays near 0; a hedged opinion with no verifiable core should be higher (≥0.60). NEVER emit pure taste (=1.00) — DROP candidates that are purely aesthetic with no technical core at all.

9. SECRETS / PII. Never extract API keys, tokens, passwords, private keys, session cookies, credentials, or personal emails/phones, and never lift secrets out of logs. Prefer repo-relative paths over user-specific absolute paths.

EXPECTED YIELD (calibration only — NOT a target; never pad to fill and never drop to hit a number):
   mechanical task / cleanup / checklist: usually 0–3 (often []);
   debugging / incident: usually 1–6;
   design / convention-setting: usually 1–5;
   implementation with discoveries: usually 1–6;
   mixed: apply the gates PER CANDIDATE.
   Returning [] is correct when nothing durable was learned. HARD MAX 10 (a backstop, not a quota): if more survive, emit the highest-ranked by data-loss/security/corruption prevention > failure+fix > stable convention > reusable technique > lower-risk process rule.
