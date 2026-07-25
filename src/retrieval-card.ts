const CONTEXT_MARKER = '\n\nContext: ';
const DND_MARKER = "\n\nDon't: ";

export interface StructuredMemory {
  implement: string;
  context: string;
  dnd: string | null;
  stack: string[];
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
  buildFailing?: boolean;
  testFailing?: boolean;
  files?: string[];
}

function csvOrUnknown(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'unknown';
}

function coerceStringArray(values: unknown): string[] {
  return Array.isArray(values) ? values.map((value) => String(value)) : [];
}

function failureState(value: boolean | undefined): 'failing' | 'ok' | 'unknown' {
  if (value === true) {
    return 'failing';
  }
  if (value === false) {
    return 'ok';
  }
  return 'unknown';
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
    `Build: ${failureState(h.buildFailing)}`,
    `Tests: ${failureState(h.testFailing)}`,
    `Files: ${csvOrUnknown(files)}`,
  ];

  return lines.join('\n');
}

/** INV-6: the SEMANTIC-PROSE core of the query for the DENSE embedding channel.
 * Intent + task prose ONLY — deterministically excludes the identifier soup
 * (stack/frameworks/deps/files/errors) which dilutes the dense vector and is
 * already carried by the keyword channel (dissect_to_keywords). Same input →
 * same output (D-RECALL-ALIGNMENT). */
export function buildPromptDigest(h: NeedHarvest): string {
  const intent = String(h.intent ?? '').replace(/\s+/g, ' ').trim();
  const task = String(h.task ?? '').replace(/\s+/g, ' ').trim();
  const segments: string[] = [];
  if (intent) segments.push(intent);
  if (task) segments.push(task);
  return segments.length > 0 ? segments.join('. ') : 'unknown';
}
