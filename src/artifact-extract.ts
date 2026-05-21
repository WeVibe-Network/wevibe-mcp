/**
 * Deterministic artifact extraction from memory content.
 *
 * Extracts URLs, domains, IP addresses, shell commands, package install
 * directives, and config directives with network targets. Best-effort —
 * does not catch payloads encoded in natural language prose.
 */

export type ArtifactType =
  | 'url'
  | 'domain'
  | 'ip_address'
  | 'shell_command'
  | 'package_install'
  | 'config_directive'
  | 'credential_like';

export interface ExtractedArtifact {
  type: ArtifactType;
  value: string;
  startIndex: number;
  endIndex: number;
  context: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ArtifactExtractionResult {
  artifacts: ExtractedArtifact[];
  summary: Record<ArtifactType, number>;
}

const URL_REGEX = /https?:\/\/[^\s"'`<>\]\)]+/gi;

function extractUrls(text: string): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  for (const match of text.matchAll(URL_REGEX)) {
    const value = match[0].replace(/[.,;:!?)]+$/, '');
    const idx = match.index!;
    artifacts.push({
      type: 'url',
      value,
      startIndex: idx,
      endIndex: idx + value.length,
      context: text.slice(Math.max(0, idx - 30), idx + value.length + 30),
      riskLevel: isLocalUrl(value) ? 'low' : 'high',
    });
  }
  return artifacts;
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

const DOMAIN_REGEX = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|dev|app|co|me|xyz|info|biz|cloud|ai|sh|run)\b/gi;

function extractDomains(text: string, existingUrls: ExtractedArtifact[]): ExtractedArtifact[] {
  const urlRanges = existingUrls.map(u => [u.startIndex, u.endIndex] as const);
  const artifacts: ExtractedArtifact[] = [];
  for (const match of text.matchAll(DOMAIN_REGEX)) {
    const idx = match.index!;
    const inUrl = urlRanges.some(([s, e]) => idx >= s && idx < e);
    if (inUrl) continue;
    const value = match[0];
    artifacts.push({
      type: 'domain',
      value,
      startIndex: idx,
      endIndex: idx + value.length,
      context: text.slice(Math.max(0, idx - 30), idx + value.length + 30),
      riskLevel: 'high',
    });
  }
  return artifacts;
}

const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)\b/g;

function extractIpAddresses(text: string): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  for (const match of text.matchAll(IPV4_REGEX)) {
    const value = match[0];
    const idx = match.index!;
    const isPrivate = value.startsWith('127.') || value.startsWith('10.') ||
      value.startsWith('192.168.') || (value.startsWith('172.') && parseInt(value.split('.')[1]) >= 16 && parseInt(value.split('.')[1]) <= 31);
    artifacts.push({
      type: 'ip_address',
      value,
      startIndex: idx,
      endIndex: idx + value.length,
      context: text.slice(Math.max(0, idx - 30), idx + value.length + 30),
      riskLevel: isPrivate ? 'low' : 'high',
    });
  }
  return artifacts;
}

const SHELL_PATTERNS = [
  /(?:^|\n)\s*(?:curl|wget|fetch)\s+[^\n]+/gi,
  /(?:^|\n)\s*(?:curl|wget)[^\n]*\|\s*(?:sh|bash|zsh)[^\n]*/gi,
  /(?:^|\n)\s*(?:npm|yarn|pnpm|pip|cargo|go)\s+(?:install|add|get)\s+[^\n]+/gi,
  /(?:^|\n)\s*(?:sudo\s+)?(?:apt|yum|dnf|brew)\s+install\s+[^\n]+/gi,
];

function extractShellCommands(text: string): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  const seen = new Set<string>();
  for (const pattern of SHELL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].trim();
      if (seen.has(value)) continue;
      seen.add(value);
      const idx = match.index!;
      const hasNetworkTarget = URL_REGEX.test(value) || DOMAIN_REGEX.test(value);
      artifacts.push({
        type: hasNetworkTarget ? 'shell_command' : 'package_install',
        value,
        startIndex: idx,
        endIndex: idx + match[0].length,
        context: text.slice(Math.max(0, idx - 30), idx + match[0].length + 30),
        riskLevel: hasNetworkTarget ? 'high' : 'medium',
      });
    }
  }
  return artifacts;
}

const CONFIG_NETWORK_PATTERNS = [
  /(?:proxy_pass|upstream|server_name|resolver|proxy_redirect)\s+https?:\/\/[^\s;]+/gi,
  /(?:proxy_pass|upstream|server_name|resolver|proxy_redirect)\s+[a-z0-9.-]+:\d+/gi,
];

function extractConfigDirectives(text: string): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  for (const pattern of CONFIG_NETWORK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].trim();
      const idx = match.index!;
      artifacts.push({
        type: 'config_directive',
        value,
        startIndex: idx,
        endIndex: idx + match[0].length,
        context: text.slice(Math.max(0, idx - 30), idx + match[0].length + 30),
        riskLevel: 'high',
      });
    }
  }
  return artifacts;
}

export function extractArtifacts(text: string): ArtifactExtractionResult {
  const urls = extractUrls(text);
  const domains = extractDomains(text, urls);
  const ips = extractIpAddresses(text);
  const commands = extractShellCommands(text);
  const configs = extractConfigDirectives(text);

  const allArtifacts = [...urls, ...domains, ...ips, ...commands, ...configs];

  allArtifacts.sort((a, b) => a.startIndex - b.startIndex);

  const summary: Record<ArtifactType, number> = {
    url: 0, domain: 0, ip_address: 0, shell_command: 0,
    package_install: 0, config_directive: 0, credential_like: 0,
  };
  for (const a of allArtifacts) {
    summary[a.type]++;
  }

  return { artifacts: allArtifacts, summary };
}