import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export type RiskAppetite = 'lowest' | 'neutral';
export type ProviderPolicy = 'unrestricted' | 'local_only' | 'allowlist';

const CONFIG_PATH = join(homedir(), '.wevibe', 'plugin-config.json');

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getRiskAppetite(): RiskAppetite {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return 'neutral';
    }
    const data = readFileSync(CONFIG_PATH, 'utf-8');
    if (!data) return 'neutral';
    const parsed = JSON.parse(data);
    if (parsed.risk_appetite === 'lowest' || parsed.risk_appetite === 'neutral') {
      return parsed.risk_appetite;
    }
    return 'neutral';
  } catch {
    return 'neutral';
  }
}

export function setRiskAppetite(value: RiskAppetite): void {
  if (value !== 'lowest' && value !== 'neutral') {
    throw new Error(`invalid risk_appetite: ${value}; must be "lowest" or "neutral"`);
  }
  ensureDir(CONFIG_PATH);
  let existing: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const data = readFileSync(CONFIG_PATH, 'utf-8');
      if (data) existing = JSON.parse(data);
    } catch { /* ignore */ }
  }
  const updated = { ...existing, risk_appetite: value };
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + '\n');
}

export function getProviderPolicy(): ProviderPolicy {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return 'unrestricted';
    }
    const data = readFileSync(CONFIG_PATH, 'utf-8');
    if (!data) return 'unrestricted';
    const parsed = JSON.parse(data);
    if (parsed.provider_policy === 'unrestricted' || parsed.provider_policy === 'local_only' || parsed.provider_policy === 'allowlist') {
      return parsed.provider_policy;
    }
    return 'unrestricted';
  } catch {
    return 'unrestricted';
  }
}

export function setProviderPolicy(value: ProviderPolicy): void {
  if (value !== 'unrestricted' && value !== 'local_only' && value !== 'allowlist') {
    throw new Error(`invalid provider_policy: ${value}; must be "unrestricted", "local_only", or "allowlist"`);
  }
  ensureDir(CONFIG_PATH);
  let existing: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const data = readFileSync(CONFIG_PATH, 'utf-8');
      if (data) existing = JSON.parse(data);
    } catch { /* ignore */ }
  }
  const updated = { ...existing, provider_policy: value };
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + '\n');
}
