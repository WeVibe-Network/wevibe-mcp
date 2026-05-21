import { getStore } from './key-store.js';
import { getLlmProvider } from './llm.js';
import { computeLocalEmbedding } from './embedding.js';

export interface ClassifiedKeyword {
  keyword: string;
  weight: number;
}

export interface SuggestedKeyword {
  keyword: string;
  weight: number;
  rationale: string;
}

export interface KeywordExtractionResult {
  classified: ClassifiedKeyword[];
  suggestions: SuggestedKeyword[];
}

export type MemoryType = 'correct_implementation' | 'negative_signal';

const SERVICE = 'wevibe-network';

export interface MemoryCandidate {
  insight: string;
  context: string;
  avoid: string | null;
  stack: string[];
  memory_type: MemoryType;
  preference_confidence: number;
}

export interface ExtractionResult {
  memories: MemoryCandidate[];
}

export interface ProjectContext {
  name: string;
  stack: string[];
  directory: string;
}

const DEFAULT_EXTRACTION_PROMPT = `Extract individual technical insights from this session. Each insight must be a single, self-contained piece of knowledge that stands alone.

Rules:
- ONE insight per memory. If a session contains 5 different learnings, produce 5 separate memories.
- Each insight should be 1-2 sentences. Be specific: include exact values, directive names, configuration keys.
- Include the "context" field: what environment, versions, or conditions this insight applies to.
- Include "avoid" when there is negative knowledge: what NOT to do, and why. Negative knowledge is often more valuable than positive knowledge.
- Include "memory_type" and classify every memory as exactly one of:
  - "correct_implementation"
  - "negative_signal"
- Do NOT use any third category (for example: preference, convention, style, taste, or workflow choice).
- For each memory, also assess whether it represents a subjective preference rather than
  verifiable implementation knowledge or an observable negative signal.
  Rate "preference_confidence" from 0.0 to 1.0:
  - 0.0: Clearly factual/verifiable. "PostgreSQL uses MVCC for concurrency control."
  - 0.2-0.3: Organizational convention stated as fact. "This org uses Prettier with 2-space indent."
    These ARE valid memories — the convention is verifiable within the org.
  - 0.5: Ambiguous. "TypeScript strict mode is the way to go." Could be convention or opinion.
  - 0.7-0.8: Likely preference. "Functional components are better than class components."
    No org-specific qualifier, stated as general opinion.
  - 1.0: Pure preference. "I prefer dark mode." No technical substance.
  Important: organizational conventions (how THIS org does things) are NOT preferences.
  "We always use X" in the context of a specific org = convention = valid memory.
  "X is always better than Y" without org context = preference = flag it.
- Include "stack" with the specific technologies involved.
- Do NOT bundle multiple insights into a single memory.
- Do NOT produce generic advice. "Use connection pooling" is too vague. "Set PgBouncer default_pool_size to match PostgreSQL max_connections divided by app instance count" is specific.
- If the session contains no novel technical insights, return an empty array.

Output ONLY a JSON array:
[
  {
    "insight": "specific technical insight in 1-2 sentences",
    "context": "environment and conditions where this applies",
    "avoid": "what NOT to do and why, or null",
    "stack": ["technology1", "technology2"],
    "memory_type": "correct_implementation",
    "preference_confidence": 0.0
  }
]`;

function isMemoryType(value: unknown): value is MemoryCandidate['memory_type'] {
  return value === 'correct_implementation' || value === 'negative_signal';
}

function getExtractionPrompt(): string {
  return process.env.WEVIBE_EXTRACTION_PROMPT ?? DEFAULT_EXTRACTION_PROMPT;
}

export async function extractKeywords(
  plaintext: string,
  stackHint: string[],
  orgVocabulary: string[],
): Promise<KeywordExtractionResult> {
  const systemPrompt = `You are a keyword classifier for a software engineering knowledge base.

Given a technical memory, its technology stack, and an existing vocabulary, your job is to SELECT relevant keywords from the vocabulary and SUGGEST new keywords when appropriate.

CLASSIFICATION RULES:
- SELECT keywords from the vocabulary that are relevant to the memory
- Assign each keyword a relevancy weight (higher = more relevant). Weights will be normalized to sum to 1.0 across all classified keywords.
- Keywords with weight 0.0 should not be included

SUGGESTION RULES:
- Suggest NEW keywords that are NOT in the vocabulary
- Each suggestion must include a rationale explaining why it's valuable
- Suggested keywords must follow the pattern: lowercase letters, numbers, underscores only (^[a-z][a-z0-9_]{1,39}$)
- Suggested keywords should be useful for developers searching for this kind of knowledge

OUTPUT FORMAT:
Return a JSON object with two fields:
- "classified": array of { keyword: string, weight: number } — keywords SELECTED from vocabulary
- "suggestions": array of { keyword: string, weight: number, rationale: string } — new keywords suggested

Example output:
{
  "classified": [
    {"keyword": "kubernetes", "weight": 0.9},
    {"keyword": "deployment", "weight": 0.7}
  ],
  "suggestions": [
    {"keyword": "rolling_update", "weight": 0.5, "rationale": "Describes the deployment strategy used"}
  ]
}

Output ONLY valid JSON.`;

  const userMessage = `VOCABULARY:
${orgVocabulary.join('\n')}

STACK HINT: ${stackHint.join(', ')}

MEMORY:
${plaintext}`;

  const llm = getLlmProvider();
  const response = await llm.chat(systemPrompt, userMessage, {
    temperature: 0.2,
    jsonFormat: true,
    timeoutMs: 300000,
  });

  const parsed = JSON.parse(response) as KeywordExtractionResult;

  const vocabLower = orgVocabulary.map(v => v.toLowerCase());

  const classified = (parsed.classified ?? []).filter(c => {
    if (!vocabLower.includes(c.keyword.toLowerCase())) {
      console.warn(`extractKeywords: classified keyword "${c.keyword}" not in orgVocabulary, dropping`);
      return false;
    }
    return true;
  }).map(c => ({
    keyword: c.keyword.toLowerCase(),
    weight: Math.min(1.0, Math.max(0.0, c.weight)),
  }));

  const suggestionPattern = /^[a-z][a-z0-9_]{1,39}$/;
  const suggestions = (parsed.suggestions ?? []).filter(s => {
    if (vocabLower.includes(s.keyword.toLowerCase())) {
      console.warn(`extractKeywords: suggestion "${s.keyword}" already in orgVocabulary, dropping`);
      return false;
    }
    if (!suggestionPattern.test(s.keyword)) {
      console.warn(`extractKeywords: suggestion "${s.keyword}" fails pattern validation, dropping`);
      return false;
    }
    return true;
  }).map(s => ({
    keyword: s.keyword.toLowerCase(),
    weight: Math.min(1.0, Math.max(0.0, s.weight)),
    rationale: s.rationale,
  }));

  if (classified.length > 0) {
    const totalWeight = classified.reduce((sum, kw) => sum + kw.weight, 0);
    if (totalWeight > 0) {
      for (const kw of classified) {
        kw.weight = kw.weight / totalWeight;
      }
    }
  }

  if (suggestions.length > 0) {
    const totalSugWeight = suggestions.reduce((sum, kw) => sum + kw.weight, 0);
    if (totalSugWeight > 0) {
      for (const kw of suggestions) {
        kw.weight = kw.weight / totalSugWeight;
      }
    }
  }

  return { classified, suggestions };
}

export async function getConsentFlag(): Promise<boolean> {
  const store = getStore();
  const value = await store.getPassword(SERVICE, 'auto-contribute-consent');
  return value === 'true';
}

export async function setConsentFlag(consented: boolean): Promise<void> {
  const store = getStore();
  if (consented) {
    await store.setPassword(SERVICE, 'auto-contribute-consent', 'true');
  } else {
    await store.deletePassword(SERVICE, 'auto-contribute-consent');
  }
}

export async function extractMemories(
  rawBuffer: string,
  projectContext: ProjectContext,
): Promise<ExtractionResult> {
  const systemPrompt = getExtractionPrompt();

  const userMessage = `Project: ${projectContext.name}
Stack: ${projectContext.stack.join(', ') || 'unknown'}
Directory: ${projectContext.directory}

Session transcript:
${rawBuffer}`;

  try {
    const llm = getLlmProvider();
    const content = await llm.chat(systemPrompt, userMessage, {
      temperature: 0.3,
      jsonFormat: true,
      timeoutMs: 300000,
    });

    const parsed = JSON.parse(content) as unknown;

    if (!Array.isArray(parsed)) {
      console.warn('wevibe-mcp: extraction failed — invalid response schema');
      return { memories: [] };
    }

    const memories = parsed.filter((memory): memory is MemoryCandidate => {
      const memoryType = (memory as { memory_type?: unknown }).memory_type;
      if (!isMemoryType(memoryType)) {
        console.warn(`extraction: dropping memory with invalid memory_type "${String(memoryType)}"`);
        return false;
      }
      if (typeof (memory as { preference_confidence?: unknown }).preference_confidence !== 'number') {
        (memory as MemoryCandidate).preference_confidence = 0.0;
      }
      return true;
    });

    return { memories };
  } catch (e) {
    console.warn(`wevibe-mcp: extraction failed — ${e}`);
    return { memories: [] };
  }
}

export async function computeEmbedding(text: string): Promise<number[]> {
  return computeLocalEmbedding(text);
}
