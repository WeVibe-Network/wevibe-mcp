import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from './key-store.js';
import { getLlmProvider, type LlmProvider } from './llm.js';
import { computeLocalEmbedding } from './embedding.js';
import { getRecommendedPreset } from './extraction-presets.js';
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
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

function readPrompt(relativePath: string): string {
  return readFileSync(join(PROMPTS_DIR, relativePath), 'utf8').replace(/\n$/, '');
}

const KEYWORD_EXTRACTION_PROMPT = readPrompt('keyword-extraction.md');

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

export const DEFAULT_EXTRACTION_PROMPT = getRecommendedPreset().system_prompt;

export const DEFAULT_EXTRACTION_NUM_CTX = 32768;

function isMemoryType(value: unknown): value is MemoryCandidate['memory_type'] {
  return value === 'memory';
}

export function getExtractionPrompt(): string {
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
  const systemPrompt = KEYWORD_EXTRACTION_PROMPT;

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
  const numCtx = typeof options.numCtx === 'number' ? options.numCtx : DEFAULT_EXTRACTION_NUM_CTX;
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
      temperature: 0.1,
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
