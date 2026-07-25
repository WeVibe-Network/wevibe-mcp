import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveStateDir,
  resolveGstvRoot,
  resolveSpoolDirs,
  goalsDir,
  goalDir,
  sealPath,
  metaPath,
  chainPath,
  observationsPath,
  closedPath,
  offsetsPath,
  walkCachePath,
} from '../src/gstv/paths.js';

describe('gstv/paths resolver helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.WEVIBE_BENCH_CONSUMER_STATE_DIR;
    delete process.env.WEVIBE_GSTV_ROOT;
    delete process.env.WEVIBE_GSTV_SPOOL_DIRS;
  });

  it('resolveStateDir honors env override', () => {
    vi.stubEnv('WEVIBE_BENCH_CONSUMER_STATE_DIR', '/tmp/custom-state');
    expect(resolveStateDir()).toBe('/tmp/custom-state');
  });

  it('resolveStateDir default is ~/.wevibe/state', () => {
    delete process.env.WEVIBE_BENCH_CONSUMER_STATE_DIR;
    expect(resolveStateDir()).toBe(path.join(os.homedir(), '.wevibe', 'state'));
  });

  it('resolveGstvRoot honors env override', () => {
    vi.stubEnv('WEVIBE_GSTV_ROOT', '/tmp/custom-gstv');
    expect(resolveGstvRoot()).toBe('/tmp/custom-gstv');
  });

  it('resolveGstvRoot default is <state>/gstv', () => {
    delete process.env.WEVIBE_GSTV_ROOT;
    vi.stubEnv('WEVIBE_BENCH_CONSUMER_STATE_DIR', '/tmp/state-root');
    expect(resolveGstvRoot()).toBe(path.join('/tmp/state-root', 'gstv'));
  });

  it('resolveSpoolDirs honors env list and filters empties', () => {
    const list = ['/tmp/spool-a', '', '/tmp/spool-b', ''].join(path.delimiter);
    vi.stubEnv('WEVIBE_GSTV_SPOOL_DIRS', list);
    expect(resolveSpoolDirs()).toEqual(['/tmp/spool-a', '/tmp/spool-b']);
  });

  it('resolveSpoolDirs default is <state>/spool', () => {
    delete process.env.WEVIBE_GSTV_SPOOL_DIRS;
    vi.stubEnv('WEVIBE_BENCH_CONSUMER_STATE_DIR', '/tmp/state-default');
    expect(resolveSpoolDirs()).toEqual([path.join('/tmp/state-default', 'spool')]);
  });

  it('layout builders join to the correct files', () => {
    const root = '/tmp/gstv-root';
    const goalId = 'gstv-abcdef1234567890';
    const baseGoalDir = path.join(root, 'goals', goalId);

    expect(goalsDir(root)).toBe(path.join(root, 'goals'));
    expect(goalDir(root, goalId)).toBe(baseGoalDir);
    expect(sealPath(root, goalId)).toBe(path.join(baseGoalDir, 'seal.json'));
    expect(metaPath(root, goalId)).toBe(path.join(baseGoalDir, 'meta.json'));
    expect(chainPath(root, goalId)).toBe(path.join(baseGoalDir, 'chain.jsonl'));
    expect(observationsPath(root, goalId)).toBe(path.join(baseGoalDir, 'observations.jsonl'));
    expect(closedPath(root, goalId)).toBe(path.join(baseGoalDir, 'closed.json'));
    expect(offsetsPath(root)).toBe(path.join(root, 'spool-offsets.json'));
    expect(walkCachePath(root)).toBe(path.join(root, 'walk-cache.json'));
  });
});
