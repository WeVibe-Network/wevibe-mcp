/**
 * Artifact-level egress policy enforcement.
 *
 * Given extracted artifacts and an org's egress policy, determines which
 * artifacts violate policy and what transformation to apply.
 */

import type { ExtractedArtifact } from './artifact-extract.js';

export type PolicyDecision = 'allow' | 'redact' | 'annotate';

export interface ArtifactPolicyResult {
  artifact: ExtractedArtifact;
  decision: PolicyDecision;
  reason: string;
}

function extractHostFromArtifact(artifact: ExtractedArtifact): string | null {
  if (artifact.type === 'url') {
    try {
      return new URL(artifact.value).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  if (artifact.type === 'domain') {
    return artifact.value.toLowerCase();
  }
  if (artifact.type === 'ip_address') {
    return artifact.value;
  }
  if (artifact.type === 'config_directive' || artifact.type === 'shell_command') {
    const urlMatch = artifact.value.match(/https?:\/\/([^\s/:]+)/i);
    if (urlMatch) return urlMatch[1].toLowerCase();
    const domainMatch = artifact.value.match(/\b([a-z0-9.-]+\.[a-z]{2,})\b/i);
    if (domainMatch) return domainMatch[1].toLowerCase();
    return null;
  }
  return null;
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    host.endsWith('.local') || host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    (host.startsWith('172.') && (() => {
      const second = parseInt(host.split('.')[1]);
      return second >= 16 && second <= 31;
    })());
}

function isDomainAllowed(host: string, allowedDomains: string[]): boolean {
  for (const allowed of allowedDomains) {
    const normalizedAllowed = allowed.toLowerCase();
    if (host === normalizedAllowed) return true;
    if (host.endsWith('.' + normalizedAllowed)) return true;
  }
  return false;
}

export function checkArtifactPolicy(
  artifacts: ExtractedArtifact[],
  egressMode: 'local_only' | 'allowlist' | 'unrestricted',
  allowedDomains: string[],
): ArtifactPolicyResult[] {
  const results: ArtifactPolicyResult[] = [];

  for (const artifact of artifacts) {
    if (artifact.riskLevel === 'low') {
      results.push({ artifact, decision: 'allow', reason: 'low-risk artifact' });
      continue;
    }

    if (artifact.riskLevel === 'medium') {
      results.push({ artifact, decision: 'annotate', reason: 'medium-risk: package/dependency recommendation' });
      continue;
    }

    if (egressMode === 'unrestricted') {
      results.push({ artifact, decision: 'annotate', reason: 'high-risk artifact (egress: unrestricted)' });
      continue;
    }

    const host = extractHostFromArtifact(artifact);
    if (!host) {
      results.push({ artifact, decision: 'annotate', reason: 'high-risk artifact (host unresolvable)' });
      continue;
    }

    if (isLocalHost(host)) {
      results.push({ artifact, decision: 'allow', reason: 'local/private host' });
      continue;
    }

    if (egressMode === 'local_only') {
      results.push({ artifact, decision: 'redact', reason: `egress violation: external host "${host}" not permitted (local_only mode)` });
      continue;
    }

    if (egressMode === 'allowlist') {
      if (isDomainAllowed(host, allowedDomains)) {
        results.push({ artifact, decision: 'allow', reason: `host "${host}" in org allowlist` });
      } else {
        results.push({ artifact, decision: 'redact', reason: `egress violation: "${host}" not in org allowlist [${allowedDomains.join(', ')}]` });
      }
      continue;
    }

    results.push({ artifact, decision: 'annotate', reason: 'unclassified' });
  }

  return results;
}