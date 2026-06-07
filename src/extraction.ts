import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { getStore } from './key-store.js';
import { getLlmProvider, type LlmProvider } from './llm.js';
import { computeLocalEmbedding } from './embedding.js';
import type { MemoryType } from './types.js';

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

const SERVICE = 'wevibe-network';

export interface MemoryCandidate {
  implement: string;
  context: string;
  dnd: string | null;
  stack: string[];
  memory_type: MemoryType;
  preference_confidence: number;
  extraction_hash: string;
}

export interface ExtractionResult {
  memories: MemoryCandidate[];
}

export interface ProjectContext {
  name: string;
  stack: string[];
  directory: string;
}

export interface ExtractMemoriesOptions {
  provider?: LlmProvider;
  systemPrompt?: string;
  numCtx?: number;
}

const DEFAULT_EXTRACTION_PROMPT = `Extract individual technical implementation memories from this session. Each memory must be a single, self-contained piece of knowledge that stands alone.

Rules:
- ONE atomic insight per memory. If a session contains 5 different learnings, produce 5 separate memories.
- Be specific: include exact values, directive names, configuration keys, paths, and identifiers.
- "implement" (REQUIRED): what TO do and how — the correct, specific pattern.
- "dnd" (nullable): what NOT to do and why (negative knowledge), or null.
- Include the "context" field: what environment, versions, or conditions this memory applies to.
- Include "memory_type" and set every memory to exactly:
  - "memory"
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
  Higher preference_confidence signals LOWER-QUALITY/more-subjective knowledge that a human will weigh before committing — score honestly.
  Important: organizational conventions (how THIS org does things) are NOT preferences.
  "We always use X" in the context of a specific org = convention = valid memory.
  "X is always better than Y" without org context = preference = flag it.
- Include "stack" with the specific technologies involved.
- Do NOT bundle multiple insights into a single memory.
- Do NOT produce generic advice. "Use connection pooling" is too vague. "Set PgBouncer default_pool_size to match PostgreSQL max_connections divided by app instance count" is specific.
- If the session contains no novel technical insights, return an empty array.

Output ONLY a JSON array of objects with keys:
- implement
- context
- dnd
- stack
- memory_type (must be "memory")
- preference_confidence

Do not output any additional keys. Do not output extraction_hash; the engine computes it.

Example output:
[
  {
    "implement": "what TO do and how in 1-2 sentences",
    "context": "environment and conditions where this applies",
    "dnd": "what NOT to do and why, or null",
    "stack": ["technology1", "technology2"],
    "memory_type": "memory",
    "preference_confidence": 0.0
  }
]`;

function isMemoryType(value: unknown): value is MemoryCandidate['memory_type'] {
  return value === 'memory';
}

function getExtractionPrompt(): string {
  return process.env.WEVIBE_EXTRACTION_PROMPT ?? DEFAULT_EXTRACTION_PROMPT;
}

function coerceNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return null;
}

function computeExtractionHash(content: Pick<MemoryCandidate, 'implement' | 'context' | 'dnd' | 'stack'>): string {
  const canonicalInput: Record<string, unknown> = {
    implement: content.implement,
    context: content.context,
    dnd: content.dnd,
    stack: content.stack,
  };

  const canonicalOrdered = Object.keys(canonicalInput)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalInput[key];
      return acc;
    }, {});

  const canonicalJson = JSON.stringify(canonicalOrdered);
  return createHash('sha256').update(canonicalJson, 'utf-8').digest('hex');
}

function normalizeMemoryCandidate(memory: unknown): MemoryCandidate | null {
  if (memory === null || typeof memory !== 'object') {
    return null;
  }

  const record = memory as Record<string, unknown>;
  const memoryType = record.memory_type;
  if (!isMemoryType(memoryType)) {
    console.warn(`extraction: dropping memory with invalid memory_type "${String(memoryType)}"`);
    return null;
  }

  const implement = typeof record.implement === 'string'
    ? record.implement.trim()
    : '';

  if (implement.length === 0) {
    return null;
  }

  const context = typeof record.context === 'string' ? record.context : '';
  const dnd = coerceNullableString(record.dnd);
  const stack = Array.isArray(record.stack)
    ? record.stack.filter((item): item is string => typeof item === 'string')
    : [];
  const preferenceConfidence = typeof record.preference_confidence === 'number'
    ? record.preference_confidence
    : 0.0;

  return {
    implement,
    context,
    dnd,
    stack,
    memory_type: memoryType,
    preference_confidence: preferenceConfidence,
    extraction_hash: computeExtractionHash({
      implement,
      context,
      dnd,
      stack,
    }),
  };
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();

  const fencedMatch = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?[ \t]*\n?([\s\S]*?)\n?```$/);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const arrayStart = trimmed.indexOf('[');
  const objectStart = trimmed.indexOf('{');

  const arrayAppearsFirst = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
  if (arrayAppearsFirst) {
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayEnd !== -1 && arrayEnd > arrayStart) {
      return trimmed.slice(arrayStart, arrayEnd + 1).trim();
    }
  } else if (objectStart !== -1) {
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectEnd !== -1 && objectEnd > objectStart) {
      return trimmed.slice(objectStart, objectEnd + 1).trim();
    }
  }

  return trimmed;
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
  options: ExtractMemoriesOptions = {},
): Promise<ExtractionResult> {
  const systemPrompt = typeof options.systemPrompt === 'string' && options.systemPrompt.trim().length > 0
    ? options.systemPrompt
    : getExtractionPrompt();
  const numCtx = typeof options.numCtx === 'number' ? options.numCtx : 32768;
  let content: string | undefined;

  const userMessage = `Project: ${projectContext.name}
Stack: ${projectContext.stack.join(', ') || 'unknown'}
Directory: ${projectContext.directory}

Session transcript:
${rawBuffer}`;

  try {
    const llm = options.provider ?? getLlmProvider();
    const model = typeof (llm as { model?: unknown }).model === 'string'
      ? (llm as { model?: string }).model
      : undefined;
    content = await llm.chat(systemPrompt, userMessage, {
      temperature: 0.3,
      jsonFormat: true,
      timeoutMs: 300000,
      numCtx,
    });

    const jsonText = extractJsonText(content);
    const parsed = JSON.parse(jsonText) as unknown;

    let arr: unknown[] = [];
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed !== null && typeof parsed === 'object') {
      const parsedObject = parsed as Record<string, unknown>;
      const wrappedArray = ['memories', 'results', 'items']
        .map(key => parsedObject[key])
        .find(value => Array.isArray(value));

      if (Array.isArray(wrappedArray)) {
        arr = wrappedArray;
      } else if (typeof parsedObject.implement === 'string') {
        arr = [parsedObject];
      }
    }

    const memories = arr
      .map(memory => normalizeMemoryCandidate(memory))
      .filter((memory): memory is MemoryCandidate => memory !== null);

    try {
      const debugDir = `${homedir()}/.wevibe`;
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(
        `${debugDir}/last-extraction.json`,
        JSON.stringify({
          at: new Date().toISOString(),
          model,
          rawLength: content.length,
          raw: content.slice(0, 20000),
          normalizedCount: arr.length,
          keptCount: memories.length,
        }, null, 2),
        'utf8',
      );
    } catch {
      // best-effort debug logging only
    }

    if (memories.length === 0) {
      console.warn(`wevibe-mcp: extraction produced 0 memories (rawLen=${content.length}, normalized=${arr.length}); see ~/.wevibe/last-extraction.json`);
    }

    return { memories };
  } catch (e) {
    console.warn(`wevibe-mcp: extraction failed — ${e}`);
    try {
      const debugDir = `${homedir()}/.wevibe`;
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(
        `${debugDir}/last-extraction.json`,
        JSON.stringify({
          at: new Date().toISOString(),
          error: String(e),
          rawLength: typeof content === 'string' ? content.length : 0,
          raw: typeof content === 'string' ? content.slice(0, 20000) : '',
        }, null, 2),
        'utf8',
      );
    } catch {
      // best-effort debug logging only
    }
    if (options.provider) {
      throw e;
    }
    return { memories: [] };
  }
}

export async function computeEmbedding(text: string): Promise<number[]> {
  return computeLocalEmbedding(text);
}
