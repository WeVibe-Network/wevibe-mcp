import os from 'node:os';
import { describe, it, expect } from 'vitest';

import {
  SPOOL_VERSION,
  WALK_VERSION,
  CHAIN_VERSION,
  SEAL_STATE_ALG,
  EXCERPT_MAX_CHARS,
  CORRELATION_WINDOW_MS,
  SPOOL_EVENT,
  OP,
  canonicalJson,
  sha256Hex,
  goalIdFor,
  computePredicateHash,
  computeEnvFp,
} from '../src/gstv/types.js';

describe('gstv/types shared contract', () => {
  it('exports exact constants', () => {
    expect(SPOOL_VERSION).toBe('spool-v1');
    expect(WALK_VERSION).toBe('walk-v1');
    expect(CHAIN_VERSION).toBe('gstv-chain-v1');
    expect(SEAL_STATE_ALG).toBe('walk-v1');
    expect(EXCERPT_MAX_CHARS).toBe(2048);
    expect(CORRELATION_WINDOW_MS).toBe(2000);
  });

  it('exports exact SPOOL_EVENT values', () => {
    expect(SPOOL_EVENT).toEqual({
      SESSION_CREATED: 'session.created',
      SESSION_IDLE: 'session.idle',
      SESSION_ERROR: 'session.error',
      TOOL_EXECUTE_BEFORE: 'tool.execute.before',
      TOOL_EXECUTE_AFTER: 'tool.execute.after',
      FILE_EDITED: 'file.edited',
      FILE_WATCHER_UPDATED: 'file.watcher.updated',
      LSP_CLIENT_DIAGNOSTICS: 'lsp.client.diagnostics',
      COMMAND_EXECUTED: 'command.executed',
      GSTV_ATTACH_ATTEMPT: 'gstv.attach.attempt',
      GSTV_BOUNDARY_RUN: 'gstv.boundary.run',
    });
  });

  it('exports exact OP map values', () => {
    expect(OP).toEqual({
      SEAL: 'gstv.seal',
      ATTACH: 'gstv.attach',
      CHAIN_LINK: 'gstv.chain.link',
      GAP: 'gstv.gap',
      PREDICATE_OBSERVE: 'gstv.predicate.observe',
      GOAL_CLOSE: 'gstv.goal.close',
      EPISODE_OPEN: 'episode.open',
      EPISODE_CLOSE: 'episode.close',
      EXTRACTION_UNLOCK: 'gstv.extraction.unlock',
      PREDICATE_RECEIPT: 'predicate.receipt',
      NEGATIVE_RECEIPT: 'negative.receipt',
      RUN_SUMMARY: 'gstv.run_summary',
    });
  });

  it('canonicalJson sorts object keys recursively and preserves array order', () => {
    const input = {
      z: 1,
      a: {
        d: 4,
        b: 2,
        c: [{ y: 2, x: 1 }, { b: 2, a: 1 }],
      },
      m: [{ k: 2, j: 1 }, { b: 2, a: 1 }],
    };

    const canonical = canonicalJson(input);
    expect(canonical).toBe(
      '{"a":{"b":2,"c":[{"x":1,"y":2},{"a":1,"b":2}],"d":4},"m":[{"j":1,"k":2},{"a":1,"b":2}],"z":1}',
    );
    expect(canonical).not.toContain(' ');
    expect(canonicalJson(input)).toBe(canonical);
  });

  it('sha256Hex matches known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('goalIdFor has format, stability, and field sensitivity', () => {
    const base = {
      repo_binding: '.wevibe/org.json',
      goal_text_hash: '0'.repeat(64),
      sealed_at: '2026-07-25T12:34:56.000Z',
      ed_pubkey_hex: '1'.repeat(64),
    };

    const id1 = goalIdFor(base);
    const id2 = goalIdFor(base);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^gstv-[0-9a-f]{16}$/);

    expect(goalIdFor({ ...base, repo_binding: '.wevibe/other.json' })).not.toBe(id1);
    expect(goalIdFor({ ...base, goal_text_hash: '2'.repeat(64) })).not.toBe(id1);
    expect(goalIdFor({ ...base, sealed_at: '2026-07-25T12:34:57.000Z' })).not.toBe(id1);
    expect(goalIdFor({ ...base, ed_pubkey_hex: '3'.repeat(64) })).not.toBe(id1);
  });

  it('computePredicateHash changes on command or file hash changes', () => {
    const fileHashes = ['a'.repeat(64), 'b'.repeat(64)];
    const base = computePredicateHash('npm test', fileHashes);

    expect(computePredicateHash('npm run test', fileHashes)).not.toBe(base);
    expect(computePredicateHash('npm test', ['a'.repeat(64), 'c'.repeat(64)])).not.toBe(base);
  });

  it('computeEnvFp is 8-hex and stable within process', () => {
    const a = computeEnvFp();
    const b = computeEnvFp();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);

    const expectedInput = `${process.version}|${process.platform}-${process.arch}|${os.release()}`;
    expect(a).toBe(sha256Hex(expectedInput).slice(0, 8));
  });
});
