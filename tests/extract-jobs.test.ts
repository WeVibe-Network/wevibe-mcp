import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  _resetJobsForTests,
  completeJob,
  createJob,
  failJob,
  getJob,
  listParkedJobs,
  markJobResuming,
  parkJob,
  recordChunkProgress,
} from '../src/extract-jobs.js';
import type { ExtractParkedFailure, ExtractResumeInputs } from '../src/extract-jobs.js';
import type { ExtractionResult } from '../src/extraction.js';

function seededExtractionResult(): ExtractionResult {
  return {
    memories: [
      {
        implement: 'Use deterministic test fixtures for async status payload assertions.',
        context: 'Vitest extraction async contract coverage.',
        dnd: null,
        stack: ['typescript', 'vitest'],
        memory_type: 'memory',
        preference_confidence: 0.25,
        extraction_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        keywords: {
          classified: [],
          suggestions: [],
        },
      },
    ],
    meta: { emptyReason: 'none' },
  };
}

function expectIsoTimestamp(value: string): void {
  expect(typeof value).toBe('string');
  expect(new Date(value).toISOString()).toBe(value);
}

function seededResumeInputs(model = 'deepseek/deepseek-r1:free'): ExtractResumeInputs {
  return {
    transcript: 'Team discussed async extract job retry policy and resume state.',
    project_context: {
      title: 'extract jobs unit test',
      directory: '/tmp/wevibe-mcp-test',
      stack: 'typescript,vitest',
    },
    model,
    provider: 'openrouter',
    org_id: 'org-test',
    session_id: 'session-test',
    prompt: 'Extract memory candidates from the transcript.',
  };
}

function seededParkedFailure(lapsedModel: string): ExtractParkedFailure {
  return {
    reason: 'free_model_lapsed',
    http_status: 404,
    body_snippet: `no endpoints found for ${lapsedModel}`,
    lapsed_model: lapsedModel,
    proposed_paid_slug: lapsedModel.replace(/:free$/i, ''),
  };
}

describe('extract-jobs', () => {
  let jobsDir: string;

  beforeEach(() => {
    jobsDir = join(tmpdir(), `wevibe-jobs-test-${randomUUID()}`);
    process.env.WEVIBE_JOBS_PATH = jobsDir;
    _resetJobsForTests();
  });

  afterEach(() => {
    _resetJobsForTests();
    delete process.env.WEVIBE_JOBS_PATH;
    rmSync(jobsDir, { recursive: true, force: true });
  });

  it('createJob persists a running record and getJob returns it', () => {
    const jobId = `job-${randomUUID()}`;

    const created = createJob(jobId, undefined, 'trace-create');
    const loaded = getJob(jobId);
    const persistedPath = join(jobsDir, `${jobId}.json`);

    expect(created).toMatchObject({
      job_id: jobId,
      status: 'running',
      chunks_done: 0,
      chunks_total: 0,
    });
    expect(loaded).toMatchObject({
      job_id: jobId,
      status: 'running',
      chunks_done: 0,
      chunks_total: 0,
    });
    expectIsoTimestamp(created.started_at);
    expectIsoTimestamp(created.updated_at);
    expect(existsSync(persistedPath)).toBe(true);
  });

  it('recordChunkProgress updates in-memory and on-disk progress state', async () => {
    const jobId = `job-${randomUUID()}`;
    createJob(jobId, undefined, 'trace-progress');
    const beforeUpdatedAt = getJob(jobId)?.updated_at;

    await new Promise(resolve => setTimeout(resolve, 2));
    recordChunkProgress(jobId, 3, 7, 'trace-progress');

    const loaded = getJob(jobId);
    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf8')) as {
      chunks_done: number;
      chunks_total: number;
      updated_at: string;
    };

    expect(loaded).toMatchObject({
      job_id: jobId,
      status: 'running',
      chunks_done: 3,
      chunks_total: 7,
    });
    expect(loaded?.updated_at).not.toBe(beforeUpdatedAt);
    expectIsoTimestamp(loaded!.updated_at);
    expect(persisted.chunks_done).toBe(3);
    expect(persisted.chunks_total).toBe(7);
    expectIsoTimestamp(persisted.updated_at);
  });

  it('completeJob sets done/result and failJob sets error/error text', () => {
    const doneJobId = `job-done-${randomUUID()}`;
    const errorJobId = `job-error-${randomUUID()}`;
    const result = seededExtractionResult();

    createJob(doneJobId, undefined, 'trace-done');
    completeJob(doneJobId, result, 'trace-done');

    createJob(errorJobId, undefined, 'trace-error');
    failJob(errorJobId, 'pipeline failed', 'trace-error');

    const done = getJob(doneJobId);
    const failed = getJob(errorJobId);

    expect(done).toMatchObject({
      job_id: doneJobId,
      status: 'done',
      result,
    });
    expect(done?.error).toBeUndefined();

    expect(failed).toMatchObject({
      job_id: errorJobId,
      status: 'error',
      error: 'pipeline failed',
    });
    expect(failed?.result).toBeUndefined();
  });

  it('getJob rehydrates from disk after in-memory reset (R-32 resumable guarantee)', () => {
    const jobId = `job-resume-${randomUUID()}`;
    const result = seededExtractionResult();

    createJob(jobId, undefined, 'trace-resume');
    completeJob(jobId, result, 'trace-resume');

    _resetJobsForTests();

    const hydrated = getJob(jobId);
    expect(hydrated).toBeDefined();
    expect(hydrated).toMatchObject({
      job_id: jobId,
      status: 'done',
      result,
    });
  });

  it('getJob returns undefined for unknown and traversal-style ids', () => {
    expect(getJob(`missing-${randomUUID()}`)).toBeUndefined();
    expect(getJob('../evil')).toBeUndefined();
  });

  it('parkJob sets awaiting_decision, retains resume, and survives rehydration', () => {
    const jobId = `job-park-${randomUUID()}`;
    const resume = seededResumeInputs();
    const failure = seededParkedFailure(resume.model);

    createJob(jobId, resume, 'trace-park-create');
    parkJob(jobId, failure, 'trace-park');

    const parked = getJob(jobId);
    expect(parked).toMatchObject({
      job_id: jobId,
      status: 'awaiting_decision',
      resume,
      failure,
    });
    expect(parked?.error).toBeUndefined();
    expect(parked?.result).toBeUndefined();

    _resetJobsForTests();

    const rehydrated = getJob(jobId);
    expect(rehydrated).toMatchObject({
      job_id: jobId,
      status: 'awaiting_decision',
      resume,
      failure,
    });
    expect(rehydrated?.error).toBeUndefined();
    expect(rehydrated?.result).toBeUndefined();
  });

  it('markJobResuming restarts parked jobs, updates model, and resets chunk progress', () => {
    const jobId = `job-resume-mark-${randomUUID()}`;
    const resume = seededResumeInputs();
    const failure = seededParkedFailure(resume.model);
    const resumedModel = 'openai/gpt-4.1-mini';

    createJob(jobId, resume, 'trace-resume-create');
    recordChunkProgress(jobId, 4, 9, 'trace-resume-progress');
    parkJob(jobId, failure, 'trace-resume-park');

    const resumed = markJobResuming(jobId, resumedModel, 'trace-resume-start');
    const loaded = getJob(jobId);

    expect(resumed).toBeDefined();
    expect(resumed).toMatchObject({
      job_id: jobId,
      status: 'running',
      chunks_done: 0,
      chunks_total: 0,
    });
    expect(resumed?.resume?.model).toBe(resumedModel);
    expect(resumed?.failure).toBeUndefined();
    expect(resumed?.error).toBeUndefined();

    expect(loaded).toMatchObject({
      job_id: jobId,
      status: 'running',
      chunks_done: 0,
      chunks_total: 0,
    });
    expect(loaded?.resume?.model).toBe(resumedModel);
    expect(loaded?.failure).toBeUndefined();
    expect(loaded?.error).toBeUndefined();
  });

  it('markJobResuming returns undefined for non-parked jobs', () => {
    const jobId = `job-non-parked-${randomUUID()}`;
    const resume = seededResumeInputs();

    createJob(jobId, resume, 'trace-non-parked');
    const resumed = markJobResuming(jobId, 'openai/gpt-4.1-mini', 'trace-non-parked');

    expect(resumed).toBeUndefined();
    expect(getJob(jobId)).toMatchObject({
      job_id: jobId,
      status: 'running',
      resume,
    });
  });

  it('listParkedJobs returns only awaiting_decision jobs', () => {
    const parkedJobId = `job-parked-${randomUUID()}`;
    const runningJobId = `job-running-${randomUUID()}`;
    const parkedResume = seededResumeInputs('x/y:free');
    const runningResume = seededResumeInputs('x/y');
    const failure = seededParkedFailure(parkedResume.model);

    createJob(parkedJobId, parkedResume, 'trace-list-parked');
    createJob(runningJobId, runningResume, 'trace-list-running');
    parkJob(parkedJobId, failure, 'trace-list-park');

    const parked = listParkedJobs();

    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      job_id: parkedJobId,
      status: 'awaiting_decision',
      resume: parkedResume,
      failure,
    });
    expect(parked[0]?.error).toBeUndefined();
    expect(parked[0]?.result).toBeUndefined();
  });
});
