import { buildWeVibeSignedAuth } from './auth.js';
import { HUB_URL } from './config.js';
import { hubFetchVerified } from './hub-fetch.js';
import { fp, logOp } from './logger.js';

type MemoryAdmissionCode = 'memory_not_approved' | 'memory_check_unavailable';

class MemoryAdmissionError extends Error {
  readonly code: MemoryAdmissionCode;
  readonly status: 422 | 503;

  constructor(code: MemoryAdmissionCode, status: 422 | 503, message: string, detail?: string) {
    super(message);
    this.name = 'MemoryAdmissionError';
    this.code = code;
    this.status = status;
    if (detail) {
      this.message = `${message}: ${detail}`;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function throwAdmissionError(
  orgId: string,
  memoryHashHex: string,
  trace: string,
  code: MemoryAdmissionCode,
  status: 422 | 503,
  reason: string,
  detail?: string,
): never {
  logOp('memory.admission', 'error', {
    trace,
    phase: 'admission',
    status: 'err',
    reason,
    org_id: orgId,
    org_fp: fp(orgId),
    memory_hash_first8: memoryHashHex.slice(0, 8),
    ...(detail ? { err: detail } : {}),
  });
  throw new MemoryAdmissionError(code, status, reason, detail);
}

export async function assertMemoryApproved(orgId: string, memoryHashHex: string, trace: string): Promise<void> {
  const url = `${HUB_URL}/v1/orgs/${encodeURIComponent(orgId)}/memories/${memoryHashHex}`;

  let hubResp: Awaited<ReturnType<typeof hubFetchVerified>>;
  try {
    const { headers } = await buildWeVibeSignedAuth();
    hubResp = await hubFetchVerified(orgId, url, {
      method: 'GET',
      headers: {
        ...headers,
        'X-WeVibe-Trace-Id': trace,
      },
    });
  } catch (error) {
    throwAdmissionError(
      orgId,
      memoryHashHex,
      trace,
      'memory_check_unavailable',
      503,
      'memory approval check unavailable',
      errorText(error),
    );
  }

  if (hubResp.res.status >= 200 && hubResp.res.status < 300) {
    logOp('memory.admission', 'info', {
      trace,
      phase: 'admission',
      status: 'ok',
      org_id: orgId,
      org_fp: fp(orgId),
      memory_hash_first8: memoryHashHex.slice(0, 8),
    });
    return;
  }

  if (hubResp.res.status === 404) {
    throwAdmissionError(
      orgId,
      memoryHashHex,
      trace,
      'memory_not_approved',
      422,
      'memory is not approved for this org',
      `hub status 404 body=${hubResp.bodyText}`,
    );
  }

  throwAdmissionError(
    orgId,
    memoryHashHex,
    trace,
    'memory_check_unavailable',
    503,
    'memory approval check unavailable',
    `hub status ${hubResp.res.status} body=${hubResp.bodyText}`,
  );
}
