import { describe, expect, it } from 'vitest';
import { scrubQueryHarvestInput } from '../../src/query-scrub.js';
import type { RetrieveInput } from '../../src/retrieve-cli.js';

describe('query scrub security', () => {
  it('strips secrets, PII, machine paths, and egress-violating artifacts', () => {
    const planted = {
      awsKey: 'AKIAIOSFODNN7EXAMPLE',
      githubToken: 'ghp_0123456789abcdefABCDEF0123456789abcd',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc-DEF_123',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
      apiKeyValue: 'SUPERSECRETVALUE123',
      passwordValue: 'hunter2pass',
      absolutePathPrefix: '/Users/jerry',
      absolutePath: '/Users/jerry/secret-proj/src/app.ts',
      email: 'dev@corp.example.com',
      evilUrl: 'https://evil.example.com/exfil',
      evilDomain: 'evil.example.com',
      publicIp: '203.0.113.5',
    };

    const input: RetrieveInput = {
      query: `debug ${planted.evilUrl} from ${planted.publicIp}`,
      task: `token ${planted.githubToken}`,
      description: `${planted.jwt} ${planted.pem}`,
      intent: `api_key=${planted.apiKeyValue}`,
      language: `password: ${planted.passwordValue}`,
      directory: planted.absolutePath,
      projectName: planted.email,
      stack: [planted.awsKey],
      technologies: [planted.githubToken],
      frameworks: [planted.jwt],
      deps: [planted.pem],
      errorStrings: [`api_key=${planted.apiKeyValue}`],
      recentActivity: [`password: ${planted.passwordValue}`],
      files: [planted.absolutePath, planted.evilUrl, planted.email, planted.publicIp],
      limit: 3,
      org_id: 'org-sec',
      session_id: 'sess-sec',
      relevance_floor: 0.33,
      surface_budget: 9,
    };

    const output = scrubQueryHarvestInput(input, 'local_only', []);
    const serialized = JSON.stringify(output);

    const forbiddenSubstrings = [
      planted.awsKey,
      planted.githubToken,
      planted.jwt,
      planted.apiKeyValue,
      planted.passwordValue,
      planted.absolutePathPrefix,
      planted.email,
      planted.evilDomain,
      planted.publicIp,
      'MIIEabc',
      'BEGIN RSA PRIVATE KEY',
    ];

    for (const secret of forbiddenSubstrings) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).toContain('<redacted-secret>');
    expect(serialized).toContain('<redacted-token>');
    expect(serialized).toContain('<redacted-email>');
    expect(serialized).toContain('<redacted-path>');
    expect(serialized).toContain('<redacted-external-host>');
    expect(serialized).toContain('<redacted-ip>');
  });

  it('passes clean fields through unchanged', () => {
    const input: RetrieveInput = {
      query: 'Fix redis reconnect backoff',
      task: 'Fix redis reconnect backoff',
      language: 'TypeScript',
      files: ['src/cache.ts', 'tests/cache.test.ts'],
      stack: ['Node.js', 'Redis'],
      limit: 5,
    };

    const output = scrubQueryHarvestInput(input, 'local_only', []);

    expect(output.query).toBe('Fix redis reconnect backoff');
    expect(output.task).toBe('Fix redis reconnect backoff');
    expect(output.language).toBe('TypeScript');
    expect(output.files).toEqual(['src/cache.ts', 'tests/cache.test.ts']);
    expect(output.stack).toEqual(['Node.js', 'Redis']);
  });

  it('is fail-closed and preserves pass-through scalars', () => {
    const planted = {
      githubToken: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      awsKey: 'AKIAIOSFODNN7EXAMPLE',
      apiSecret: 'DO-NOT-LEAK-THIS-SECRET',
    };

    const input: RetrieveInput = {
      query: 'Investigate intermittent auth timeout',
      task: planted.githubToken,
      stack: ['Node.js', `api_key=${planted.apiSecret}`],
      frameworks: [planted.awsKey],
      errorStrings: ['   ', planted.githubToken],
      limit: 7,
      org_id: 'org-7',
      session_id: 'sess-7',
      relevance_floor: 0.42,
      surface_budget: 11,
    };

    const output = scrubQueryHarvestInput(input, 'local_only', []);

    expect(output.limit).toBe(7);
    expect(output.org_id).toBe('org-7');
    expect(output.session_id).toBe('sess-7');
    expect(output.relevance_floor).toBe(0.42);
    expect(output.surface_budget).toBe(11);

    expect(output.task).toBe('<redacted-token>');
    expect(output.stack).toEqual(['Node.js', 'api_key=<redacted-secret>']);
    expect(output.frameworks).toEqual(['<redacted-secret>']);
    expect(output.errorStrings).toEqual(['<redacted-token>']);

    const leakedNeedles = [planted.githubToken, planted.awsKey, planted.apiSecret];
    for (const value of Object.values(output)) {
      if (typeof value === 'string') {
        for (const needle of leakedNeedles) {
          expect(value).not.toContain(needle);
        }
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          for (const needle of leakedNeedles) {
            expect(entry).not.toContain(needle);
          }
        }
      }
    }
  });

  it('falls back to redacted skeleton on catastrophic scrub failure', () => {
    const throwingInput = {
      get query(): string {
        throw new Error('boom');
      },
      limit: 13,
      org_id: 'org-catastrophic',
      session_id: 'sess-catastrophic',
      relevance_floor: 0.77,
      surface_budget: 14,
    } as unknown as RetrieveInput;

    const output = scrubQueryHarvestInput(throwingInput, 'local_only', []);

    expect(output).toEqual({
      query: '<redacted>',
      limit: 13,
      org_id: 'org-catastrophic',
      session_id: 'sess-catastrophic',
      relevance_floor: 0.77,
      surface_budget: 14,
    });
  });

  it('preserves allowlisted URLs and redacts non-allowlisted URLs', () => {
    const input: RetrieveInput = {
      query: 'Compare https://github.com/x with https://evil.example.com/exfil',
    };

    const output = scrubQueryHarvestInput(input, 'allowlist', ['github.com']);

    expect(output.query).toContain('https://github.com/x');
    expect(output.query).not.toContain('evil.example.com');
    expect(output.query).toContain('<redacted-external-host>/exfil');
  });
});
