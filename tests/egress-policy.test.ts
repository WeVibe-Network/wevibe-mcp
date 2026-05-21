import { describe, it, expect } from 'vitest';
import { checkEgressPolicy } from '../src/org-client.js';
import type { OrgMembership } from '../src/types.js';

function makeMembership(egressMode: OrgMembership['egressMode'], allowedProviders: string[]): OrgMembership {
  return {
    orgId: 'test-org',
    orgName: 'Test Org',
    role: 'member',
    currentEpoch: 1,
    historyAccessFromEpoch: 1,
    egressMode,
    allowedProviders,
    encKeys: new Map(),
    searchKeys: new Map(),
    modPubkey: null,
  };
}

describe('egress-policy', () => {
  it('test_local_only_allows_null_provider', () => {
    const m = makeMembership('local_only', []);
    expect(checkEgressPolicy(m, null)).toBe(true);
  });

  it('test_local_only_blocks_remote_provider', () => {
    const m = makeMembership('local_only', []);
    expect(checkEgressPolicy(m, 'openai')).toBe(false);
  });

  it('test_allowlist_allows_listed_provider', () => {
    const m = makeMembership('allowlist', ['openai', 'anthropic']);
    expect(checkEgressPolicy(m, 'openai')).toBe(true);
    expect(checkEgressPolicy(m, 'anthropic')).toBe(true);
  });

  it('test_allowlist_blocks_unlisted_provider', () => {
    const m = makeMembership('allowlist', ['openai']);
    expect(checkEgressPolicy(m, 'other-provider')).toBe(false);
    expect(checkEgressPolicy(m, null)).toBe(false);
  });

  it('test_unrestricted_allows_anything', () => {
    const m = makeMembership('unrestricted', []);
    expect(checkEgressPolicy(m, null)).toBe(true);
    expect(checkEgressPolicy(m, 'any-provider')).toBe(true);
  });
});
