import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  usePrefix: boolean;
}

interface DashboardEmbeddingSettings {
  embedding_provider?: unknown;
  embedding_ollama_model?: unknown;
  embedding_lmstudio_model?: unknown;
  embedding_openrouter_model?: unknown;
  openrouter_api_key?: unknown;
  ollama_url?: unknown;
  lmstudio_url?: unknown;
}

function asStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveFromEnv(provider: string): ResolvedEmbeddingConfig {
  const rawModel = process.env.WEVIBE_EMBEDDING_MODEL;
  const model = rawModel === undefined || rawModel === ''
    ? 'openai/text-embedding-3-large'
    : rawModel.trim();

  if (model.length === 0) {
    throw new Error(
      `embedding model is empty for provider "${provider}" from environment; set WEVIBE_EMBEDDING_MODEL`,
    );
  }

  if (provider === 'openrouter') {
    const apiKey = asStringOrEmpty(process.env.OPENROUTER_API_KEY);
    if (apiKey.length === 0 || apiKey.startsWith('\u2022')) {
      throw new Error('OPENROUTER_API_KEY missing or masked in environment; set a real key');
    }
    return {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey,
      model,
      usePrefix: model.toLowerCase().includes('nomic'),
    };
  }

  if (provider === 'lm_studio') {
    const baseUrl = asStringOrEmpty(process.env.WEVIBE_LMSTUDIO_URL) || 'http://127.0.0.1:1234/v1';
    return {
      baseUrl,
      apiKey: 'lm-studio',
      model,
      usePrefix: model.toLowerCase().includes('nomic'),
    };
  }

  if (provider === 'ollama') {
    const ollamaBaseUrl = asStringOrEmpty(process.env.WEVIBE_OLLAMA_URL) || 'http://localhost:11434';
    return {
      baseUrl: `${ollamaBaseUrl.replace(/\/$/, '')}/v1`,
      apiKey: 'ollama',
      model,
      usePrefix: model.toLowerCase().includes('nomic'),
    };
  }

  throw new Error(
    `WEVIBE_EMBEDDING_PROVIDER "${provider}" is invalid; expected openrouter, lm_studio, or ollama`,
  );
}

function resolveFromDashboard(): ResolvedEmbeddingConfig {
  const settingsPath = join(homedir(), '.config', 'wevibe', 'dashboard.json');

  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read dashboard.json at ${settingsPath}: ${(error as Error).message}`,
    );
  }

  let parsed: DashboardEmbeddingSettings;
  try {
    parsed = JSON.parse(raw) as DashboardEmbeddingSettings;
  } catch (error) {
    throw new Error(
      `Malformed JSON in dashboard.json at ${settingsPath}: ${(error as Error).message}`,
    );
  }

  const provider = asStringOrEmpty(parsed.embedding_provider);

  if (provider.length === 0) {
    throw new Error(
      'embedding_provider is missing in dashboard.json; set embedding_provider to openrouter, lm_studio, or ollama',
    );
  }

  if (provider !== 'openrouter' && provider !== 'lm_studio' && provider !== 'ollama') {
    throw new Error(
      `embedding_provider "${provider}" is invalid in dashboard.json; expected openrouter, lm_studio, or ollama`,
    );
  }

  let baseUrl = '';
  let apiKey = '';
  let model = '';

  if (provider === 'openrouter') {
    const openRouterApiKey = parsed.openrouter_api_key;
    const trimmedOpenRouterApiKey = typeof openRouterApiKey === 'string'
      ? openRouterApiKey.trim()
      : '';
    if (
      typeof openRouterApiKey !== 'string'
      || trimmedOpenRouterApiKey.length === 0
      || trimmedOpenRouterApiKey.startsWith('\u2022')
    ) {
      throw new Error('OpenRouter API key missing or masked in dashboard.json; paste a real key');
    }
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

export function loadEmbeddingConfig(): ResolvedEmbeddingConfig {
  const providerFromEnv = asStringOrEmpty(process.env.WEVIBE_EMBEDDING_PROVIDER);
  if (providerFromEnv.length > 0) {
    return resolveFromEnv(providerFromEnv);
  }

  return resolveFromDashboard();
}
