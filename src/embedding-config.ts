import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  EMBEDDING_BASE_URL,
  EMBEDDING_API_KEY,
  EMBEDDING_MODEL,
} from './config.js';

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

function fallbackEmbeddingConfig(): ResolvedEmbeddingConfig {
  return {
    baseUrl: EMBEDDING_BASE_URL,
    apiKey: EMBEDDING_API_KEY,
    model: EMBEDDING_MODEL,
    usePrefix: EMBEDDING_MODEL.toLowerCase().includes('nomic'),
  };
}

function asStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function loadEmbeddingConfig(): ResolvedEmbeddingConfig {
  const fallback = fallbackEmbeddingConfig();

  try {
    const settingsPath = join(homedir(), '.config', 'wevibe', 'dashboard.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as DashboardEmbeddingSettings;

    const provider = asStringOrEmpty(parsed.embedding_provider);

    let baseUrl = '';
    let apiKey = '';
    let model = '';

    if (provider === 'openrouter') {
      baseUrl = 'https://openrouter.ai/api/v1';
      apiKey = typeof parsed.openrouter_api_key === 'string' ? parsed.openrouter_api_key : '';
      model = asStringOrEmpty(parsed.embedding_openrouter_model);
    } else if (provider === 'lm_studio') {
      baseUrl = asStringOrEmpty(parsed.lmstudio_url) || 'http://127.0.0.1:1234/v1';
      apiKey = 'lm-studio';
      model = asStringOrEmpty(parsed.embedding_lmstudio_model);
    } else if (provider === 'ollama') {
      const ollamaBaseUrl = asStringOrEmpty(parsed.ollama_url) || 'http://localhost:11434';
      baseUrl = `${ollamaBaseUrl.replace(/\/$/, '')}/v1`;
      apiKey = 'ollama';
      model = asStringOrEmpty(parsed.embedding_ollama_model);
    } else {
      return fallback;
    }

    if (model.length === 0) {
      return fallback;
    }

    return {
      baseUrl,
      apiKey,
      model,
      usePrefix: model.toLowerCase().includes('nomic'),
    };
  } catch {
    return fallback;
  }
}
