import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type DashboardProvider = 'openrouter' | 'lm_studio' | 'ollama';

export interface ResolvedEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  usePrefix: boolean;
}

export interface ResolvedLlmConfig {
  provider: DashboardProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface DashboardEmbeddingSettings {
  embedding_provider?: unknown;
  embedding_ollama_model?: unknown;
  embedding_lmstudio_model?: unknown;
  embedding_openrouter_model?: unknown;
  embedding_api_key?: unknown;
  ollama_url?: unknown;
  lmstudio_url?: unknown;
}

interface DashboardLlmSettings {
  llm_provider?: unknown;
  openrouter_model?: unknown;
  ollama_model?: unknown;
  lmstudio_model?: unknown;
  extraction_api_key?: unknown;
  ollama_url?: unknown;
  lmstudio_url?: unknown;
}

type DashboardSettings = DashboardEmbeddingSettings & DashboardLlmSettings;

function getSettingsPath(): string {
  return join(homedir(), '.config', 'wevibe', 'dashboard.json');
}

function asStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function loadDashboardSettings(): DashboardSettings {
  const settingsPath = getSettingsPath();

  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read dashboard.json at ${settingsPath}: ${(error as Error).message}`,
    );
  }

  try {
    return JSON.parse(raw) as DashboardSettings;
  } catch (error) {
    throw new Error(
      `Malformed JSON in dashboard.json at ${settingsPath}: ${(error as Error).message}`,
    );
  }
}

function normalizeProvider(
  provider: string,
  configKey: 'embedding_provider' | 'llm_provider',
): DashboardProvider {
  if (provider.length === 0) {
    throw new Error(
      `${configKey} is missing in dashboard.json; set ${configKey} to openrouter, lm_studio, or ollama`,
    );
  }

  if (provider !== 'openrouter' && provider !== 'lm_studio' && provider !== 'ollama') {
    throw new Error(
      `${configKey} "${provider}" is invalid in dashboard.json; expected openrouter, lm_studio, or ollama`,
    );
  }

  return provider;
}

function resolveOpenRouterApiKey(value: unknown, keyName: 'embedding_api_key' | 'extraction_api_key'): string {
  const rawValue = typeof value === 'string' ? value : '';
  const trimmedValue = rawValue.trim();
  if (trimmedValue.length === 0 || trimmedValue.startsWith('\u2022')) {
    if (keyName === 'embedding_api_key') {
      throw new Error('OpenRouter API key missing or masked in dashboard.json; paste a real key');
    }
    throw new Error('OpenRouter API key missing or masked in dashboard.json; paste a real extraction_api_key');
  }
  return rawValue;
}

export function loadEmbeddingConfig(): ResolvedEmbeddingConfig {
  const parsed = loadDashboardSettings();

  const provider = normalizeProvider(asStringOrEmpty(parsed.embedding_provider), 'embedding_provider');

  let baseUrl = '';
  let apiKey = '';
  let model = '';

  if (provider === 'openrouter') {
    const openRouterApiKey = resolveOpenRouterApiKey(parsed.embedding_api_key, 'embedding_api_key');
    baseUrl = 'https://openrouter.ai/api/v1';
    apiKey = openRouterApiKey;
    model = asStringOrEmpty(parsed.embedding_openrouter_model);
  } else if (provider === 'lm_studio') {
    baseUrl = asStringOrEmpty(parsed.lmstudio_url) || 'http://127.0.0.1:1234/v1';
    apiKey = 'lm-studio';
    model = asStringOrEmpty(parsed.embedding_lmstudio_model);
  } else {
    const ollamaBaseUrl = asStringOrEmpty(parsed.ollama_url) || 'http://localhost:11434';
    baseUrl = `${ollamaBaseUrl.replace(/\/$/, '')}/v1`;
    apiKey = 'ollama';
    model = asStringOrEmpty(parsed.embedding_ollama_model);
  }

  if (model.length === 0) {
    throw new Error(
      `embedding model for provider "${provider}" is empty in dashboard.json; set the provider model value`,
    );
  }

  return {
    baseUrl,
    apiKey,
    model,
    usePrefix: model.toLowerCase().includes('nomic'),
  };
}

export function loadLlmConfig(): ResolvedLlmConfig {
  const parsed = loadDashboardSettings();

  const provider = normalizeProvider(asStringOrEmpty(parsed.llm_provider), 'llm_provider');

  let baseUrl = '';
  let apiKey = '';
  let model = '';

  if (provider === 'openrouter') {
    baseUrl = 'https://openrouter.ai/api/v1';
    apiKey = resolveOpenRouterApiKey(parsed.extraction_api_key, 'extraction_api_key');
    model = asStringOrEmpty(parsed.openrouter_model);
  } else if (provider === 'lm_studio') {
    baseUrl = asStringOrEmpty(parsed.lmstudio_url) || 'http://127.0.0.1:1234/v1';
    apiKey = 'lm-studio';
    model = asStringOrEmpty(parsed.lmstudio_model);
  } else {
    baseUrl = asStringOrEmpty(parsed.ollama_url) || 'http://localhost:11434';
    apiKey = 'ollama';
    model = asStringOrEmpty(parsed.ollama_model);
  }

  if (model.length === 0) {
    throw new Error(
      `LLM model for provider "${provider}" is empty in dashboard.json; set the provider model value`,
    );
  }

  return {
    provider,
    baseUrl,
    apiKey,
    model,
  };
}
