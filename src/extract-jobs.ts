import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult } from './extraction.js';
import { logOp } from './logger.js';

export type ExtractJobStatus = 'running' | 'awaiting_decision' | 'done' | 'error';

export interface ExtractResumeInputs {
  transcript: string;
  project_context?: { title?: string; directory?: string; stack?: string };
  model: string;
  provider?: string;
  base_url?: string;
  ollama_url?: string;
  org_id?: string;
  session_id?: string;
  num_ctx?: number;
  prompt?: string;
}

export interface ExtractParkedFailure {
  reason: 'free_model_lapsed';
  http_status?: number;
  body_snippet?: string;
  lapsed_model: string;
  proposed_paid_slug: string;
}

export interface ExtractJobRecord {
  job_id: string;
  status: ExtractJobStatus;
  chunks_done: number;
  chunks_total: number;
  result?: ExtractionResult;
  error?: string;
  resume?: ExtractResumeInputs;
  failure?: ExtractParkedFailure;
  started_at: string;
  updated_at: string;
}

const JOB_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const jobs = new Map<string, ExtractJobRecord>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

function jobsDir(): string {
  const dir = process.env.WEVIBE_JOBS_PATH || join(homedir(), '.wevibe', 'jobs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function jobPath(jobId: string): string {
  return join(jobsDir(), `${jobId}.json`);
}

function persistJob(record: ExtractJobRecord, trace?: string): void {
  try {
    const path = jobPath(record.job_id);
    writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch (err) {
      logOp('extract.job', 'error', {
        trace,
        job_id: record.job_id,
        phase: 'persist',
        err: errorMessage(err),
      });
    }
  } catch (err) {
    logOp('extract.job', 'error', {
      trace,
      job_id: record.job_id,
      phase: 'persist',
      err: errorMessage(err),
    });
  }
}

function isExtractionResultShape(value: unknown): value is ExtractionResult {
  if (!isObject(value) || !Array.isArray(value.memories)) {
    return false;
  }

  if (value.meta === undefined) {
    return true;
  }

  if (!isObject(value.meta)) {
    return false;
  }

  const emptyReason = value.meta.emptyReason;
  return emptyReason === undefined || typeof emptyReason === 'string';
}

function isProjectContextShape(value: unknown): value is { title?: string; directory?: string; stack?: string } {
  if (!isObject(value)) {
    return false;
  }

  const { title, directory, stack } = value;
  if (title !== undefined && typeof title !== 'string') {
    return false;
  }
  if (directory !== undefined && typeof directory !== 'string') {
    return false;
  }
  if (stack !== undefined && typeof stack !== 'string') {
    return false;
  }
  return true;
}

function isExtractResumeInputsShape(value: unknown): value is ExtractResumeInputs {
  if (!isObject(value)) {
    return false;
  }

  const {
    transcript,
    model,
    project_context,
    provider,
    base_url,
    ollama_url,
    org_id,
    session_id,
    num_ctx,
    prompt,
  } = value;

  if (typeof transcript !== 'string' || typeof model !== 'string') {
    return false;
  }

  if (project_context !== undefined && !isProjectContextShape(project_context)) {
    return false;
  }

  if (provider !== undefined && typeof provider !== 'string') {
    return false;
  }
  if (base_url !== undefined && typeof base_url !== 'string') {
    return false;
  }
  if (ollama_url !== undefined && typeof ollama_url !== 'string') {
    return false;
  }
  if (org_id !== undefined && typeof org_id !== 'string') {
    return false;
  }
  if (session_id !== undefined && typeof session_id !== 'string') {
    return false;
  }
  if (num_ctx !== undefined && (typeof num_ctx !== 'number' || !Number.isFinite(num_ctx))) {
    return false;
  }
  if (prompt !== undefined && typeof prompt !== 'string') {
    return false;
  }

  return true;
}

function isExtractParkedFailureShape(value: unknown): value is ExtractParkedFailure {
  if (!isObject(value)) {
    return false;
  }

  const { reason, http_status, body_snippet, lapsed_model, proposed_paid_slug } = value;

  if (reason !== 'free_model_lapsed') {
    return false;
  }

  if (typeof lapsed_model !== 'string' || typeof proposed_paid_slug !== 'string') {
    return false;
  }

  if (http_status !== undefined && (typeof http_status !== 'number' || !Number.isFinite(http_status))) {
    return false;
  }

  if (body_snippet !== undefined && typeof body_snippet !== 'string') {
    return false;
  }

  return true;
}

function parseJobRecord(value: unknown): ExtractJobRecord | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const { job_id, status, chunks_done, chunks_total, result, error, resume, failure, started_at, updated_at } = value;
  if (typeof job_id !== 'string') {
    return undefined;
  }

  if (status !== 'running' && status !== 'awaiting_decision' && status !== 'done' && status !== 'error') {
    return undefined;
  }

  if (typeof chunks_done !== 'number' || !Number.isFinite(chunks_done)) {
    return undefined;
  }

  if (typeof chunks_total !== 'number' || !Number.isFinite(chunks_total)) {
    return undefined;
  }

  if (result !== undefined && !isExtractionResultShape(result)) {
    return undefined;
  }

  if (error !== undefined && typeof error !== 'string') {
    return undefined;
  }

  if (resume !== undefined && !isExtractResumeInputsShape(resume)) {
    return undefined;
  }

  if (failure !== undefined && !isExtractParkedFailureShape(failure)) {
    return undefined;
  }

  if (typeof started_at !== 'string' || typeof updated_at !== 'string') {
    return undefined;
  }

  return {
    job_id,
    status,
    chunks_done,
    chunks_total,
    result,
    error,
    resume,
    failure,
    started_at,
    updated_at,
  };
}

export function createJob(jobId: string, resume?: ExtractResumeInputs, trace?: string): ExtractJobRecord {
  const now = new Date().toISOString();
  const record: ExtractJobRecord = {
    job_id: jobId,
    status: 'running',
    chunks_done: 0,
    chunks_total: 0,
    ...(resume ? { resume } : {}),
    started_at: now,
    updated_at: now,
  };

  jobs.set(jobId, record);
  persistJob(record, trace);
  logOp('extract.job', 'info', {
    trace,
    job_id: jobId,
    phase: 'created',
  });

  return record;
}

export function recordChunkProgress(jobId: string, done: number, total: number, trace?: string): void {
  const record = jobs.get(jobId);
  if (!record) {
    logOp('extract.job', 'warn', {
      trace,
      job_id: jobId,
      phase: 'progress_missing',
    });
    return;
  }

  record.chunks_done = done;
  record.chunks_total = total;
  record.updated_at = new Date().toISOString();
  persistJob(record, trace);

  logOp('extract.job', 'info', {
    trace,
    job_id: jobId,
    phase: 'progress',
    chunks_done: done,
    chunks_total: total,
  });
}

export function completeJob(jobId: string, result: ExtractionResult, trace?: string): void {
  const record = jobs.get(jobId);
  if (!record) {
    logOp('extract.job', 'warn', {
      trace,
      job_id: jobId,
      phase: 'done_missing',
    });
    return;
  }

  record.status = 'done';
  record.result = result;
  delete record.error;
  record.updated_at = new Date().toISOString();
  persistJob(record, trace);

  logOp('extract.job', 'info', {
    trace,
    job_id: jobId,
    phase: 'done',
    kept: result.memories.length,
  });
}

export function failJob(jobId: string, error: string, trace?: string): void {
  const record = jobs.get(jobId);
  if (!record) {
    logOp('extract.job', 'warn', {
      trace,
      job_id: jobId,
      phase: 'error_missing',
    });
    return;
  }

  record.status = 'error';
  record.error = error;
  delete record.result;
  record.updated_at = new Date().toISOString();
  persistJob(record, trace);

  logOp('extract.job', 'error', {
    trace,
    job_id: jobId,
    phase: 'error',
    err: error,
  });
}

export function parkJob(jobId: string, failure: ExtractParkedFailure, trace?: string): void {
  const record = jobs.get(jobId);
  if (!record) {
    logOp('extract.job', 'warn', {
      trace,
      job_id: jobId,
      phase: 'park_missing',
    });
    return;
  }

  record.status = 'awaiting_decision';
  record.failure = failure;
  delete record.error;
  delete record.result;
  record.updated_at = new Date().toISOString();
  persistJob(record, trace);

  const bodySnippetLen = failure.body_snippet?.length;
  logOp('extract.job', 'warn', {
    trace,
    job_id: jobId,
    phase: 'parked',
    http_status: failure.http_status,
    lapsed_model: failure.lapsed_model,
    proposed_paid_slug: failure.proposed_paid_slug,
    ...(bodySnippetLen === undefined ? {} : { body_snippet_len: bodySnippetLen }),
  });
}

export function markJobResuming(jobId: string, newModel: string, trace?: string): ExtractJobRecord | undefined {
  const record = getJob(jobId);
  if (!record || record.status !== 'awaiting_decision' || !record.resume) {
    logOp('extract.job', 'warn', {
      trace,
      job_id: jobId,
      phase: 'resume_invalid',
    });
    return undefined;
  }

  record.status = 'running';
  record.resume.model = newModel;
  delete record.failure;
  delete record.error;
  record.chunks_done = 0;
  record.chunks_total = 0;
  record.updated_at = new Date().toISOString();
  persistJob(record, trace);

  logOp('extract.job', 'info', {
    trace,
    job_id: jobId,
    phase: 'resume_start',
    model: newModel,
  });

  return record;
}

export function getJob(jobId: string): ExtractJobRecord | undefined {
  if (!JOB_ID_REGEX.test(jobId)) {
    return undefined;
  }

  const inMemory = jobs.get(jobId);
  if (inMemory) {
    return inMemory;
  }

  try {
    const parsed = JSON.parse(readFileSync(jobPath(jobId), 'utf8'));
    const hydrated = parseJobRecord(parsed);
    if (!hydrated) {
      logOp('extract.job', 'warn', {
        job_id: jobId,
        phase: 'load_invalid',
      });
      return undefined;
    }

    jobs.set(jobId, hydrated);
    return hydrated;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logOp('extract.job', 'warn', {
        job_id: jobId,
        phase: 'load',
        err: errorMessage(err),
      });
    }
    return undefined;
  }
}

export function listParkedJobs(): ExtractJobRecord[] {
  try {
    const dir = jobsDir();
    const entries = readdirSync(dir, { withFileTypes: true });
    const parked: ExtractJobRecord[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const jobId = entry.name.slice(0, -'.json'.length);
      const record = getJob(jobId);
      if (record?.status === 'awaiting_decision') {
        parked.push(record);
      }
    }

    parked.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return parked;
  } catch (err) {
    logOp('extract.job', 'warn', {
      phase: 'list_parked',
      err: errorMessage(err),
    });
    return [];
  }
}

export function _resetJobsForTests(): void {
  jobs.clear();
}
