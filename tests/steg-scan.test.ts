import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { scanForSteganography } from '../src/moderation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

describe('scanForSteganography', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns clean result for normal text', () => {
    const mockResult = {
      status: 0,
      stdout: JSON.stringify({
        version: '1.0.0',
        input_bytes: 30,
        findings_count: 0,
        clean: true,
        findings: [],
      }),
      stderr: '',
      error: undefined,
    };
    vi.mocked(spawnSync).mockReturnValue(mockResult as unknown as ReturnType<typeof spawnSync>);

    const result = scanForSteganography('This is clean text about React hooks');

    expect(result).not.toBeNull();
    expect(result?.clean).toBe(true);
    expect(result?.findings_count).toBe(0);
  });

  it('returns findings for text with zero-width characters', () => {
    const mockResult = {
      status: 0,
      stdout: JSON.stringify({
        version: '1.0.0',
        input_bytes: 19,
        findings_count: 1,
        clean: false,
        findings: [
          {
            type: 'detector',
            name: 'unicode_steg',
            severity: 'high',
            details: { found: true, invisible_chars: 3 },
          },
        ],
      }),
      stderr: '',
      error: undefined,
    };
    vi.mocked(spawnSync).mockReturnValue(mockResult as unknown as ReturnType<typeof spawnSync>);

    const result = scanForSteganography('Hello\u200b\u200c\u200dworld');

    expect(result).not.toBeNull();
    expect(result?.clean).toBe(false);
    expect(result?.findings_count).toBe(1);
    expect(result?.findings[0].name).toBe('unicode_steg');
    expect(result?.findings[0].severity).toBe('high');
  });

  it('returns null on subprocess timeout', () => {
    const mockResult = {
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn ETIMEDOUT'),
    };
    vi.mocked(spawnSync).mockReturnValue(mockResult as unknown as ReturnType<typeof spawnSync>);

    const result = scanForSteganography('Some text that would timeout');

    expect(result).toBeNull();
  });

  it('returns null on subprocess error', () => {
    const mockResult = {
      status: 1,
      stdout: '',
      stderr: 'Python not found',
      error: undefined,
    };
    vi.mocked(spawnSync).mockReturnValue(mockResult as unknown as ReturnType<typeof spawnSync>);

    const result = scanForSteganography('Some text');

    expect(result).toBeNull();
  });

  it('returns null on invalid JSON output', () => {
    const mockResult = {
      status: 0,
      stdout: 'not valid json',
      stderr: '',
      error: undefined,
    };
    vi.mocked(spawnSync).mockReturnValue(mockResult as unknown as ReturnType<typeof spawnSync>);

    const result = scanForSteganography('Some text');

    expect(result).toBeNull();
  });

  it('returns null when subprocess exits with non-zero status', () => {
    const mockResult = {
      status: 1,
      stdout: JSON.stringify({ error: 'input_too_large' }),
      stderr: '',
      error: undefined,
    };
    vi.mocked(spawnSync).mockReturnValue(mockResult as unknown as ReturnType<typeof spawnSync>);

    const result = scanForSteganography('Some text');

    expect(result).toBeNull();
  });
});

describe('scanForSteganography integration', () => {
  const sidecarAvailable = (() => {
    try {
      const result = spawnSync('python3', ['-c', 'import analysis_tools'], { encoding: 'utf-8', timeout: 5000 });
      if (result.status !== 0) return false;
      const probe = spawnSync('python3', ['scripts/wevibe-steg-scan.py'], { input: 'test', encoding: 'utf-8', timeout: 5000 });
      return probe.status === 0;
    } catch {
      return false;
    }
  })();

  it.skipIf(!sidecarAvailable)('real sidecar: clean input returns clean', () => {
    const result = scanForSteganography('This is clean text about React hooks and side effects');

    expect(result).not.toBeNull();
    expect(result?.clean).toBe(true);
    expect(result?.version).toBe('1.0.0');
  });

  it.skipIf(!sidecarAvailable)('real sidecar: zero-width chars detected', () => {
    const result = scanForSteganography('Hello\u200b\u200c\u200dworld');

    expect(result).not.toBeNull();
    expect(result?.clean).toBe(false);
    expect(result?.findings_count).toBeGreaterThanOrEqual(1);
    const hasUnicodeSteg = result?.findings.some(f => f.name === 'unicode_steg');
    expect(hasUnicodeSteg).toBe(true);
  });

  it.skipIf(!sidecarAvailable)('real sidecar: homoglyph detected', () => {
    const result = scanForSteganography('P\u0430ssword');

    expect(result).not.toBeNull();
    expect(result?.clean).toBe(false);
    const hasHomoglyph = result?.findings.some(f => f.name === 'homoglyph');
    expect(hasHomoglyph).toBe(true);
  });
});
