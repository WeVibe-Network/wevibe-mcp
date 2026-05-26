import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export type RiskAppetite = 'lowest' | 'neutral';
export type ProviderPolicy = 'unrestricted' | 'local_only' | 'allowlist';

const CONFIG_PATH = join(homedir(), '.wevibe', 'plugin-config.json');
const RISK_APPETITES: readonly RiskAppetite[] = ['lowest', 'neutral'];
const PROVIDER_POLICIES: readonly ProviderPolicy[] = ['unrestricted', 'local_only', 'allowlist'];

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    const data = readFileSync(CONFIG_PATH, 'utf-8');
    if (!data) return {};

    const parsed = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

function writeConfig(updated: Record<string, unknown>): void {
  ensureDir(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2) + '\n');
}

function getStringValue<K extends string>(
  key: string,
  allowedValues: readonly K[],
  fallback: K,
): K {
  const value = readConfig()[key];
  if (typeof value === 'string' && allowedValues.includes(value as K)) {
    return value as K;
  }
  return fallback;
}

function assertAllowedValue<K extends string>(
  errorMessage: string,
  value: K,
  allowedValues: readonly K[],
): void {
  if (!allowedValues.includes(value)) {
    throw new Error(errorMessage);
  }
}

function setConfigValue<K extends string>(key: string, value: K): void {
  const updated = { ...readConfig(), [key]: value };
  writeConfig(updated);
}

export function getRiskAppetite(): RiskAppetite {
  return getStringValue('risk_appetite', RISK_APPETITES, 'neutral');
}

export function setRiskAppetite(value: RiskAppetite): void {
  assertAllowedValue(
    `invalid risk_appetite: ${value}; must be "lowest" or "neutral"`,
    value,
    RISK_APPETITES,
  );
  setConfigValue('risk_appetite', value);
}

export function getProviderPolicy(): ProviderPolicy {
  return getStringValue('provider_policy', PROVIDER_POLICIES, 'unrestricted');
}

export function setProviderPolicy(value: ProviderPolicy): void {
  assertAllowedValue(
    `invalid provider_policy: ${value}; must be "unrestricted", "local_only", or "allowlist"`,
    value,
    PROVIDER_POLICIES,
  );
  setConfigValue('provider_policy', value);
}
