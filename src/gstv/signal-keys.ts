export type SignalKeyMode = 'parsed' | 'raw';
export type SignalFramework = 'vitest' | 'jest' | 'pytest' | 'go-test' | 'cargo' | 'compiler' | 'lsp' | 'unknown';

export interface CanonicalSignalKey {
  key: string;
  mode: SignalKeyMode;
  framework: SignalFramework;
}

const MAX_KEY_LENGTH = 240;
const TRUNCATION_SUFFIX = '...[trunc]';

type SignalKind = 'tool_error' | 'command_failure' | 'test_failure' | 'user_feedback';

interface CanonicalizeInput {
  kind: SignalKind;
  label: string;
  excerpt?: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeKey(value: string): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= MAX_KEY_LENGTH) {
    return collapsed;
  }
  const keep = Math.max(0, MAX_KEY_LENGTH - TRUNCATION_SUFFIX.length);
  return `${collapsed.slice(0, keep)}${TRUNCATION_SUFFIX}`;
}

function firstToken(value: string): string {
  const token = collapseWhitespace(value).split(' ').find(part => part.length > 0);
  return token ?? 'unknown-cmd';
}

function normalizeFilePath(rawPath: string): string {
  let normalized = collapseWhitespace(rawPath)
    .replace(/^[\s("'`]+/, '')
    .replace(/[\s)"'`,;:]+$/, '');
  normalized = normalized.replace(/\(\d+,\s*\d+\)$/, '');
  normalized = normalized.replace(/:\d+(?::\d+)?$/, '');
  return normalized;
}

function normalizeTestName(rawName: string): string {
  return collapseWhitespace(rawName)
    .replace(/\s*[›>]+\s*/g, ' > ')
    .replace(/^\s*[-–—:]+\s*/, '')
    .trim();
}

function extractQuotedSymbol(message: string): string {
  const matches = Array.from(message.matchAll(/["'`]([A-Za-z_][A-Za-z0-9_$.:-]*)["'`]/g), match => match[1]);
  const unique = Array.from(new Set(matches));
  return unique.length === 1 ? unique[0]! : 'unknown';
}

function buildTestKey(file: string, testName: string): string {
  return `test:${normalizeFilePath(file)}::${normalizeTestName(testName)}`;
}

function parseVitest(text: string): { file: string; testName: string } | null {
  let file = '';
  let testName = '';

  const failWithName = text.match(/^\s*FAIL\s+([^\s]+)\s+>\s+(.+)$/m);
  if (failWithName) {
    file = normalizeFilePath(failWithName[1] ?? '');
    testName = normalizeTestName(failWithName[2] ?? '');
  }

  if (!file) {
    const failFileOnly = text.match(/^\s*FAIL\s+([^\s]+)\s*$/m);
    if (failFileOnly) {
      file = normalizeFilePath(failFileOnly[1] ?? '');
    }
  }

  if (!testName) {
    const crossLine = text.match(/^\s*[×✗]\s+(.+)$/m);
    if (crossLine) {
      testName = normalizeTestName(crossLine[1] ?? '');
    }
  }

  if (!file || !testName) {
    return null;
  }
  return { file, testName };
}

function parseJest(text: string): { file: string; testName: string } | null {
  const testLine = text.match(/^\s*●\s+(.+)$/m);
  if (!testLine) {
    return null;
  }

  const testName = normalizeTestName(testLine[1] ?? '');
  const failFile = text.match(/^\s*FAIL\s+([^\s]+)\s*$/m);
  const stackFile = text.match(/\bat\s+.+?\(([^()]+):\d+:\d+\)/m);
  const file = normalizeFilePath((failFile?.[1] ?? stackFile?.[1] ?? ''));
  if (!file || !testName) {
    return null;
  }

  return { file, testName };
}

function parsePytest(text: string): { file: string; testName: string } | null {
  const match = text.match(/^\s*FAILED\s+(.+?\.py)::([^\n]+?)(?:\s+-|\s*$)/m);
  if (!match) {
    return null;
  }

  const file = normalizeFilePath(match[1] ?? '');
  const testName = normalizeTestName(match[2] ?? '');
  if (!file || !testName) {
    return null;
  }

  return { file, testName };
}

function parseGoTest(text: string): { file: string; testName: string } | null {
  const failMatch = text.match(/^\s*--- FAIL:\s+([^\s(]+)\s+\(/m);
  const fileMatch = text.match(/\b([A-Za-z0-9_./-]+_test\.go):\d+(?::\d+)?\b/m);
  if (!failMatch || !fileMatch) {
    return null;
  }

  const file = normalizeFilePath(fileMatch[1] ?? '');
  const testName = normalizeTestName(failMatch[1] ?? '');
  if (!file || !testName) {
    return null;
  }

  return { file, testName };
}

function parseCargoTest(text: string): { file: string; testName: string } | null {
  const inline = text.match(/^\s*test\s+([A-Za-z0-9_:]+)\s+\.\.\.\s+FAILED\s*$/m);
  const failureBlock = text.match(/^\s*----\s+([A-Za-z0-9_:]+)\s+stdout\s+----\s*$/m);
  const testName = normalizeTestName((inline?.[1] ?? failureBlock?.[1] ?? ''));
  const fileMatch = text.match(/,\s*([A-Za-z0-9_./-]+\.rs):\d+(?::\d+)?\b/m);
  const file = normalizeFilePath(fileMatch?.[1] ?? '');

  if (!file || !testName) {
    return null;
  }

  return { file, testName };
}

function parseCompilerOrLsp(text: string): { framework: SignalFramework; code: string; file: string; symbol: string } | null {
  const tsCompiler = text.match(/([^\s()]+\.(?:ts|tsx|js|jsx))\(\d+,\s*\d+\):\s*error\s+([A-Z]+\d+):\s*([^\n]+)/m);
  if (tsCompiler) {
    const file = normalizeFilePath(tsCompiler[1] ?? '');
    const code = collapseWhitespace(tsCompiler[2] ?? '') || 'unknown';
    if (file) {
      return {
        framework: 'compiler',
        code,
        file,
        symbol: extractQuotedSymbol(tsCompiler[3] ?? ''),
      };
    }
  }

  const lspTs = text.match(/([^\s:]+\.(?:ts|tsx|js|jsx)):\d+:\d+\s*-\s*error\s+([A-Z]+\d+):\s*([^\n]+)/m);
  if (lspTs) {
    const file = normalizeFilePath(lspTs[1] ?? '');
    const code = collapseWhitespace(lspTs[2] ?? '') || 'unknown';
    if (file) {
      return {
        framework: 'lsp',
        code,
        file,
        symbol: extractQuotedSymbol(lspTs[3] ?? ''),
      };
    }
  }

  const rustCode = text.match(/error\[(E\d+)\]:\s*([^\n]*)/m);
  const rustFile = text.match(/^\s*-->\s+([^\s:]+\.rs):\d+:\d+\s*$/m);
  if (rustCode && rustFile) {
    const file = normalizeFilePath(rustFile[1] ?? '');
    if (file) {
      return {
        framework: 'compiler',
        code: collapseWhitespace(rustCode[1] ?? '') || 'unknown',
        file,
        symbol: extractQuotedSymbol(rustCode[2] ?? ''),
      };
    }
  }

  const genericFile = text.match(/([^\s:]+\.[A-Za-z0-9]+):\d+(?::\d+)?(?:\s|:|$)/m);
  if (genericFile) {
    const file = normalizeFilePath(genericFile[1] ?? '');
    if (file) {
      return {
        framework: 'compiler',
        code: 'unknown',
        file,
        symbol: 'unknown',
      };
    }
  }

  return null;
}

function parsed(input: string, framework: SignalFramework): CanonicalSignalKey {
  return {
    key: safeKey(input),
    mode: 'parsed',
    framework,
  };
}

function rawKey(input: CanonicalizeInput): CanonicalSignalKey {
  if (input.kind === 'user_feedback') {
    return { key: safeKey('user:feedback'), mode: 'raw', framework: 'unknown' };
  }

  if (input.kind === 'test_failure') {
    const label = collapseWhitespace(asString(input.label)) || 'unknown-tool';
    return { key: safeKey(`test:${label}`), mode: 'raw', framework: 'unknown' };
  }

  if (input.kind === 'command_failure') {
    return { key: safeKey(`cmd:${firstToken(asString(input.label))}`), mode: 'raw', framework: 'unknown' };
  }

  const label = collapseWhitespace(asString(input.label)) || 'unknown-tool';
  return { key: safeKey(`tool:${label}`), mode: 'raw', framework: 'unknown' };
}

export function canonicalizeSignalKey(input: CanonicalizeInput): CanonicalSignalKey {
  const label = asString(input.label);
  const excerpt = asString(input.excerpt);
  const text = `${label}\n${excerpt}`;

  if (input.kind === 'test_failure') {
    const vitest = parseVitest(text);
    if (vitest) {
      return parsed(buildTestKey(vitest.file, vitest.testName), 'vitest');
    }

    const jest = parseJest(text);
    if (jest) {
      return parsed(buildTestKey(jest.file, jest.testName), 'jest');
    }

    const pytest = parsePytest(text);
    if (pytest) {
      return parsed(buildTestKey(pytest.file, pytest.testName), 'pytest');
    }

    const goTest = parseGoTest(text);
    if (goTest) {
      return parsed(buildTestKey(goTest.file, goTest.testName), 'go-test');
    }

    const cargo = parseCargoTest(text);
    if (cargo) {
      return parsed(buildTestKey(cargo.file, cargo.testName), 'cargo');
    }
  }

  if (input.kind !== 'user_feedback') {
    const err = parseCompilerOrLsp(text);
    if (err) {
      return parsed(`err:(${err.code}, ${err.file}, ${err.symbol})`, err.framework);
    }
  }

  return rawKey(input);
}

export function signalKeyModeAggregate(modes: SignalKeyMode[]): 'parsed' | 'raw' | 'mixed' | 'absent' {
  if (modes.length === 0) {
    return 'absent';
  }

  const unique = new Set(modes);
  if (unique.size === 1) {
    return modes[0] ?? 'absent';
  }

  return 'mixed';
}
