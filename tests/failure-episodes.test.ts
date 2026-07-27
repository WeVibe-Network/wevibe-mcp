import { beforeEach, describe, expect, it, vi } from 'vitest';

const readUsedMemoryTextsMock = vi.hoisted(() => vi.fn<(sessionId: string) => string[]>());

vi.mock('../src/served-memory-store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/served-memory-store.js')>('../src/served-memory-store.js');
  return {
    ...actual,
    readUsedMemoryTexts: readUsedMemoryTextsMock,
  };
});

import { extractMemories } from '../src/extraction.js';
import { renderFailureEpisodeBlock, segmentFailureEpisodes } from '../src/failure-episodes.js';
import type { SubstrateEvent } from '../src/session-substrate.js';
import type { LlmChatOptions, LlmProvider } from '../src/llm.js';

function createMockLlmProvider(
  chatFn: (sys: string, user: string, options?: LlmChatOptions) => string | Promise<string>,
): LlmProvider {
  return {
    chat: async (systemPrompt: string, userMessage: string, options?: LlmChatOptions) => {
      return chatFn(systemPrompt, userMessage, options);
    },
  };
}

describe('failure episodes', () => {
  beforeEach(() => {
    readUsedMemoryTextsMock.mockReset();
    readUsedMemoryTextsMock.mockReturnValue([]);
  });

  it('segments a resolved test failure episode with full intervening edits and validation evidence', () => {
    const events: SubstrateEvent[] = [
      { kind: 'tool', time: 1, seq: 0, name: 'npm test', input: 'npm test', output: 'FAIL src/app.test.ts', exit: 1, status: 'completed' },
      { kind: 'edit', time: 2, seq: 0, file: 'src/app.ts', detail: 'attempt 1' },
      { kind: 'edit', time: 3, seq: 0, file: 'src/util.ts', detail: 'attempt 2' },
      { kind: 'tool', time: 4, seq: 0, name: 'npm test', input: 'npm test', output: 'PASS src/app.test.ts', exit: 0, status: 'completed' },
    ];

    const episodes = segmentFailureEpisodes(events);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: 'ep-0',
      signal: {
        kind: 'test_failure',
        checkKey: 'test:npm test',
      },
      resolution: 'resolved',
      validationIndex: 3,
    });
    expect(episodes[0]?.attemptEdits).toEqual([
      { eventIndex: 1, file: 'src/app.ts' },
      { eventIndex: 2, file: 'src/util.ts' },
    ]);
    expect(episodes[0]?.validationExcerpt).toContain('PASS');
  });

  it('segments an unresolved command failure and renders a dnd-only negative-knowledge candidate', () => {
    const events: SubstrateEvent[] = [
      { kind: 'tool', time: 1, seq: 0, name: 'bash', input: 'go build ./...', output: 'build is broken', exit: 1, status: 'completed' },
      { kind: 'edit', time: 2, seq: 0, file: 'src/main.go', detail: 'attempt fix' },
    ];

    const episodes = segmentFailureEpisodes(events);
    const block = renderFailureEpisodeBlock(episodes, events);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.signal.checkKey).toBe('cmd:go');
    expect(episodes[0]?.resolution).toBe('unresolved');
    expect(block).toContain('NEGATIVE-KNOWLEDGE CANDIDATE (dnd-only)');
    expect(block).toContain('unresolved');
  });

  it('handles multiple interleaved check keys and resolves each by its own pass while sharing overlapping edits', () => {
    const events: SubstrateEvent[] = [
      { kind: 'tool', time: 1, seq: 0, name: 'npm test', input: 'npm test', output: 'FAIL suite', exit: 1, status: 'completed' },
      { kind: 'edit', time: 2, seq: 0, file: 'src/a.ts', detail: 'first attempt' },
      { kind: 'tool', time: 3, seq: 0, name: 'bash', input: 'go test ./...', output: 'command failed', exit: 1, status: 'completed' },
      { kind: 'edit', time: 4, seq: 0, file: 'src/shared.ts', detail: 'shared attempt' },
      { kind: 'tool', time: 5, seq: 0, name: 'bash', input: 'go test ./...', output: 'ok', exit: 0, status: 'completed' },
      { kind: 'edit', time: 6, seq: 0, file: 'src/post-go.ts', detail: 'more changes for npm test' },
      { kind: 'tool', time: 7, seq: 0, name: 'npm test', input: 'npm test', output: 'PASS suite', exit: 0, status: 'completed' },
    ];

    const episodes = segmentFailureEpisodes(events);

    expect(episodes).toHaveLength(2);
    const npmEpisode = episodes.find(episode => episode.signal.checkKey === 'test:npm test');
    const goEpisode = episodes.find(episode => episode.signal.checkKey === 'cmd:go');
    expect(npmEpisode?.resolution).toBe('resolved');
    expect(goEpisode?.resolution).toBe('resolved');
    expect(npmEpisode?.validationIndex).toBe(6);
    expect(goEpisode?.validationIndex).toBe(4);
    expect(npmEpisode?.attemptEdits.map(edit => edit.eventIndex)).toEqual([1, 3, 5]);
    expect(goEpisode?.attemptEdits.map(edit => edit.eventIndex)).toEqual([3]);
  });

  it('marks a resolved-without-edits episode as coincidental and discloses it in rendered evidence', () => {
    const events: SubstrateEvent[] = [
      { kind: 'tool', time: 1, seq: 0, name: 'bash', input: 'make test', output: 'make failed', exit: 2, status: 'completed' },
      { kind: 'tool', time: 2, seq: 0, name: 'bash', input: 'make test', output: 'all good', exit: 0, status: 'completed' },
    ];

    const episodes = segmentFailureEpisodes(events);
    const block = renderFailureEpisodeBlock(episodes, events);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.resolution).toBe('coincidental');
    expect(episodes[0]?.attemptEdits).toEqual([]);
    expect(block).toContain('COINCIDENTAL-FLIP DISCLOSURE');
  });

  it('returns no episodes and no evidence block for clean sessions', () => {
    const events: SubstrateEvent[] = [
      { kind: 'user', time: 1, seq: 0, text: 'please run checks' },
      { kind: 'tool', time: 2, seq: 0, name: 'npm test', input: 'npm test', output: 'PASS', exit: 0, status: 'completed' },
      { kind: 'assistant', time: 3, seq: 0, text: 'all clear' },
    ];

    const episodes = segmentFailureEpisodes(events);
    const block = renderFailureEpisodeBlock(episodes, events);

    expect(episodes).toHaveLength(0);
    expect(block).toBe('');
  });

  it('merges same-checkkey re-failures while open instead of creating duplicates', () => {
    const events: SubstrateEvent[] = [
      { kind: 'tool', time: 1, seq: 0, name: 'bash', input: 'npm run build', output: 'build failed', exit: 1, status: 'completed' },
      { kind: 'edit', time: 2, seq: 0, file: 'src/first.ts', detail: 'first fix attempt' },
      { kind: 'tool', time: 3, seq: 0, name: 'bash', input: 'npm run build', output: 'build still broken', exit: 1, status: 'completed' },
      { kind: 'edit', time: 4, seq: 0, file: 'src/second.ts', detail: 'second fix attempt' },
      { kind: 'tool', time: 5, seq: 0, name: 'bash', input: 'npm run build', output: 'build ok', exit: 0, status: 'completed' },
    ];

    const episodes = segmentFailureEpisodes(events);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.id).toBe('ep-2');
    expect(episodes[0]?.signal.eventIndex).toBe(2);
    expect(episodes[0]?.resolution).toBe('resolved');
    expect(episodes[0]?.attemptEdits).toEqual([{ eventIndex: 3, file: 'src/second.ts' }]);
  });

  it('wires extraction evidence block between known-memory pool and transcript and keeps no-evidence messages byte-identical', async () => {
    readUsedMemoryTextsMock.mockReturnValue([
      'Use context-aware retries for flaky external dependency calls.',
    ]);

    const capturedUserMessages: string[] = [];
    const provider = createMockLlmProvider((_systemPrompt, userMessage) => {
      capturedUserMessages.push(userMessage);
      return '[]';
    });

    const projectContext = { name: 'failure-episode-test', stack: ['typescript'], directory: '/Users/test' };
    const transcript = 'Session transcript line.';
    const evidenceBlock = [
      '===WEVIBE_EVIDENCE_BEGIN===',
      'EPISODE ep-0 [UNRESOLVED] signal=command_failure:go check=cmd:go',
      '===WEVIBE_EVIDENCE_END===',
    ].join('\n');

    await extractMemories(
      transcript,
      projectContext,
      {
        provider,
        sessionId: 'session-with-served-memory',
        evidenceBlock,
      },
    );

    await extractMemories(
      transcript,
      projectContext,
      {
        provider,
        sessionId: 'session-with-served-memory',
      },
    );

    await extractMemories(
      transcript,
      projectContext,
      {
        provider,
        sessionId: 'session-with-served-memory',
        evidenceBlock: undefined,
      },
    );

    await extractMemories(
      transcript,
      projectContext,
      {
        provider,
        sessionId: 'session-with-served-memory',
        evidenceBlock: '',
      },
    );

    const withEvidence = capturedUserMessages[0] ?? '';
    const withoutEvidence = capturedUserMessages[1] ?? '';
    const withoutEvidenceUndefined = capturedUserMessages[2] ?? '';
    const withoutEvidenceEmpty = capturedUserMessages[3] ?? '';

    const poolIndex = withEvidence.indexOf('ALREADY-KNOWN MEMORIES — POOL');
    const evidenceIndex = withEvidence.indexOf(evidenceBlock);
    const transcriptMarkerIndex = withEvidence.indexOf('===WEVIBE_TRANSCRIPT_BEGIN===');

    expect(poolIndex).toBeGreaterThanOrEqual(0);
    expect(evidenceIndex).toBeGreaterThan(poolIndex);
    expect(evidenceIndex).toBeLessThan(transcriptMarkerIndex);
    expect(withoutEvidence).toBe(withoutEvidenceUndefined);
    expect(withoutEvidence).toBe(withoutEvidenceEmpty);
    expect(withoutEvidence).not.toContain('===WEVIBE_EVIDENCE_BEGIN===');
  });

  it('is deterministic across repeated runs for both segmentation and rendered evidence', () => {
    const events: SubstrateEvent[] = [
      { kind: 'edit', time: 5, seq: 0, file: 'src/late.ts', detail: 'late edit that should sort later' },
      { kind: 'tool', time: 1, seq: 0, name: 'npm test', input: 'npm test', output: 'FAIL suite', exit: 1, status: 'completed' },
      { kind: 'edit', time: 2, seq: 0, file: 'src/fix.ts', detail: 'attempt' },
      { kind: 'tool', time: 6, seq: 0, name: 'npm test', input: 'npm test', output: 'PASS suite', exit: 0, status: 'completed' },
    ];

    const firstEpisodes = segmentFailureEpisodes(events);
    const secondEpisodes = segmentFailureEpisodes(events);
    const firstBlock = renderFailureEpisodeBlock(firstEpisodes, events);
    const secondBlock = renderFailureEpisodeBlock(secondEpisodes, events);

    expect(secondEpisodes).toEqual(firstEpisodes);
    expect(secondBlock).toBe(firstBlock);
  });

  it('resolves user-feedback verdict cycles with intervening edits (bench-shaped substrate)', () => {
    const events: SubstrateEvent[] = [
      {
        kind: 'user',
        time: 1,
        seq: 0,
        text: 'These are still failing — fix the implementation so they pass. Do not explain, just edit the code.\n\n- [G02] REQ-FOO: FAILING',
      },
      { kind: 'edit', time: 2, seq: 0, file: 'src/a.ts', detail: 'attempt edit A1' },
      { kind: 'edit', time: 3, seq: 0, file: 'src/b.ts', detail: 'attempt edit A2' },
      { kind: 'user', time: 4, seq: 0, text: 'That fixed it — [G02] REQ-FOO works now.' },
      {
        kind: 'user',
        time: 5,
        seq: 0,
        text: 'The rest are still failing — fix the implementation so they pass. Do not explain, just edit the code.\n\n- [G05] REQ-BAR: FAILING',
      },
      { kind: 'edit', time: 6, seq: 0, file: 'src/c.ts', detail: 'attempt edit B1' },
      { kind: 'user', time: 7, seq: 0, text: 'That fixed it — [G05] REQ-BAR works now.' },
    ];

    const episodes = segmentFailureEpisodes(events);
    const block = renderFailureEpisodeBlock(episodes, events);

    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({
      signal: {
        kind: 'user_feedback',
        checkKey: 'user:feedback',
      },
      resolution: 'resolved',
      validationIndex: 3,
    });
    expect(episodes[1]).toMatchObject({
      signal: {
        kind: 'user_feedback',
        checkKey: 'user:feedback',
        eventIndex: 4,
      },
      resolution: 'resolved',
    });
    expect(episodes[0]?.attemptEdits).toHaveLength(2);
    expect(episodes[1]?.attemptEdits).toHaveLength(1);
    expect(block).toContain('signal=user_feedback:user feedback check=user:feedback');
    expect(block).not.toContain('COINCIDENTAL-FLIP DISCLOSURE');
  });

  it('marks user-feedback fail→pass without intervening edits as coincidental', () => {
    const events: SubstrateEvent[] = [
      { kind: 'user', time: 1, seq: 0, text: 'Tests are still failing. Please fix.' },
      { kind: 'user', time: 2, seq: 0, text: 'That fixed it. Works now.' },
    ];

    const episodes = segmentFailureEpisodes(events);
    const block = renderFailureEpisodeBlock(episodes, events);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      signal: {
        kind: 'user_feedback',
        checkKey: 'user:feedback',
      },
      resolution: 'coincidental',
      validationIndex: 1,
    });
    expect(episodes[0]?.attemptEdits).toEqual([]);
    expect(block).toContain('COINCIDENTAL-FLIP DISCLOSURE');
  });
});
