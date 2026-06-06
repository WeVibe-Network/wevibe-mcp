import { CHAIN_REST_URL, HUB_URL } from './config.js';
import { getOrgHubState, readIdentitySidecar, setOrgHubState } from './identity-sidecar.js';
import { loadMemberships } from './org-client.js';

const HEALTH_TIMEOUT_MS = 1500;

export interface ChainResolvedOrg {
  hubEndpoints: string[];
  hubServingAddress: string;
  hubResponsePubkey: string;
}

export interface ResolveAllOrgsChange {
  orgId: string;
  from: string[];
  to: string[];
}

export interface ResolveAllOrgsOptions {
  // Plugin startup must stay biometric-free, so it passes false here.
  includeMembershipBootstrap?: boolean;
}

export interface ResolveAllOrgsResult {
  changed: ResolveAllOrgsChange[];
}

export interface PickActiveEndpointOptions {
  skipEndpoint?: (endpoint: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

function endpointArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

async function checkEndpointHealth(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function endpointPassesFailoverChecks(endpoint: string, opts: PickActiveEndpointOptions): Promise<boolean> {
  if (opts.skipEndpoint?.(endpoint)) {
    return false;
  }

  if (!await checkEndpointHealth(endpoint)) {
    return false;
  }

  // Caller-provided skipEndpoint supports additional failover triggers
  // (for example response-signature verification failures).
  return true;
}

export async function queryOrgFromChain(orgId: string): Promise<ChainResolvedOrg | null> {
  let response: Response;
  try {
    response = await fetch(`${CHAIN_REST_URL}/wevibe/org/v1/org/${encodeURIComponent(orgId)}`);
  } catch {
    return null;
  }

  if (response.status !== 200) {
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  const hubServingAddress = payload.hub_serving_address;
  const hubEndpoints = payload.hub_endpoints;
  const hubResponsePubkey = payload.hub_response_pubkey;

  if (typeof hubServingAddress !== 'string') {
    return null;
  }
  if (!Array.isArray(hubEndpoints) || !hubEndpoints.every((entry) => typeof entry === 'string')) {
    return null;
  }
  if (typeof hubResponsePubkey !== 'string') {
    return null;
  }

  return {
    hubEndpoints: hubEndpoints.map((endpoint) => normalizeEndpoint(endpoint)).filter((endpoint) => endpoint.length > 0),
    hubServingAddress,
    hubResponsePubkey,
  };
}

export async function pickActiveEndpoint(endpoints: string[], opts: PickActiveEndpointOptions = {}): Promise<string | null> {
  const candidates = endpoints
    .map((endpoint) => normalizeEndpoint(endpoint))
    .filter((endpoint) => endpoint.length > 0);

  for (const endpoint of candidates) {
    if (await endpointPassesFailoverChecks(endpoint, opts)) {
      return endpoint;
    }
  }

  const fallback = candidates.find((endpoint) => !(opts.skipEndpoint?.(endpoint))) ?? null;
  return fallback;
}

export async function resolveAllOrgsOnce(opts: ResolveAllOrgsOptions = {}): Promise<ResolveAllOrgsResult> {
  const changed: ResolveAllOrgsChange[] = [];
  const orgIds = new Set<string>(Object.keys(readIdentitySidecar()?.orgs ?? {}));

  if (opts.includeMembershipBootstrap ?? true) {
    try {
      const memberships = await loadMemberships(HUB_URL);
      for (const membership of memberships) {
        if (membership.orgId) {
          orgIds.add(membership.orgId);
        }
      }
    } catch {
      // Membership bootstrap is best-effort only.
    }
  }

  for (const orgId of orgIds) {
    try {
      const chainResolved = await queryOrgFromChain(orgId);
      if (!chainResolved) {
        continue;
      }

      const currentState = getOrgHubState(orgId);
      const previousEndpoints = [...(currentState?.hubEndpoints ?? [])];
      const nextEndpoints = [...chainResolved.hubEndpoints];
      const activeHubEndpoint = await pickActiveEndpoint(nextEndpoints);
      const endpointListChanged = !endpointArraysEqual(previousEndpoints, nextEndpoints);

      const metadataChanged =
        currentState?.activeHubEndpoint !== activeHubEndpoint ||
        currentState?.hubServingAddress !== chainResolved.hubServingAddress ||
        currentState?.hubResponsePubkey !== chainResolved.hubResponsePubkey;

      if (!currentState || endpointListChanged || metadataChanged) {
        setOrgHubState(orgId, {
          hubEndpoints: nextEndpoints,
          activeHubEndpoint,
          hubServingAddress: chainResolved.hubServingAddress,
          hubResponsePubkey: chainResolved.hubResponsePubkey,
          updatedAt: new Date().toISOString(),
        });
      }

      if (endpointListChanged) {
        changed.push({
          orgId,
          from: previousEndpoints,
          to: nextEndpoints,
        });
      }
    } catch {
      // Per-org failures are best-effort; continue resolving others.
    }
  }

  return { changed };
}

export function getActiveHubUrlForOrg(orgId: string): string | null {
  return getOrgHubState(orgId)?.activeHubEndpoint ?? null;
}
