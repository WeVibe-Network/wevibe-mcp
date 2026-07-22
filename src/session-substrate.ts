import { createHash } from 'node:crypto';

export interface SubstrateEvent {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'edit';
  time: number;
  seq: number;
  role?: string;
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  exit?: number | null;
  status?: string;
  error?: string;
  file?: string;
  detail?: string;
}

export interface SubstrateStats {
  user: number;
  assistant: number;
  reasoning: number;
  tool: number;
  edit: number;
  chars: number;
  fingerprint: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function roleOrAssistant(role: unknown): string {
  const normalized = asString(role);
  return normalized.length > 0 ? normalized : 'assistant';
}

function hashFirst8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

function renderTool(event: SubstrateEvent): string {
  const base = `[${roleOrAssistant(event.role)}:tool] ${asString(event.name)}(${asString(event.input)}) -> ${asString(event.output)}`;
  const markers: string[] = [];
  const hasNonZeroExit = typeof event.exit === 'number' && Number.isFinite(event.exit) && event.exit !== 0;
  const hasErrorStatus = event.status === 'error';

  if (hasNonZeroExit) {
    markers.push(`[exit=${event.exit}]`);
  }
  if (hasErrorStatus) {
    markers.push('[status=error]');
  }

  if (markers.length === 0) {
    return base;
  }

  const errorText = asString(event.error);
  return errorText.length > 0
    ? `${base} ${markers.join(' ')} ${errorText}`
    : `${base} ${markers.join(' ')}`;
}

function renderEvent(event: SubstrateEvent): string {
  switch (event.kind) {
    case 'user':
      return `[user] ${asString(event.text)}`;
    case 'assistant':
      return `[assistant] ${asString(event.text)}`;
    case 'reasoning':
      return `[${roleOrAssistant(event.role)}:reasoning] ${asString(event.text)}`;
    case 'tool':
      return renderTool(event);
    case 'edit': {
      const file = event.file === undefined || event.file === null ? '(unknown file)' : asString(event.file);
      return `[edit] ${file}: ${asString(event.detail)}`;
    }
  }
}

export function buildSessionSubstrate(events: SubstrateEvent[]): { text: string; stats: SubstrateStats } {
  const source = Array.isArray(events) ? events : [];
  const ordered = source
    .map((event, inputOrder) => ({ event, inputOrder }))
    .sort((left, right) => {
      if (left.event.time !== right.event.time) {
        return left.event.time - right.event.time;
      }
      if (left.event.seq !== right.event.seq) {
        return left.event.seq - right.event.seq;
      }
      return left.inputOrder - right.inputOrder;
    });

  const lines: string[] = [];
  const stats: SubstrateStats = {
    user: 0,
    assistant: 0,
    reasoning: 0,
    tool: 0,
    edit: 0,
    chars: 0,
    fingerprint: '',
  };

  for (const { event } of ordered) {
    lines.push(renderEvent(event));
    switch (event.kind) {
      case 'user':
        stats.user += 1;
        break;
      case 'assistant':
        stats.assistant += 1;
        break;
      case 'reasoning':
        stats.reasoning += 1;
        break;
      case 'tool':
        stats.tool += 1;
        break;
      case 'edit':
        stats.edit += 1;
        break;
    }
  }

  const text = lines.join('\n');
  stats.chars = text.length;
  stats.fingerprint = hashFirst8(text);

  return { text, stats };
}
