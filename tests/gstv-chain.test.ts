import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendLink, computeLinkHash, diffHashFor, readChain, readChainHead } from '../src/gstv/chain.js';

function makeGoalDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(root, 'goals', 'gstv-goal-test');
}

function hashHex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('gstv/chain primitive', () => {
  it('appends genesis link with seal-bound prev and expected link hash preimage', async () => {
    const goalDir = makeGoalDir('gstv-chain-genesis-');
    const seal = { state0_hash: '0'.repeat(64) };
    const input = {
      ts: '2026-07-26T12:00:00.000Z',
      session_id: 'session-a',
      cause: 'tool.1',
      kind: 'state' as const,
      state_hash: 'b'.repeat(64),
      diff_hash: 'c'.repeat(64),
    };

    const link = await appendLink(goalDir, seal, input);
    expect(link.index).toBe(0);
    expect(link.prev).toBe(seal.state0_hash);

    const expectedPreimage = [seal.state0_hash, input.state_hash, input.diff_hash, input.ts, input.session_id, input.cause].join('\n');
    const expected = hashHex(expectedPreimage);
    expect(link.link_hash).toBe(expected);
  });

  it('appends second link chained to first link hash with index increment', async () => {
    const goalDir = makeGoalDir('gstv-chain-second-');
    const seal = { state0_hash: '9'.repeat(64) };

    const first = await appendLink(goalDir, seal, {
      ts: '2026-07-26T00:00:00.000Z',
      session_id: 'session-1',
      cause: 'tool.1',
      kind: 'state',
      state_hash: '1'.repeat(64),
      diff_hash: '2'.repeat(64),
    });

    const second = await appendLink(goalDir, seal, {
      ts: '2026-07-26T00:00:02.000Z',
      session_id: 'session-1',
      cause: 'tool.2',
      kind: 'state',
      state_hash: '3'.repeat(64),
      diff_hash: '4'.repeat(64),
    });

    expect(second.index).toBe(1);
    expect(second.prev).toBe(first.link_hash);
  });

  it('computeLinkHash matches known vector', () => {
    const got = computeLinkHash({
      prev: '0'.repeat(64),
      state_hash: '1'.repeat(64),
      diff_hash: '2'.repeat(64),
      ts: '2026-07-26T00:00:00.000Z',
      session_id: 'sess-known',
      cause: 'tool_call_id:abc123',
    });
    expect(got).toBe('5a6bfac375bff54f4b6c1c1a777974f223e9aa537efdd8f632c87b12780b75ae');
  });

  it('diffHashFor handles added-only, removed, modified, mixed and empty delta', () => {
    const addedOnly = diffHashFor(null, [
      { path: 'b.txt', sha256: 'b'.repeat(64) },
      { path: 'a.txt', sha256: 'a'.repeat(64) },
    ]);
    expect(addedOnly).toBe('2a234427aa8da5f3aa1d91d311319eb03d1e75a65b1c91038a4ec2522087cefa');

    const removed = diffHashFor([{ path: 'z.txt', sha256: 'f'.repeat(64) }], []);
    expect(removed).toBe('cd42f5f9c95af44dc235a7d7734e0a421aa16aa265f4d7e6b3bc40f8457ce155');

    const modified = diffHashFor(
      [{ path: 'a.txt', sha256: '1'.repeat(64) }],
      [{ path: 'a.txt', sha256: '2'.repeat(64) }],
    );
    expect(modified).toBe('a528725ccd196d8bf75ea022f22c5b5598e885dae2fe12bf9a086931f01c55f4');

    const mixedA = diffHashFor(
      [
        { path: 'c.txt', sha256: 'c'.repeat(64) },
        { path: 'a.txt', sha256: 'a'.repeat(64) },
        { path: 'b.txt', sha256: 'b'.repeat(64) },
      ],
      [
        { path: 'd.txt', sha256: 'd'.repeat(64) },
        { path: 'b.txt', sha256: 'e'.repeat(64) },
        { path: 'c.txt', sha256: 'c'.repeat(64) },
      ],
    );

    const mixedB = diffHashFor(
      [
        { path: 'b.txt', sha256: 'b'.repeat(64) },
        { path: 'a.txt', sha256: 'a'.repeat(64) },
        { path: 'c.txt', sha256: 'c'.repeat(64) },
      ],
      [
        { path: 'c.txt', sha256: 'c'.repeat(64) },
        { path: 'b.txt', sha256: 'e'.repeat(64) },
        { path: 'd.txt', sha256: 'd'.repeat(64) },
      ],
    );

    expect(mixedA).toBe('9a46cb6f9eb56347ea1c879ca92c7b26c74a07b34afaed475f1edf5e1950c4cd');
    expect(mixedB).toBe(mixedA);
    expect(diffHashFor([{ path: 'same.txt', sha256: 'a'.repeat(64) }], [{ path: 'same.txt', sha256: 'a'.repeat(64) }])).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('readChain and readChainHead roundtrip appended links', async () => {
    const goalDir = makeGoalDir('gstv-chain-roundtrip-');
    const seal = { state0_hash: '7'.repeat(64) };

    const a = await appendLink(goalDir, seal, {
      ts: '2026-07-26T01:00:00.000Z',
      session_id: 's1',
      cause: 'external',
      kind: 'state',
      state_hash: '1'.repeat(64),
      diff_hash: '2'.repeat(64),
    });

    const b = await appendLink(goalDir, seal, {
      ts: '2026-07-26T01:01:00.000Z',
      session_id: 's1',
      cause: 'attach',
      kind: 'gap',
      detector: 'watcher',
      state_hash: '3'.repeat(64),
      diff_hash: '4'.repeat(64),
    });

    const c = await appendLink(goalDir, seal, {
      ts: '2026-07-26T01:02:00.000Z',
      session_id: 's1',
      cause: 'boundary',
      kind: 'state',
      state_hash: '5'.repeat(64),
      diff_hash: '6'.repeat(64),
    });

    const chain = await readChain(goalDir);
    expect(chain).toEqual([a, b, c]);
    expect(await readChainHead(goalDir)).toEqual(c);
  });

  it('readChain throws chain_corrupt on broken prev continuity', async () => {
    const goalDir = makeGoalDir('gstv-chain-corrupt-');
    const seal = { state0_hash: '8'.repeat(64) };

    await appendLink(goalDir, seal, {
      ts: '2026-07-26T02:00:00.000Z',
      session_id: 's1',
      cause: 'tool.1',
      kind: 'state',
      state_hash: 'a'.repeat(64),
      diff_hash: 'b'.repeat(64),
    });

    await appendLink(goalDir, seal, {
      ts: '2026-07-26T02:00:01.000Z',
      session_id: 's1',
      cause: 'tool.2',
      kind: 'state',
      state_hash: 'c'.repeat(64),
      diff_hash: 'd'.repeat(64),
    });

    await appendLink(goalDir, seal, {
      ts: '2026-07-26T02:00:02.000Z',
      session_id: 's1',
      cause: 'tool.3',
      kind: 'state',
      state_hash: 'e'.repeat(64),
      diff_hash: 'f'.repeat(64),
    });

    const chainFile = path.join(goalDir, 'chain.jsonl');
    const lines = fs.readFileSync(chainFile, 'utf8').trimEnd().split('\n');
    const middle = JSON.parse(lines[1]) as { link_hash: string; prev: string };
    middle.link_hash = '0'.repeat(64);
    lines[1] = JSON.stringify(middle);
    fs.writeFileSync(chainFile, `${lines.join('\n')}\n`, 'utf8');

    await expect(readChain(goalDir)).rejects.toThrowError('chain_corrupt');
  });

  it('enforces detector presence rules for gap/state kinds', async () => {
    const goalDir = makeGoalDir('gstv-chain-detector-rules-');
    const seal = { state0_hash: '4'.repeat(64) };

    await expect(
      appendLink(goalDir, seal, {
        ts: '2026-07-26T03:00:00.000Z',
        session_id: 's1',
        cause: 'attach',
        kind: 'gap',
        state_hash: '1'.repeat(64),
        diff_hash: '2'.repeat(64),
      }),
    ).rejects.toThrowError('chain_corrupt');

    await expect(
      appendLink(goalDir, seal, {
        ts: '2026-07-26T03:00:01.000Z',
        session_id: 's1',
        cause: 'tool.1',
        kind: 'state',
        detector: 'watcher',
        state_hash: '1'.repeat(64),
        diff_hash: '2'.repeat(64),
      }),
    ).rejects.toThrowError('chain_corrupt');
  });

  it('session switch appends to one goal chain without resetting index', async () => {
    const goalDir = makeGoalDir('gstv-chain-session-switch-');
    const seal = { state0_hash: '6'.repeat(64) };

    const first = await appendLink(goalDir, seal, {
      ts: '2026-07-26T04:00:00.000Z',
      session_id: 'session-a',
      cause: 'tool.1',
      kind: 'state',
      state_hash: '1'.repeat(64),
      diff_hash: '2'.repeat(64),
    });

    const second = await appendLink(goalDir, seal, {
      ts: '2026-07-26T04:00:03.000Z',
      session_id: 'session-b',
      cause: 'external',
      kind: 'state',
      state_hash: '3'.repeat(64),
      diff_hash: '4'.repeat(64),
    });

    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(second.prev).toBe(first.link_hash);
  });
});
