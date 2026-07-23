import { beforeEach, describe, expect, it, vi } from 'vitest';

const readUsedMemoryTextsMock = vi.hoisted(() => vi.fn<(sessionId: string) => string[]>());

vi.mock('../src/served-memory-store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/served-memory-store.js')>('../src/served-memory-store.js');
  return {
    ...actual,
    readUsedMemoryTexts: readUsedMemoryTextsMock,
  };
});

vi.mock('../src/embedding.js', () => ({
  computeLocalEmbedding: vi.fn().mockResolvedValue(new Array(3072).fill(0.1)),
}));

vi.mock('../src/embedding-config.js', () => ({
  loadEmbeddingConfig: vi.fn().mockReturnValue({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    model: 'text-embedding-3-large',
    usePrefix: false,
  }),
}));

import { extractMemories } from '../src/extraction.js';
import {
  buildExtractionIntegrityFields,
  emitExtractionIntegrity,
} from '../src/extraction-integrity.js';
import { segmentFailureEpisodes } from '../src/failure-episodes.js';
import { fp } from '../src/logger.js';
import type { LlmChatOptions, LlmProvider } from '../src/llm.js';
import type { SubstrateEvent } from '../src/session-substrate.js';

function createMockLlmProvider(
  chatFn: (sys: string, user: string, options?: LlmChatOptions) => string | Promise<string>,
): LlmProvider {
  return {
    chat: async (systemPrompt: string, userMessage: string, options?: LlmChatOptions) => {
      return chatFn(systemPrompt, userMessage, options);
    },
  };
}

describe('extraction integrity fields', () => {
  beforeEach(() => {
    readUsedMemoryTextsMock.mockReset();
    readUsedMemoryTextsMock.mockReturnValue([]);
  });

  it('reports non-violation for completed jobs with zero resolved episodes and zero emitted memories', () => {
    const fields = buildExtractionIntegrityFields({
      jobId: 'job-pass-zero',
      sessionId: 'session-pass-zero',
      outcome: 'completed',
      episodes: { resolved: 0, unresolved: 2, coincidental: 1 },
      emittedMemoryCount: 0,
    });

    expect(fields.invariant_violation).toBe(false);
    expect(fields.resolved_problem_count).toBe(0);
    expect(fields.emitted_memory_count).toBe(0);
  });

  it('flags invariant violations for zero-resolved completed jobs with emitted memories while leaving extraction result untouched', async () => {
    const provider = createMockLlmProvider(() => JSON.stringify([
      {
        implement: 'Use deterministic retries with capped exponential backoff.',
        context: 'Node.js worker handling external API bursts.',
        dnd: 'Do not retry non-idempotent writes without dedupe keys.',
        stack: ['nodejs', 'typescript'],
        memory_type: 'memory',
      },
      {
        implement: 'Pin schema validators to exact versions during rollout windows.',
        context: 'Monorepo services share validation contracts.',
        dnd: null,
        stack: ['typescript', 'api'],
        memory_type: 'memory',
      },
      {
        implement: 'Capture provider latency percentiles before changing concurrency.',
        context: 'Batch ingestion pipeline with fan-out workers.',
        dnd: null,
        stack: ['observability', 'queues'],
        memory_type: 'memory',
      },
    ]));

    const result = await extractMemories(
      'Investigated retry behavior and rollout safety constraints in today\'s extraction run.',
      { name: 'integrity-test', stack: ['typescript'], directory: '/Users/test' },
      {
        provider,
        sessionId: 'integrity-session',
      },
    );

    expect(result.memories).toHaveLength(3);
    const memoriesBeforeIntegrity = JSON.parse(JSON.stringify(result.memories));

    const fields = emitExtractionIntegrity({
      jobId: 'job-violation',
      trace: 'trace-violation',
      sessionId: 'integrity-session',
      outcome: 'completed',
      episodes: { resolved: 0, unresolved: 1, coincidental: 0 },
      emittedMemoryCount: result.memories.length,
    });

    expect(fields.invariant_violation).toBe(true);
    expect(result.memories).toEqual(memoriesBeforeIntegrity);
  });

  it('reports non-violation for completed jobs with resolved episodes and emitted memories', () => {
    const fields = buildExtractionIntegrityFields({
      jobId: 'job-pass-positive',
      trace: 'trace-pass-positive',
      sessionId: 'session-pass-positive',
      outcome: 'completed',
      episodes: { resolved: 2, unresolved: 0, coincidental: 1 },
      emittedMemoryCount: 3,
    });

    expect(fields.invariant_violation).toBe(false);
    expect(fields.resolved_problem_count).toBe(2);
    expect(fields.emitted_memory_count).toBe(3);
  });

  it('omits invariant booleans and emitted counts for failed and parked outcomes while keeping episode counts', () => {
    const failedFields = buildExtractionIntegrityFields({
      jobId: 'job-failed',
      sessionId: 'session-failed',
      outcome: 'failed',
      episodes: { resolved: 4, unresolved: 1, coincidental: 2 },
    });

    expect(failedFields.resolved_problem_count).toBe(4);
    expect(failedFields.unresolved_problem_count).toBe(1);
    expect(failedFields.coincidental_count).toBe(2);
    expect(failedFields.invariant_violation).toBeUndefined();
    expect('invariant_violation' in failedFields).toBe(false);
    expect(failedFields.emitted_memory_count).toBeUndefined();
    expect('emitted_memory_count' in failedFields).toBe(false);

    const parkedFields = buildExtractionIntegrityFields({
      jobId: 'job-parked',
      sessionId: 'session-parked',
      outcome: 'parked',
      episodes: { resolved: 1, unresolved: 3, coincidental: 0 },
    });

    expect(parkedFields.resolved_problem_count).toBe(1);
    expect(parkedFields.unresolved_problem_count).toBe(3);
    expect(parkedFields.coincidental_count).toBe(0);
    expect(parkedFields.invariant_violation).toBeUndefined();
    expect('invariant_violation' in parkedFields).toBe(false);
    expect(parkedFields.emitted_memory_count).toBeUndefined();
    expect('emitted_memory_count' in parkedFields).toBe(false);
  });

  it('uses hashed session fingerprints and never emits plaintext memory/transcript data fields', () => {
    const memoryText = 'Do not leak this memory text into integrity telemetry.';
    const transcriptText = 'Do not leak this transcript into integrity telemetry.';

    const fields = buildExtractionIntegrityFields({
      jobId: 'job-no-plaintext',
      trace: 'trace-no-plaintext',
      sessionId: 'some-session-id',
      outcome: 'completed',
      episodes: { resolved: 1, unresolved: 0, coincidental: 0 },
      emittedMemoryCount: 1,
      emptyReason: 'off_task_output',
    });

    const allowedKeys = new Set([
      'phase',
      'trace',
      'job_id',
      'session_fp',
      'outcome',
      'resolved_problem_count',
      'unresolved_problem_count',
      'coincidental_count',
      'emitted_memory_count',
      'empty_reason',
      'invariant_violation',
      'episode_metadata',
    ]);

    expect(Object.keys(fields).every(key => allowedKeys.has(key))).toBe(true);
    expect(fields.session_fp).toBe(fp('some-session-id'));
    expect(fields.session_fp).not.toBe('some-session-id');

    for (const value of Object.values(fields)) {
      if (typeof value === 'string') {
        expect(value).not.toContain(memoryText);
        expect(value).not.toContain(transcriptText);
      }
    }
  });

  it('derives episode counts from realistic failure-episode segmentation exactly like http-server', () => {
    const events: SubstrateEvent[] = [
      { kind: 'tool', time: 1, seq: 0, name: 'npm test', input: 'npm test', output: 'FAIL suite', exit: 1, status: 'completed' },
      { kind: 'edit', time: 2, seq: 0, file: 'src/app.ts', detail: 'first attempt' },
      { kind: 'tool', time: 3, seq: 0, name: 'npm test', input: 'npm test', output: 'PASS suite', exit: 0, status: 'completed' },
      { kind: 'tool', time: 4, seq: 0, name: 'bash', input: 'go build ./...', output: 'build failed', exit: 1, status: 'completed' },
      { kind: 'edit', time: 5, seq: 0, file: 'src/main.go', detail: 'attempted fix' },
      { kind: 'tool', time: 6, seq: 0, name: 'bash', input: 'make test', output: 'make failed', exit: 2, status: 'completed' },
      { kind: 'tool', time: 7, seq: 0, name: 'bash', input: 'make test', output: 'all good', exit: 0, status: 'completed' },
    ];

    const episodes = segmentFailureEpisodes(events);
    const resolved = episodes.filter(episode => episode.resolution === 'resolved').length;
    const unresolved = episodes.filter(episode => episode.resolution === 'unresolved').length;
    const coincidental = episodes.filter(episode => episode.resolution === 'coincidental').length;

    const fields = buildExtractionIntegrityFields({
      jobId: 'job-realistic-episodes',
      outcome: 'completed',
      episodes: { resolved, unresolved, coincidental },
      emittedMemoryCount: 0,
    });

    expect(fields.resolved_problem_count).toBe(resolved);
    expect(fields.unresolved_problem_count).toBe(unresolved);
    expect(fields.coincidental_count).toBe(coincidental);
  });

  it('marks completed outcomes without episode metadata as unavailable_on_resume', () => {
    const fields = buildExtractionIntegrityFields({
      jobId: 'job-resumed',
      sessionId: 'resumed-session',
      outcome: 'completed',
      emittedMemoryCount: 2,
    });

    expect(fields.episode_metadata).toBe('unavailable_on_resume');
    expect(fields.invariant_violation).toBeUndefined();
    expect('invariant_violation' in fields).toBe(false);
  });
});
