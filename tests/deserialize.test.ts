import { describe, it, expect } from 'vitest';
import { deserializeMemoryResult } from '../src/deserialize.js';

describe('deserializeMemoryResult', () => {
  it('converts snake_case input to camelCase output', () => {
    const raw = {
      cid: 'abc123',
      org_id: 'org-1',
      epoch_id: 5,
      memory_type: 'correct_implementation',
      capsule: 'deadbeef',
      cfrag: 'c0ffee',
      umbral_ciphertext: 'baddad',
      content_flags: ['url', 'endpoint'],
      freshness_score: 0.85,
      retrieval_count: 10,
      acceptance_count: 4,
    };

    const result = deserializeMemoryResult(raw);

    expect(result.cid).toBe('abc123');
    expect(result.orgId).toBe('org-1');
    expect(result.epochId).toBe(5);
    expect(result.memoryType).toBe('correct_implementation');
    expect(result.capsule).toBe('deadbeef');
    expect(result.cfrag).toBe('c0ffee');
    expect(result.umbralCiphertext).toBe('baddad');
    expect(result.contentFlags).toEqual(['url', 'endpoint']);
    expect(result.freshnessScore).toBe(0.85);
    expect(result.retrievalCount).toBe(10);
    expect(result.acceptanceCount).toBe(4);
  });

  it('handles missing optional fields with safe defaults', () => {
    const raw = {
      cid: 'xyz789',
      org_id: 'org-2',
      epoch_id: 3,
      memory_type: 'negative_signal',
      capsule: 'cafebabe',
      cfrag: 'facefeed',
      umbral_ciphertext: 'abbaabba',
    };

    const result = deserializeMemoryResult(raw);

    expect(result.contentFlags).toEqual([]);
    expect(result.freshnessScore).toBe(0);
    expect(result.retrievalCount).toBe(0);
    expect(result.acceptanceCount).toBe(0);
  });

  it('allows field access without TypeError', () => {
    const raw = {
      cid: 'mem1',
      org_id: 'test-org',
      epoch_id: 1,
      memory_type: 'correct_implementation',
      capsule: 'enc1',
      cfrag: 'enc2',
      umbral_ciphertext: 'enc3',
      content_flags: ['url'],
      freshness_score: 0.9,
      retrieval_count: 5,
    };

    const result = deserializeMemoryResult(raw);

    expect(() => {
      result.epochId.toFixed();
      result.contentFlags.join(', ');
      result.freshnessScore.toFixed(2);
    }).not.toThrow();
  });

  it('full roundtrip from hub-shaped JSON to usable object', () => {
    const hubJson = JSON.stringify({
      cid: 'roundtrip-test',
      org_id: 'hub-org',
      epoch_id: 7,
      memory_type: 'negative_signal',
      capsule: 'a1b2c3d4',
      cfrag: 'd4c3b2a1',
      umbral_ciphertext: '00112233',
      content_flags: ['config', 'package_install'],
      freshness_score: 0.75,
      retrieval_count: 42,
    });

    const parsed = JSON.parse(hubJson);
    const result = deserializeMemoryResult(parsed);

    expect(result.orgId).toBe('hub-org');
    expect(result.epochId).toBe(7);
    expect(result.memoryType).toBe('negative_signal');
    expect(result.contentFlags).toHaveLength(2);
    expect(result.freshnessScore).toBe(0.75);
    expect(result.retrievalCount).toBe(42);
  });
});
