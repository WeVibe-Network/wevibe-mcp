import type { IncomingMessage } from 'node:http';

export class BodyReadError extends Error {
  readonly status: 413 | 408;
  readonly code: 'body_too_large' | 'body_timeout';

  constructor(status: 413 | 408, code: 'body_too_large' | 'body_timeout', message: string) {
    super(message);
    this.name = 'BodyReadError';
    this.status = status;
    this.code = code;
  }
}

function parsePositiveInt(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const maxBytes = parsePositiveInt(process.env.WEVIBE_BODY_MAX_BYTES, 25 * 1024 * 1024);
  const timeoutMs = parsePositiveInt(process.env.WEVIBE_BODY_TIMEOUT_MS, 60_000);

  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesRead = 0;
    const chunks: string[] = [];

    const finalizeReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const finalizeResolve = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      req.destroy?.();
      finalizeReject(new BodyReadError(408, 'body_timeout', `request body timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('data', (chunk: Buffer | string) => {
      if (settled) {
        return;
      }

      const chunkBytes = Buffer.byteLength(chunk);
      bytesRead += chunkBytes;
      if (bytesRead > maxBytes) {
        req.destroy?.();
        finalizeReject(new BodyReadError(413, 'body_too_large', `request body exceeded ${maxBytes} bytes`));
        return;
      }

      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    });

    req.on('end', () => {
      finalizeResolve(chunks.join(''));
    });

    req.on('error', (error: Error) => {
      finalizeReject(error);
    });
  });
}
