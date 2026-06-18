import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.WEVIBE_AUTO_CONTRIBUTE = '0';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('../src/crypto.js', () => ({
  initCrypto: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/key-store.js', () => {
  const mockStore = {
    getPassword: vi.fn().mockResolvedValue(null),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
  };
  return {
    loadIdentity: vi.fn().mockResolvedValue({
      edPubkey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]),
      edPrivkey: new Uint8Array(32),
      xPrivkey: new Uint8Array(32),
      xPubkey: new Uint8Array(32),
    }),
    storeIdentitySeed: vi.fn().mockResolvedValue(undefined),
    generateIdentitySeed: vi.fn().mockReturnValue(new Uint8Array(32)),
    loadKeyEnvelope: vi.fn().mockResolvedValue(null),
    getStore: vi.fn(() => mockStore),
  };
});

const mockMemberships = [{
  orgId: 'test-org', role: 'member' as const, currentEpoch: 0,
  egressMode: 'unrestricted' as const, allowedProviders: [],
  searchKeys: new Map([[0, new Uint8Array(32)]]),
  encKeys: new Map(),
}];

vi.mock('../src/org-client.js', () => ({
  loadMemberships: vi.fn().mockResolvedValue(mockMemberships),
  createOrg: vi.fn().mockResolvedValue({ orgId: 'generated-org', status: 'created' as const }),
  registerPrePubkey: vi.fn().mockResolvedValue(undefined),
  computeQueryTokens: vi.fn().mockReturnValue({ 0: ['token1'] }),
}));

vi.mock('../src/blacklist.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    add_to_blacklist: actual.add_to_blacklist,
    is_blacklisted: actual.is_blacklisted,
    filter_blacklisted: actual.filter_blacklisted,
    get_blacklist: actual.get_blacklist,
  };
});

vi.mock('../src/session.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    dissect_to_keywords: actual.dissect_to_keywords,
    detect_session: vi.fn().mockReturnValue({
      projectName: 'test-project',
      technologies: ['typescript', 'nodejs'],
      recentActivity: [],
      directory: '/test',
      description: 'Test project for unit testing',
    }),
    extract_tech_terms: vi.fn().mockReturnValue(['typescript', 'nodejs']),
  };
});

vi.mock('../src/manifest.js', () => ({
  read_project_manifest: vi.fn().mockResolvedValue(['typescript', 'nodejs']),
}));

vi.mock('../src/buffer.js', () => ({
  update_buffer: vi.fn().mockResolvedValue(undefined),
  list_orphaned_buffers: vi.fn().mockResolvedValue([]),
  read_buffer: vi.fn().mockResolvedValue(null),
  compose_raw_notes_from_buffer: vi.fn().mockResolvedValue(''),
}));

vi.mock('../src/contribution.js', () => ({
  submitMemory: vi.fn().mockResolvedValue({ status: 'ok', submissionHash: 'abc123' }),
}));

describe('tool registration', () => {
  it('registers administrative wevibe tools', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const originalTool = McpServer.prototype.tool;
    const registeredTools: string[] = [];

    McpServer.prototype.tool = function(name: string) {
      registeredTools.push(name);
      return this;
    } as typeof originalTool;

    await import('../src/server.js');

    McpServer.prototype.tool = originalTool;

    expect(registeredTools).toContain('setup_org');
    expect(registeredTools).toContain('wevibe_status');
    expect(registeredTools).toContain('wevibe_set_risk_appetite');
    expect(registeredTools).toContain('wevibe_set_provider_policy');
    expect(registeredTools).toHaveLength(4);
  });
});

describe('wevibe_recall integration flow', () => {
  it('dissect_to_keywords produces weighted keywords from session context', async () => {
    const { dissect_to_keywords } = await import('../src/session.js');
    const keywords = dissect_to_keywords({
      description: 'How to configure Nginx reverse proxy for file uploads',
      technologies: ['nginx', 'nodejs'],
      recentActivity: [],
      directory: '',
      projectName: '',
    });
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.every(kw => kw.weight > 0)).toBe(true);
    const terms = keywords.map(kw => kw.term);
    expect(terms.some(t => t.includes('nginx'))).toBe(true);
  });

  it('deserializeMemoryResult converts hub response to typed object', async () => {
    const { deserializeMemoryResult } = await import('../src/deserialize.js');
    const raw = {
      cid: 'test-cid',
      org_id: 'org-1',
      epoch_id: 2,
      memory_type: 'memory',
      capsule: 'aabbccdd',
      cfrag: 'ccddeeff',
      umbral_ciphertext: '11223344',
      content_flags: ['config'],
      freshness_score: 0.85,
      retrieval_count: 3,
      scoring_breakdown: {
        keyword_score: 1.5,
        vector_score: 0.7,
        gamma: 0.1,
        delta: 0.15,
        capped_boost: 0.105,
        combined_score: 0.805,
        keyword_matches: [],
        unmatched_query_keywords: [],
      },
    };
    const result = deserializeMemoryResult(raw);
    expect(result.cid).toBe('test-cid');
    expect(result.epochId).toBe(2);
    expect(result.breakdown?.combined_score).toBe(0.805);
  });

  it('formatMemoryPresentation with full artifact pipeline output', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const result = formatMemoryPresentation(
      [{
        cid: 'test-cid-full',
        epochId: 1,
        score: 0.85,
        plaintext: 'Set proxy_pass <redacted-external-host>/log for monitoring.',
        artifactSummary: { url: 0, domain: 0, ip_address: 0, shell_command: 0, package_install: 0, config_directive: 1, credential_like: 0 },
        annotations: ['⚠ REDACTED [config_directive]: egress violation: "attacker.com" not in allowlist'],
        redactedCount: 1,
        annotatedCount: 0,
      }],
      'nginx proxy config',
      'recall',
    );
    expect(result).toContain('context:');
    expect(result).toContain('proxy_pass <redacted-external-host>/log');
    expect(result).toContain('[1 artifact(s) redacted]');
    expect(result).toContain('⚠ REDACTED [config_directive]: egress violation: "attacker.com" not in allowlist');
    expect(result).toContain('[redacted content present]');
    expect(result).not.toContain('UNTRUSTED CONTENT');
    expect(result).not.toContain('Artifacts detected');
  });
});

describe('wevibe_reject integration flow', () => {
  const originalHome = process.env.HOME;
  let isolatedHomeDir: string | undefined;

  beforeEach(() => {
    isolatedHomeDir = mkdtempSync(join(tmpdir(), 'wevibe-mcp-test-home-'));
    process.env.HOME = isolatedHomeDir;
  });

  afterEach(() => {
    if (isolatedHomeDir) {
      rmSync(isolatedHomeDir, { recursive: true, force: true });
      isolatedHomeDir = undefined;
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it('add_to_blacklist persists and is_blacklisted returns true', async () => {
    const { add_to_blacklist, is_blacklisted } = await import('../src/blacklist.js');
    const testCid = `theater-fix-${Date.now()}`;
    add_to_blacklist(testCid);
    expect(is_blacklisted(testCid)).toBe(true);
  });
});

describe('resource registration verification', () => {
  it('formatMemoryPresentation returns ambient label for ambient source', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const result = formatMemoryPresentation(
      [{ cid: 'test', epochId: 0, score: 0.5, plaintext: 'content' }],
      'project stack',
      'ambient',
    );
    expect(result).toContain('context:');
    expect(result).toContain('content');
    expect(result).not.toContain('Source:');
    expect(result).not.toContain('Query:');
  });
});

describe('formatMemoryPresentation', () => {
  it('produces compact header and metadata', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const memories = [{
      cid: 'abc123def456',
      epochId: 1,
      score: 0.85,
      plaintext: 'Test memory content',
    }];
    const result = formatMemoryPresentation(memories, 'test query', 'recall');
    expect(result.startsWith('context:')).toBe(true);
    expect(result).toContain('Test memory content');
    expect(result).not.toContain('CID:');
    expect(result).not.toContain('Score:');
  });

  it('omits legacy framing markers', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const memories = [{ cid: 'abc123def456', epochId: 1, score: 0.85, plaintext: 'content' }];
    const result = formatMemoryPresentation(memories, 'query', 'recall');
    expect(result).not.toContain('UNTRUSTED CONTENT');
    expect(result).not.toContain('REFERENCE DATA ONLY');
    expect(result).not.toContain('END WEVIBE MEMORY BLOCK');
  });

  it('adds a separator for each memory', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const memories = [
      { cid: 'cid-1', epochId: 0, score: 0.8, plaintext: 'memory one' },
      { cid: 'cid-2', epochId: 0, score: 0.7, plaintext: 'memory two' },
    ];
    const result = formatMemoryPresentation(memories, 'test query', 'recall');
    expect(result).toContain('memory one\n\nmemory two');
    expect(result).toContain('memory one');
    expect(result).toContain('memory two');
  });

  it('includes redaction summary and taint when redactions present', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const memories = [{
      cid: 'abc123def456',
      epochId: 1,
      score: 0.85,
      plaintext: 'proxy_pass <redacted-external-host>/log',
      redactedCount: 2,
    }];
    const result = formatMemoryPresentation(memories, 'test query', 'recall');
    expect(result).toContain('[2 artifact(s) redacted]');
    expect(result).toContain('[redacted content present]');
  });

  it('omits taint metadata when no redactions', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const memories = [{
      cid: 'abc123def456',
      epochId: 1,
      score: 0.85,
      plaintext: 'Test memory',
    }];
    const result = formatMemoryPresentation(memories, 'test query', 'recall');
    expect(result).not.toContain('[redacted content present]');
    expect(result).not.toContain('[1 artifact(s) redacted]');
  });

  it('includes annotations when present', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const memories = [{
      cid: 'abc123def456',
      epochId: 1,
      score: 0.85,
      plaintext: 'Test memory',
      annotations: ['⚠ [domain]: high-risk artifact — "evil.com"'],
    }];
    const result = formatMemoryPresentation(memories, 'test query', 'recall');
    expect(result).toContain('⚠ [domain]: high-risk artifact — "evil.com"');
  });

  it('suppresses artifact telemetry from output', async () => {
    const { formatMemoryPresentation } = await import('../src/server.js');
    const memories = [{
      cid: 'abc123def456',
      epochId: 1,
      score: 0.85,
      plaintext: 'Test memory with URL https://example.com',
      artifactSummary: { url: 1 },
    }];
    const result = formatMemoryPresentation(memories, 'test query', 'recall');
    expect(result).not.toContain('Artifacts detected');
    expect(result).not.toContain('url=1');
  });
});
