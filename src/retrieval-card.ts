import { ocrSanitize } from './ocr-sanitize.js';

const CONTEXT_MARKER = '\n\nContext: ';
const DND_MARKER = "\n\nDon't: ";

export interface StructuredMemory {
  implement: string;
  context: string;
  dnd: string | null;
  stack: string[];
}

export function serializeMemoryText(m: { implement: string; context?: string | null; dnd?: string | null }): string {
  const context = typeof m.context === 'string' ? m.context : '';
  const dnd = typeof m.dnd === 'string' ? m.dnd : '';
  return `${m.implement}${context ? `${CONTEXT_MARKER}${context}` : ''}${dnd ? `${DND_MARKER}${dnd}` : ''}`;
}

export function parseMemoryText(plaintext: string): { implement: string; context: string; dnd: string | null } {
  const raw = String(plaintext ?? '');
  const contextIndex = raw.indexOf(CONTEXT_MARKER);
  const dndIndex = raw.indexOf(DND_MARKER);

  let firstMarkerIndex = raw.length;
  if (contextIndex >= 0 && contextIndex < firstMarkerIndex) {
    firstMarkerIndex = contextIndex;
  }
  if (dndIndex >= 0 && dndIndex < firstMarkerIndex) {
    firstMarkerIndex = dndIndex;
  }

  const implement = raw.slice(0, firstMarkerIndex).trim();

  let context = '';
  if (contextIndex >= 0) {
    const contextStart = contextIndex + CONTEXT_MARKER.length;
    const contextEnd = dndIndex >= 0 && dndIndex > contextIndex ? dndIndex : raw.length;
    context = raw.slice(contextStart, contextEnd).trim();
  }

  const dnd = dndIndex >= 0 ? raw.slice(dndIndex + DND_MARKER.length).trim() : null;

  return { implement, context, dnd };
}

export function buildRetrievalCard(m: StructuredMemory): string {
  const context = typeof m?.context === 'string' ? m.context.trim() : '';
  const stack = Array.isArray(m?.stack)
    ? m.stack.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
  const implement = typeof m?.implement === 'string' ? m.implement.trim() : '';
  const dnd = typeof m?.dnd === 'string' ? m.dnd : null;

  const lines = [
    `Applies when: ${context || 'unspecified'}`,
    `Stack: ${stack.join(', ') || 'unknown'}`,
    `Implement: ${implement}`,
  ];

  if (dnd && dnd.trim()) {
    lines.push(`Avoid: ${dnd.trim()}`);
  }

  return lines.join('\n');
}

export interface NeedHarvest {
  intent?: string;
  task?: string;
  language?: string;
  stack?: string[];
  frameworks?: string[];
  deps?: string[];
  errorStrings?: string[];
  files?: string[];
}

function csvOrUnknown(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'unknown';
}

function coerceStringArray(values: unknown): string[] {
  return Array.isArray(values) ? values.map((value) => String(value)) : [];
}

export function buildNeedCard(h: NeedHarvest): string {
  const stack = coerceStringArray(h.stack);
  const frameworks = coerceStringArray(h.frameworks);
  const deps = coerceStringArray(h.deps);
  const errorStrings = coerceStringArray(h.errorStrings);
  const files = coerceStringArray(h.files);

  const lines = [
    `Intent: ${String(h.intent ?? 'unknown')}`,
    `Task: ${String(h.task ?? 'unknown')}`,
    `Language: ${String(h.language ?? 'unknown')}`,
    `Stack: ${csvOrUnknown(stack)}`,
    `Frameworks: ${csvOrUnknown(frameworks)}`,
    `Dependencies: ${csvOrUnknown(deps)}`,
    `Errors: ${csvOrUnknown(errorStrings)}`,
    `Files: ${csvOrUnknown(files)}`,
  ];

  return lines.join('\n');
}

const ANTICIPATED_NEED_SYSTEM_PROMPT = 'Write exactly one concise sentence describing the developer situation or question this memory answers. Return one plain line only.';

export async function buildAnticipatedNeed(
  m: StructuredMemory,
  chat: (system: string, user: string) => Promise<string>,
): Promise<string> {
  const user = [
    `Context: ${m?.context ?? ''}`,
    `Stack: ${Array.isArray(m?.stack) ? m.stack.join(', ') : ''}`,
    `Implement: ${m?.implement ?? ''}`,
    `Avoid: ${m?.dnd ?? ''}`,
  ].join('\n');

  const raw = await chat(ANTICIPATED_NEED_SYSTEM_PROMPT, user);
  const line = raw
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  return (line ?? raw.trim()).replace(/\s+/g, ' ').trim();
}

export function sanitizeForEmbedding(text: string): string {
  try {
    return ocrSanitize(text);
  } catch {
    return text;
  }
}
