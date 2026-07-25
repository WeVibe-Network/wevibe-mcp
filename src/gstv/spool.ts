import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { fp, logOp } from '../logger.js';
import { SPOOL_EVENT, SPOOL_VERSION, type SpoolEnvelope, type SpoolEventName } from './types.js';

const SPOOL_FILE_NAME = 'spool-v1.jsonl';
const OFFSETS_SCHEMA_VERSION = 1;

interface SpoolOffsetEntry {
  offset: number;
  size: number;
}

interface SpoolOffsetState {
  v: 1;
  files: Record<string, SpoolOffsetEntry>;
}

export interface SpoolConsumerOpts {
  spoolDirs: string[];
  offsetsFile: string;
  onEvent: (e: SpoolEnvelope) => void;
  intervalMs?: number;
}

export class SpoolConsumer {
  private readonly opts: SpoolConsumerOpts;
  private readonly intervalMs: number;
  private readonly eventNames = new Set<SpoolEventName>(Object.values(SPOOL_EVENT) as SpoolEventName[]);
  private readonly offsets: SpoolOffsetState;

  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(opts: SpoolConsumerOpts) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.offsets = this.loadOffsets();
  }

  /**
   * Reads each spool file from its persisted byte offset and consumes only
   * complete JSONL rows. If a file does not end with "\n", the trailing
   * partial row is NOT consumed and the offset advances only through the last
   * complete newline, so that partial row is re-read next poll once completed.
   */
  async pollOnce(): Promise<{ read: number; skipped: number }> {
    let read = 0;
    let skipped = 0;
    let shouldPersistOffsets = false;

    for (const spoolDir of this.opts.spoolDirs) {
      const spoolFile = path.join(spoolDir, SPOOL_FILE_NAME);
      if (!existsSync(spoolFile)) {
        continue;
      }

      try {
        const stats = statSync(spoolFile);
        if (!stats.isFile()) {
          continue;
        }

        const previous = this.offsets.files[spoolFile];
        let startOffset = previous?.offset ?? 0;
        if (stats.size < startOffset) {
          logOp('gstv.spool', 'warn', {
            trace: '-',
            reason: 'truncated_reset',
            file: spoolFile,
            file_fp: fp(spoolFile),
            persisted_offset: startOffset,
            current_size: stats.size,
          });
          startOffset = 0;
        }

        const data = readFileSync(spoolFile);
        if (data.length < startOffset) {
          logOp('gstv.spool', 'warn', {
            trace: '-',
            reason: 'truncated_reset',
            file: spoolFile,
            file_fp: fp(spoolFile),
            persisted_offset: startOffset,
            current_size: data.length,
          });
          startOffset = 0;
        }

        const slice = data.subarray(startOffset);
        const lastNewline = slice.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          const updatedSize = data.length;
          this.offsets.files[spoolFile] = { offset: startOffset, size: updatedSize };
          if ((previous?.offset ?? 0) !== startOffset) {
            shouldPersistOffsets = true;
          }
          continue;
        }

        const completeChunk = slice.subarray(0, lastNewline + 1).toString('utf8');
        const lines = completeChunk.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.pop();
        }

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          const parsed = this.tryParseLine(spoolFile, i + 1, line);
          if (!parsed) {
            skipped += 1;
            continue;
          }

          this.opts.onEvent(parsed);
          read += 1;
        }

        const nextOffset = startOffset + lastNewline + 1;
        this.offsets.files[spoolFile] = { offset: nextOffset, size: data.length };
        if ((previous?.offset ?? 0) !== nextOffset) {
          shouldPersistOffsets = true;
        }
      } catch (error) {
        logOp('gstv.spool', 'error', {
          trace: '-',
          reason: 'poll_file_failed',
          file: spoolFile,
          file_fp: fp(spoolFile),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (shouldPersistOffsets) {
      this.persistOffsets();
    }

    return { read, skipped };
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.safePollOnce();
    this.timer = setInterval(() => {
      void this.safePollOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async safePollOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (error) {
      logOp('gstv.spool', 'error', {
        trace: '-',
        reason: 'poll_once_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
  }

  private tryParseLine(spoolFile: string, lineNumber: number, line: string): SpoolEnvelope | null {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!this.isSpoolEnvelope(parsed)) {
        this.logInvalidLine(spoolFile, lineNumber, line.length, 'invalid_envelope');
        return null;
      }
      return parsed;
    } catch {
      this.logInvalidLine(spoolFile, lineNumber, line.length, 'invalid_json');
      return null;
    }
  }

  private isSpoolEnvelope(value: unknown): value is SpoolEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const event = candidate.event;
    const payload = candidate.payload;

    return (
      candidate.v === SPOOL_VERSION &&
      typeof candidate.seq === 'number' &&
      Number.isFinite(candidate.seq) &&
      typeof candidate.ts === 'string' &&
      typeof candidate.session_id === 'string' &&
      typeof event === 'string' &&
      this.eventNames.has(event as SpoolEventName) &&
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload)
    );
  }

  private logInvalidLine(spoolFile: string, lineNumber: number, lineLength: number, reason: string): void {
    logOp('gstv.spool', 'warn', {
      trace: '-',
      reason,
      file: spoolFile,
      file_fp: fp(spoolFile),
      line: lineNumber,
      line_len: lineLength,
    });
  }

  private loadOffsets(): SpoolOffsetState {
    if (!existsSync(this.opts.offsetsFile)) {
      return { v: OFFSETS_SCHEMA_VERSION, files: {} };
    }

    try {
      const raw = readFileSync(this.opts.offsetsFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('offsets_root_not_object');
      }

      const candidate = parsed as Record<string, unknown>;
      if (candidate.v !== OFFSETS_SCHEMA_VERSION) {
        throw new Error('offsets_version_mismatch');
      }

      const files = candidate.files;
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        throw new Error('offsets_files_not_object');
      }

      const normalized: Record<string, SpoolOffsetEntry> = {};
      for (const [filePath, entry] of Object.entries(files as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const offset = record.offset;
        const size = record.size;
        if (
          typeof offset === 'number' &&
          Number.isFinite(offset) &&
          offset >= 0 &&
          typeof size === 'number' &&
          Number.isFinite(size) &&
          size >= 0
        ) {
          normalized[filePath] = { offset, size };
        }
      }

      return { v: OFFSETS_SCHEMA_VERSION, files: normalized };
    } catch (error) {
      logOp('gstv.spool', 'warn', {
        trace: '-',
        reason: 'offsets_load_failed_reset',
        file: this.opts.offsetsFile,
        file_fp: fp(this.opts.offsetsFile),
        error: error instanceof Error ? error.message : String(error),
      });
      return { v: OFFSETS_SCHEMA_VERSION, files: {} };
    }
  }

  private persistOffsets(): void {
    const parentDir = path.dirname(this.opts.offsetsFile);
    const tmpPath = `${this.opts.offsetsFile}.tmp-${process.pid}-${Date.now()}`;

    mkdirSync(parentDir, { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(this.offsets)}\n`, 'utf8');
    renameSync(tmpPath, this.opts.offsetsFile);
  }
}
