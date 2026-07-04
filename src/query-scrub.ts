import { extractArtifacts } from './artifact-extract.js';
import { checkArtifactPolicy } from './artifact-policy.js';
import { transformMemoryContent } from './artifact-transform.js';
import type { RetrieveInput } from './retrieve-cli.js';

type EgressMode = 'local_only' | 'allowlist' | 'unrestricted';

const PEM_PRIVATE_KEY_REGEX = /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g;
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const AWS_ACCESS_KEY_REGEX = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN_REGEX = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const SLACK_TOKEN_REGEX = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const BEARER_TOKEN_REGEX = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const SECRET_ASSIGNMENT_REGEX = /\b(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|auth[_-]?token|authorization)\b(\s*[:=]\s*)(['"]?)[^\s'"]+\3/gi;
const LONG_HEX_REGEX = /\b[0-9a-fA-F]{32,}\b/g;
const LONG_BASE64ISH_REGEX = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const UNIX_ABSOLUTE_PATH_REGEX = /(?:\/(?:Users|home|root|var|tmp|opt|etc|private)\/[^\s'"]*)/g;
const WINDOWS_ABSOLUTE_PATH_REGEX = /[A-Za-z]:\\[^\s'"]*/g;

function scrubField(
  value: string,
  egressMode: EgressMode,
  allowedDomains: string[],
): string {
  try {
    let s = typeof value === 'string' ? value : String(value ?? '');

    s = s.replace(PEM_PRIVATE_KEY_REGEX, '<redacted-secret>');
    s = s.replace(JWT_REGEX, '<redacted-token>');
    s = s.replace(AWS_ACCESS_KEY_REGEX, '<redacted-secret>');
    s = s.replace(GITHUB_TOKEN_REGEX, '<redacted-token>');
    s = s.replace(SLACK_TOKEN_REGEX, '<redacted-token>');
    s = s.replace(BEARER_TOKEN_REGEX, 'Bearer <redacted-token>');
    s = s.replace(SECRET_ASSIGNMENT_REGEX, '$1$2<redacted-secret>');
    s = s.replace(LONG_HEX_REGEX, '<redacted-secret>');
    s = s.replace(LONG_BASE64ISH_REGEX, '<redacted-secret>');

    s = s.replace(EMAIL_REGEX, '<redacted-email>');

    s = s.replace(UNIX_ABSOLUTE_PATH_REGEX, '<redacted-path>');
    s = s.replace(WINDOWS_ABSOLUTE_PATH_REGEX, '<redacted-path>');

    const extraction = extractArtifacts(s);
    const policyResults = checkArtifactPolicy(extraction.artifacts, egressMode, allowedDomains);
    s = transformMemoryContent(s, policyResults).text;

    return s.trim();
  } catch {
    return '<redacted>';
  }
}

function scrubOptionalString(
  value: string | undefined,
  egressMode: EgressMode,
  allowedDomains: string[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return scrubField(value, egressMode, allowedDomains);
}

function scrubOptionalStringArray(
  values: string[] | undefined,
  egressMode: EgressMode,
  allowedDomains: string[],
): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }

  const scrubbed: string[] = [];
  for (const value of values) {
    const sanitized = scrubField(value, egressMode, allowedDomains);
    if (sanitized.length > 0) {
      scrubbed.push(sanitized);
    }
  }

  return scrubbed;
}

function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function normalizeEgressMode(mode: EgressMode): EgressMode {
  if (mode === 'allowlist' || mode === 'unrestricted') {
    return mode;
  }
  return 'local_only';
}

function normalizeAllowedDomains(allowedDomains: string[]): string[] {
  if (!Array.isArray(allowedDomains)) {
    return [];
  }
  return allowedDomains.filter((value): value is string => typeof value === 'string');
}

export function scrubQueryHarvestInput(
  input: RetrieveInput,
  egressMode: EgressMode,
  allowedDomains: string[],
): RetrieveInput {
  try {
    const normalizedMode = normalizeEgressMode(egressMode);
    const normalizedAllowedDomains = normalizeAllowedDomains(allowedDomains);

    return {
      query: scrubField(input.query, normalizedMode, normalizedAllowedDomains),
      limit: input.limit,
      org_id: input.org_id,
      session_id: input.session_id,
      relevance_floor: input.relevance_floor,
      surface_budget: input.surface_budget,
      task: scrubOptionalString(input.task, normalizedMode, normalizedAllowedDomains),
      description: scrubOptionalString(input.description, normalizedMode, normalizedAllowedDomains),
      intent: scrubOptionalString(input.intent, normalizedMode, normalizedAllowedDomains),
      language: scrubOptionalString(input.language, normalizedMode, normalizedAllowedDomains),
      directory: scrubOptionalString(input.directory, normalizedMode, normalizedAllowedDomains),
      projectName: scrubOptionalString(input.projectName, normalizedMode, normalizedAllowedDomains),
      stack: scrubOptionalStringArray(input.stack, normalizedMode, normalizedAllowedDomains),
      technologies: scrubOptionalStringArray(input.technologies, normalizedMode, normalizedAllowedDomains),
      frameworks: scrubOptionalStringArray(input.frameworks, normalizedMode, normalizedAllowedDomains),
      deps: scrubOptionalStringArray(input.deps, normalizedMode, normalizedAllowedDomains),
      errorStrings: scrubOptionalStringArray(input.errorStrings, normalizedMode, normalizedAllowedDomains),
      recentActivity: scrubOptionalStringArray(input.recentActivity, normalizedMode, normalizedAllowedDomains),
      files: scrubOptionalStringArray(input.files, normalizedMode, normalizedAllowedDomains),
    };
  } catch {
    return {
      query: '<redacted>',
      limit: safeRead(() => input.limit),
      org_id: safeRead(() => input.org_id),
      session_id: safeRead(() => input.session_id),
      relevance_floor: safeRead(() => input.relevance_floor),
      surface_budget: safeRead(() => input.surface_budget),
    };
  }
}
