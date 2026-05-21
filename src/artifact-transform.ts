/**
 * Selective transformation of artifacts within memory text.
 *
 * Applies policy decisions: redacts egress-violating literals,
 * annotates medium-risk artifacts, preserves low-risk details.
 * Processes replacements in reverse index order to avoid shifting.
 */

import type { ArtifactPolicyResult } from './artifact-policy.js';

export interface TransformResult {
  text: string;
  annotations: string[];
  redactedCount: number;
  annotatedCount: number;
}

export function transformMemoryContent(
  originalText: string,
  policyResults: ArtifactPolicyResult[],
): TransformResult {
  const annotations: string[] = [];
  let redactedCount = 0;
  let annotatedCount = 0;

  const sorted = [...policyResults]
    .filter(pr => pr.decision !== 'allow')
    .sort((a, b) => b.artifact.startIndex - a.artifact.startIndex);

  let text = originalText;

  for (const pr of sorted) {
    const { artifact, decision, reason } = pr;

    if (decision === 'redact') {
      const replacement = buildRedaction(artifact);
      text = text.slice(0, artifact.startIndex) + replacement + text.slice(artifact.endIndex);
      annotations.push(`⚠ REDACTED [${artifact.type}]: artifact removed — violated org egress policy`);
      redactedCount++;
    } else if (decision === 'annotate') {
      annotations.push(`⚠ [${artifact.type}]: ${reason} — "${artifact.value.slice(0, 60)}${artifact.value.length > 60 ? '...' : ''}"`);
      annotatedCount++;
    }
  }

  return { text, annotations, redactedCount, annotatedCount };
}

function buildRedaction(artifact: ArtifactPolicyResult['artifact']): string {
  switch (artifact.type) {
    case 'url': {
      try {
        const url = new URL(artifact.value);
        return `<redacted-external-host>${url.pathname}${url.search}`;
      } catch {
        return '<redacted-url>';
      }
    }
    case 'domain':
      return '<redacted-domain>';
    case 'ip_address':
      return '<redacted-ip>';
    case 'config_directive': {
      const parts = artifact.value.split(/\s+/);
      if (parts.length >= 2) {
        return `${parts[0]} <redacted-external-host>`;
      }
      return '<redacted-config>';
    }
    case 'shell_command': {
      return artifact.value.replace(/https?:\/\/[^\s"']+/gi, '<redacted-url>');
    }
    default:
      return '<redacted>';
  }
}