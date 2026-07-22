import { describe, it, expect } from 'vitest';

import { buildSessionSubstrate, type SubstrateEvent } from '../src/session-substrate.js';

describe('session-substrate', () => {
  it('renders all five event kinds in canonical substrate format', () => {
    const events: SubstrateEvent[] = [
      { kind: 'user', time: 1, seq: 0, text: 'need extraction fidelity' },
      { kind: 'assistant', time: 2, seq: 0, text: 'acknowledged' },
      { kind: 'reasoning', time: 3, seq: 0, text: 'plan the extraction path' },
      { kind: 'tool', time: 4, seq: 0, name: 'npm test', input: '--runInBand', output: 'PASS' },
      { kind: 'edit', time: 5, seq: 0, file: 'src/http-server.ts', detail: '+ build substrate' },
    ];

    const result = buildSessionSubstrate(events);
    expect(result.text).toBe([
      '[user] need extraction fidelity',
      '[assistant] acknowledged',
      '[assistant:reasoning] plan the extraction path',
      '[assistant:tool] npm test(--runInBand) -> PASS',
      '[edit] src/http-server.ts: + build substrate',
    ].join('\n'));
  });

  it('orders by time+seq deterministically and keeps tied keys stable by input order', () => {
    const firstInput: SubstrateEvent[] = [
      { kind: 'assistant', time: 30, seq: 0, text: 'third' },
      { kind: 'user', time: 10, seq: 2, text: 'second' },
      { kind: 'user', time: 10, seq: 1, text: 'first' },
    ];
    const secondInput: SubstrateEvent[] = [
      { kind: 'user', time: 10, seq: 1, text: 'first' },
      { kind: 'assistant', time: 30, seq: 0, text: 'third' },
      { kind: 'user', time: 10, seq: 2, text: 'second' },
    ];

    const first = buildSessionSubstrate(firstInput);
    const second = buildSessionSubstrate(secondInput);
    const expected = [
      '[user] first',
      '[user] second',
      '[assistant] third',
    ].join('\n');

    expect(first.text).toBe(expected);
    expect(second.text).toBe(expected);
    expect(first.stats.fingerprint).toBe(second.stats.fingerprint);
    expect(first.stats.fingerprint).toBe(buildSessionSubstrate(firstInput).stats.fingerprint);

    const tied = buildSessionSubstrate([
      { kind: 'user', time: 99, seq: 7, text: 'tie-a' },
      { kind: 'assistant', time: 99, seq: 7, text: 'tie-b' },
    ]);
    expect(tied.text).toBe('[user] tie-a\n[assistant] tie-b');
  });

  it('renders tool error markers for status=error and non-zero exit', () => {
    const result = buildSessionSubstrate([
      {
        kind: 'tool',
        time: 1,
        seq: 0,
        name: 'bash',
        input: 'ls',
        output: 'permission denied',
        exit: 17,
        status: 'error',
        error: 'stderr: EACCES',
      },
    ]);

    expect(result.text).toBe('[assistant:tool] bash(ls) -> permission denied [exit=17] [status=error] stderr: EACCES');
  });

  it('never caps tool output payloads', () => {
    const output = 'x'.repeat(5001);
    const result = buildSessionSubstrate([
      {
        kind: 'tool',
        time: 1,
        seq: 0,
        name: 'cat',
        output,
      },
    ]);

    expect(result.text).toBe(`[assistant:tool] cat() -> ${output}`);
    expect(result.text.endsWith(output)).toBe(true);
  });

  it('returns empty text and zeroed stats for an empty stream', () => {
    const result = buildSessionSubstrate([]);

    expect(result.text).toBe('');
    expect(result.stats).toEqual({
      user: 0,
      assistant: 0,
      reasoning: 0,
      tool: 0,
      edit: 0,
      chars: 0,
      fingerprint: 'e3b0c442',
    });
  });

  it('reports per-kind counts and char totals from composed text', () => {
    const result = buildSessionSubstrate([
      { kind: 'user', time: 1, seq: 0, text: 'u1' },
      { kind: 'assistant', time: 2, seq: 0, text: 'a1' },
      { kind: 'reasoning', time: 3, seq: 0, text: 'r1' },
      { kind: 'tool', time: 4, seq: 0, name: 't1', input: 'in', output: 'out' },
      { kind: 'edit', time: 5, seq: 0, detail: 'd1' },
      { kind: 'user', time: 6, seq: 0, text: 'u2' },
    ]);

    expect(result.stats.user).toBe(2);
    expect(result.stats.assistant).toBe(1);
    expect(result.stats.reasoning).toBe(1);
    expect(result.stats.tool).toBe(1);
    expect(result.stats.edit).toBe(1);
    expect(result.stats.chars).toBe(result.text.length);
  });
});
