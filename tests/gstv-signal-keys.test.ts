import { describe, expect, it } from 'vitest';

import { canonicalizeSignalKey, signalKeyModeAggregate } from '../src/gstv/signal-keys.js';

describe('signal-keys canonicalization', () => {
  describe('vitest', () => {
    it('parses FAIL + suite chain + × line into canonical test key', () => {
      const result = canonicalizeSignalKey({
        kind: 'test_failure',
        label: 'vitest run',
        excerpt: [
          ' FAIL  src/foo/bar.test.ts > auth service > rejects expired token',
          '   × auth service > rejects expired token',
        ].join('\n'),
      });

      expect(result).toEqual({
        key: 'test:src/foo/bar.test.ts::auth service > rejects expired token',
        mode: 'parsed',
        framework: 'vitest',
      });
      expect(result.key).not.toMatch(/:\d/);
    });
  });

  describe('jest', () => {
    it('parses ● suite › test and file from stack frame', () => {
      const result = canonicalizeSignalKey({
        kind: 'test_failure',
        label: 'jest',
        excerpt: [
          '● billing suite › applies annual discount',
          '  at Object.<anonymous> (src/billing/discount.test.ts:88:21)',
        ].join('\n'),
      });

      expect(result).toEqual({
        key: 'test:src/billing/discount.test.ts::billing suite > applies annual discount',
        mode: 'parsed',
        framework: 'jest',
      });
      expect(result.key).not.toContain(':88:21');
    });
  });

  describe('pytest', () => {
    it('parses FAILED path::test_name lines', () => {
      const result = canonicalizeSignalKey({
        kind: 'test_failure',
        label: 'pytest -q',
        excerpt: 'FAILED tests/test_orders.py::test_retries_on_timeout - AssertionError: expected 2 got 1',
      });

      expect(result).toEqual({
        key: 'test:tests/test_orders.py::test_retries_on_timeout',
        mode: 'parsed',
        framework: 'pytest',
      });
    });
  });

  describe('go test', () => {
    it('parses --- FAIL and _test.go line refs', () => {
      const result = canonicalizeSignalKey({
        kind: 'test_failure',
        label: 'go test ./...',
        excerpt: [
          '--- FAIL: TestHandleReconnect (0.00s)',
          '    reconnect_test.go:12: expected retry budget to decrease',
        ].join('\n'),
      });

      expect(result).toEqual({
        key: 'test:reconnect_test.go::TestHandleReconnect',
        mode: 'parsed',
        framework: 'go-test',
      });
      expect(result.key).not.toContain(':12');
    });
  });

  describe('cargo', () => {
    it('parses cargo failed test and panicked file location', () => {
      const result = canonicalizeSignalKey({
        kind: 'test_failure',
        label: 'cargo test',
        excerpt: [
          'test tests::parser::rejects_bad_input ... FAILED',
          'thread \'tests::parser::rejects_bad_input\' panicked at \"boom\", src/parser.rs:12:3',
          'failures:',
        ].join('\n'),
      });

      expect(result).toEqual({
        key: 'test:src/parser.rs::tests::parser::rejects_bad_input',
        mode: 'parsed',
        framework: 'cargo',
      });
      expect(result.key).not.toContain(':12:3');
    });
  });

  describe('compiler and lsp', () => {
    it('parses ts compiler errors with code, file, symbol', () => {
      const result = canonicalizeSignalKey({
        kind: 'tool_error',
        label: "src/foo.ts(12,34): error TS2322: Type 'Result' is not assignable to type 'Output'",
      });

      expect(result).toEqual({
        key: 'err:(TS2322, src/foo.ts, unknown)',
        mode: 'parsed',
        framework: 'compiler',
      });
      expect(result.key).not.toContain('(12,34)');
    });

    it('parses rust compiler errors with code and drops line numbers', () => {
      const result = canonicalizeSignalKey({
        kind: 'tool_error',
        label: [
          'error[E0308]: mismatched types',
          ' --> src/main.rs:12:5',
        ].join('\n'),
      });

      expect(result).toEqual({
        key: 'err:(E0308, src/main.rs, unknown)',
        mode: 'parsed',
        framework: 'compiler',
      });
      expect(result.key).not.toContain(':12:5');
    });

    it('parses lsp-style ts diagnostics', () => {
      const result = canonicalizeSignalKey({
        kind: 'tool_error',
        label: "src/client/foo.ts:22:9 - error TS2345: Argument of type 'Bar' is not assignable to parameter of type 'Baz'",
      });

      expect(result).toEqual({
        key: 'err:(TS2345, src/client/foo.ts, unknown)',
        mode: 'parsed',
        framework: 'lsp',
      });
      expect(result.key).not.toContain(':22:9');
    });

    it('allows unknown error code when file is parseable', () => {
      const result = canonicalizeSignalKey({
        kind: 'command_failure',
        label: 'go build ./...',
        excerpt: 'src/main.go:12: undefined: madeUpIdentifier',
      });

      expect(result).toEqual({
        key: 'err:(unknown, src/main.go, unknown)',
        mode: 'parsed',
        framework: 'compiler',
      });
      expect(result.key).not.toContain(':12');
    });
  });

  describe('raw-mode fallbacks preserve legacy shape', () => {
    it('returns raw key for unrecognized text', () => {
      const cmd = canonicalizeSignalKey({
        kind: 'command_failure',
        label: 'go test ./... -run TestThing',
        excerpt: 'process exited with status 1',
      });
      const test = canonicalizeSignalKey({
        kind: 'test_failure',
        label: 'npm test',
        excerpt: 'something failed without parser pattern',
      });
      const tool = canonicalizeSignalKey({
        kind: 'tool_error',
        label: 'lint runner',
        excerpt: 'unexpected error object',
      });
      const user = canonicalizeSignalKey({
        kind: 'user_feedback',
        label: 'still broken',
      });

      expect(cmd).toEqual({ key: 'cmd:go', mode: 'raw', framework: 'unknown' });
      expect(test).toEqual({ key: 'test:npm test', mode: 'raw', framework: 'unknown' });
      expect(tool).toEqual({ key: 'tool:lint runner', mode: 'raw', framework: 'unknown' });
      expect(user).toEqual({ key: 'user:feedback', mode: 'raw', framework: 'unknown' });
    });
  });

  describe('key safety', () => {
    it('collapses whitespace and removes newlines', () => {
      const result = canonicalizeSignalKey({
        kind: 'tool_error',
        label: '   lint\n\nrunner\t\talpha   ',
      });

      expect(result.mode).toBe('raw');
      expect(result.key).toBe('tool:lint runner alpha');
      expect(result.key).not.toContain('\n');
      expect(result.key).not.toMatch(/\s{2,}/);
    });

    it('enforces deterministic 240-char bound with stable truncation suffix', () => {
      const veryLongLabel = `lint-${'x'.repeat(600)}`;
      const result = canonicalizeSignalKey({
        kind: 'tool_error',
        label: veryLongLabel,
      });

      expect(result.mode).toBe('raw');
      expect(result.key.length).toBeLessThanOrEqual(240);
      expect(result.key.endsWith('...[trunc]')).toBe(true);
    });
  });

  describe('signalKeyModeAggregate', () => {
    it('returns absent for empty set', () => {
      expect(signalKeyModeAggregate([])).toBe('absent');
    });

    it('returns parsed when all are parsed', () => {
      expect(signalKeyModeAggregate(['parsed', 'parsed'])).toBe('parsed');
    });

    it('returns raw when all are raw', () => {
      expect(signalKeyModeAggregate(['raw', 'raw'])).toBe('raw');
    });

    it('returns mixed when both modes are present', () => {
      expect(signalKeyModeAggregate(['parsed', 'raw', 'parsed'])).toBe('mixed');
    });
  });
});
