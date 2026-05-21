import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, chmodSync, unlinkSync } from 'node:fs';

describe('guard module', () => {
  it('exports runWeVibeGuard function', async () => {
    const mod = await import('../src/guard.js');
    expect(typeof mod.runWeVibeGuard).toBe('function');
  });

  it('exports getGuardBin function', async () => {
    const mod = await import('../src/guard.js');
    expect(typeof mod.getGuardBin).toBe('function');
  });

  it('getGuardBin returns string', async () => {
    const { getGuardBin } = await import('../src/guard.js');
    const bin = getGuardBin();
    expect(typeof bin).toBe('string');
    expect(bin.length).toBeGreaterThan(0);
  });

  describe('runWeVibeGuard behavior', () => {
    const originalEnv = process.env.WEVIBE_GUARD_BIN;

    afterEach(() => {
      if (originalEnv) {
        process.env.WEVIBE_GUARD_BIN = originalEnv;
      } else {
        delete process.env.WEVIBE_GUARD_BIN;
      }
    });

    it('parses clean scan result from binary', async () => {
      const mockBin = `/tmp/mock-guard-clean-${Date.now()}.sh`;
      writeFileSync(mockBin, `#!/bin/sh\necho '{"passed":true,"detections":[],"flags":null}'`);
      chmodSync(mockBin, '755');
      process.env.WEVIBE_GUARD_BIN = mockBin;

      const { runWeVibeGuard } = await import('../src/guard.js');
      const result = runWeVibeGuard('safe text about redis configuration', [], {});
      expect(result.passed).toBe(true);
      expect(result.detections).toHaveLength(0);

      unlinkSync(mockBin);
    });

    it('parses detection result from binary', async () => {
      const mockBin = `/tmp/mock-guard-detect-${Date.now()}.sh`;
      const response = JSON.stringify({
        passed: false,
        detections: [{ field: 'text', scanner: 'credentials', rule: 'aws_key', matched: 'AKIA...' }],
        flags: null,
      });
      writeFileSync(mockBin, `#!/bin/sh\necho '${response}'`);
      chmodSync(mockBin, '755');
      process.env.WEVIBE_GUARD_BIN = mockBin;

      const { runWeVibeGuard } = await import('../src/guard.js');
      const result = runWeVibeGuard('text with AKIAIOSFODNN7EXAMPLE', [], {});
      expect(result.passed).toBe(false);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].field).toBe('text');
      expect(result.detections[0].scanner).toBe('credentials');
      expect(result.detections[0].rule).toBe('aws_key');

      unlinkSync(mockBin);
    });

    it('throws when binary is not found', async () => {
      process.env.WEVIBE_GUARD_BIN = '/nonexistent/path/wevibe-guard';

      const { runWeVibeGuard } = await import('../src/guard.js');
      expect(() => runWeVibeGuard('text', [], {})).toThrow('wevibe-guard unavailable');
    });

    it('throws when binary returns non-zero exit', async () => {
      const mockBin = `/tmp/mock-guard-fail-${Date.now()}.sh`;
      writeFileSync(mockBin, `#!/bin/sh\nexit 1`);
      chmodSync(mockBin, '755');
      process.env.WEVIBE_GUARD_BIN = mockBin;

      const { runWeVibeGuard } = await import('../src/guard.js');
      expect(() => runWeVibeGuard('text', [], {})).toThrow('wevibe-guard unavailable');

      unlinkSync(mockBin);
    });

    it('passes structured memory format in input', async () => {
      const mockBin = `/tmp/mock-guard-input-${Date.now()}.sh`;
      writeFileSync(mockBin, `#!/bin/sh
cat > /tmp/guard-input-check.json
echo '{"passed":true,"detections":[],"flags":null}'`);
      chmodSync(mockBin, '755');
      process.env.WEVIBE_GUARD_BIN = mockBin;

      const { runWeVibeGuard } = await import('../src/guard.js');
      runWeVibeGuard('test content', ['typescript', 'react'], { env: 'test' }, { stack: ['node'] });

      const { readFileSync } = await import('node:fs');
      const input = JSON.parse(readFileSync('/tmp/guard-input-check.json', 'utf-8'));
      expect(input.memory.text).toBe('test content');
      expect(input.memory.keywords).toEqual(['typescript', 'react']);
      expect(input.memory.metadata).toEqual({ env: 'test' });
      expect(input.stack).toEqual(['node']);
      expect(input.include_flags).toBe(false);

      unlinkSync(mockBin);
      try { unlinkSync('/tmp/guard-input-check.json'); } catch {}
    });

    it('detects injection in keyword field', async () => {
      const mockBin = `/tmp/mock-guard-kw-inject-${Date.now()}.sh`;
      writeFileSync(mockBin, `#!/bin/sh\necho '{"passed":false,"detections":[{"field":"keywords[0]","scanner":"yara","rule":"instruction_bypass","matched":"instruction_bypass"}],"flags":null}'`);
      chmodSync(mockBin, '755');
      process.env.WEVIBE_GUARD_BIN = mockBin;

      const { runWeVibeGuard } = await import('../src/guard.js');
      const result = runWeVibeGuard(
        'Normal memory text',
        ['ignore previous instructions'],
        {},
      );
      expect(result.passed).toBe(false);
      expect(result.detections.some((d: { field: string }) => d.field.startsWith('keywords['))).toBe(true);

      unlinkSync(mockBin);
    });

    it('detects credential in metadata field', async () => {
      const mockBin = `/tmp/mock-guard-meta-cred-${Date.now()}.sh`;
      writeFileSync(mockBin, `#!/bin/sh\necho '{"passed":false,"detections":[{"field":"metadata.api_key","scanner":"credentials","rule":"openai_key","matched":"sk-proj-..."}],"flags":null}'`);
      chmodSync(mockBin, '755');
      process.env.WEVIBE_GUARD_BIN = mockBin;

      const { runWeVibeGuard } = await import('../src/guard.js');
      const result = runWeVibeGuard(
        'Normal memory text',
        [],
        { api_key: 'sk-proj-abc123def456ghi789jkl012mno345' },
      );
      expect(result.passed).toBe(false);
      expect(result.detections.some((d: { field: string }) => d.field === 'metadata.api_key')).toBe(true);

      unlinkSync(mockBin);
    });
  });
});
