import { fp, logOp } from './logger.js';

export type ExtractionIntegrityOutcome = 'completed' | 'failed' | 'parked';

export interface ExtractionEpisodeCounts {
  resolved: number;
  unresolved: number;
  coincidental: number;
}

export interface ExtractionIntegrityInput {
  jobId: string;
  trace?: string;
  sessionId?: string;
  outcome: ExtractionIntegrityOutcome;
  episodes?: ExtractionEpisodeCounts;
  emittedMemoryCount?: number;
  emptyReason?: string;
}

export interface ExtractionIntegrityFields extends Record<string, unknown> {
  phase: 'integrity';
  trace?: string;
  job_id: string;
  session_fp: string;
  outcome: ExtractionIntegrityOutcome;
  resolved_problem_count?: number;
  unresolved_problem_count?: number;
  coincidental_count?: number;
  emitted_memory_count?: number;
  empty_reason?: string;
  invariant_violation?: boolean;
  episode_metadata?: 'unavailable_on_resume';
}

export function buildExtractionIntegrityFields(input: ExtractionIntegrityInput): ExtractionIntegrityFields {
  const fields: ExtractionIntegrityFields = {
    phase: 'integrity',
    ...(input.trace === undefined ? {} : { trace: input.trace }),
    job_id: input.jobId,
    session_fp: input.sessionId ? fp(input.sessionId) : '-',
    outcome: input.outcome,
  };

  if (input.episodes) {
    fields.resolved_problem_count = input.episodes.resolved;
    fields.unresolved_problem_count = input.episodes.unresolved;
    fields.coincidental_count = input.episodes.coincidental;
  }

  if (input.emittedMemoryCount !== undefined) {
    fields.emitted_memory_count = input.emittedMemoryCount;
  }

  if (input.emptyReason !== undefined) {
    fields.empty_reason = input.emptyReason;
  }

  if (
    input.outcome === 'completed'
    && input.episodes !== undefined
    && input.emittedMemoryCount !== undefined
  ) {
    fields.invariant_violation = input.episodes.resolved === 0 && input.emittedMemoryCount > 0;
  }

  if (input.outcome === 'completed' && input.episodes === undefined) {
    fields.episode_metadata = 'unavailable_on_resume';
  }

  return fields;
}

export function emitExtractionIntegrity(input: ExtractionIntegrityInput): ExtractionIntegrityFields {
  const fields = buildExtractionIntegrityFields(input);
  const level = fields.invariant_violation === true ? 'error' : 'info';
  logOp('extraction.integrity', level, fields);
  return fields;
}
