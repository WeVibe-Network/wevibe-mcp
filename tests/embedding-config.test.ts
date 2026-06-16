import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileSyncMock, homedirMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  homedirMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
}));

vi.mock('node:os', () => ({
  homedir: homedirMock,
}));

import { loadEmbeddingConfig } from '../src/embedding-config.js';

const TEST_HOME = '/mock-home';
const DASHBOARD_PATH = '/mock-home/.config/wevibe/dashboard.json';

function mockDashboardJson(settings: Record<string, unknown>): void {
  readFileSyncMock.mockReturnValue(JSON.stringify(settings));
}

describe('loadEmbeddingConfig', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(TEST_HOME);
  });

  it('resolves OpenRouter dashboard settings', () => {
    mockDashboardJson({
      embedding_provider: 'openrouter',
      embedding_openrouter_model: 'openai/text-embedding-3-large',
      embedding_api_key: 'sk-or-test',
    });

    expect(loadEmbeddingConfig()).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      model: 'openai/text-embedding-3-large',
      usePrefix: false,
    });

    expect(readFileSyncMock).toHaveBeenCalledWith(DASHBOARD_PATH, 'utf8');
  });

  it('prefers embedding_api_key over legacy openrouter_api_key for OpenRouter', () => {
    mockDashboardJson({
      embedding_provider: 'openrouter',
      embedding_openrouter_model: 'openai/text-embedding-3-large',
      embedding_api_key: 'sk-or-embed',
      openrouter_api_key: 'sk-or-LEGACY',
    });

    expect(loadEmbeddingConfig()).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-embed',
      model: 'openai/text-embedding-3-large',
      usePrefix: false,
    });
  });

  it('resolves LM Studio dashboard settings', () => {
    mockDashboardJson({
      embedding_provider: 'lm_studio',
      embedding_lmstudio_model: 'text-embedding-3-large',
      lmstudio_url: 'http://localhost:9999/v1',
    });

    expect(loadEmbeddingConfig()).toEqual({
      baseUrl: 'http://localhost:9999/v1',
      apiKey: 'lm-studio',
      model: 'text-embedding-3-large',
      usePrefix: false,
    });
  });

  it('uses LM Studio default URL when lmstudio_url is missing', () => {
    mockDashboardJson({
      embedding_provider: 'lm_studio',
      embedding_lmstudio_model: 'text-embedding-3-large',
    });

    expect(loadEmbeddingConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: 'text-embedding-3-large',
      usePrefix: false,
    });
  });

  it('resolves Ollama dashboard settings and strips trailing slash', () => {
    mockDashboardJson({
      embedding_provider: 'ollama',
      embedding_ollama_model: 'nomic-embed-text-v1.5',
      ollama_url: 'http://localhost:11434/',
    });

    expect(loadEmbeddingConfig()).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text-v1.5',
      usePrefix: true,
    });
  });

  it('uses Ollama default URL when ollama_url is missing', () => {
    mockDashboardJson({
      embedding_provider: 'ollama',
      embedding_ollama_model: 'text-embedding-3-large',
    });

    expect(loadEmbeddingConfig()).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'text-embedding-3-large',
      usePrefix: false,
    });
  });

  it('throws when dashboard settings file is missing', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    expect(() => loadEmbeddingConfig()).toThrow(/Failed to read dashboard\.json/);
  });

  it('throws when dashboard settings contain malformed JSON', () => {
    readFileSyncMock.mockReturnValue('{"embedding_provider":');

    expect(() => loadEmbeddingConfig()).toThrow(/Malformed JSON in dashboard\.json/);
  });

  it('throws when provider is missing', () => {
    mockDashboardJson({});

    expect(() => loadEmbeddingConfig()).toThrow(
      /embedding_provider is missing in dashboard\.json/,
    );
  });

  it('throws when provider is empty or whitespace', () => {
    mockDashboardJson({
      embedding_provider: '   ',
    });

    expect(() => loadEmbeddingConfig()).toThrow(
      /embedding_provider is missing in dashboard\.json/,
    );
  });

  it('throws when provider is unknown', () => {
    mockDashboardJson({
      embedding_provider: 'anthropic',
    });

    expect(() => loadEmbeddingConfig()).toThrow(
      /embedding_provider "anthropic" is invalid in dashboard\.json/,
    );
  });

  it('throws when selected provider model is empty', () => {
    mockDashboardJson({
      embedding_provider: 'openrouter',
      embedding_openrouter_model: ' ',
      embedding_api_key: 'sk-or-test',
    });

    expect(() => loadEmbeddingConfig()).toThrow(
      /embedding model for provider "openrouter" is empty in dashboard\.json/,
    );
  });

  it('throws when OpenRouter API key is masked', () => {
    mockDashboardJson({
      embedding_provider: 'openrouter',
      embedding_openrouter_model: 'openai/text-embedding-3-large',
      embedding_api_key: '\u2022\u2022\u2022\u2022',
    });

    expect(() => loadEmbeddingConfig()).toThrow(
      /OpenRouter API key missing or masked in dashboard\.json; paste a real key/,
    );
  });

  it('throws when OpenRouter API key is non-string', () => {
    mockDashboardJson({
      embedding_provider: 'openrouter',
      embedding_openrouter_model: 'openai/text-embedding-3-large',
      embedding_api_key: 12345,
    });

    expect(() => loadEmbeddingConfig()).toThrow(
      /OpenRouter API key missing or masked in dashboard\.json; paste a real key/,
    );
  });

  it('throws when OpenRouter API key is empty', () => {
    mockDashboardJson({
      embedding_provider: 'openrouter',
      embedding_openrouter_model: 'openai/text-embedding-3-large',
      embedding_api_key: '   ',
    });

    expect(() => loadEmbeddingConfig()).toThrow(
      /OpenRouter API key missing or masked in dashboard\.json; paste a real key/,
    );
  });

  it('still resolves valid OpenRouter config', () => {
    mockDashboardJson({
      embedding_provider: 'openrouter',
      embedding_openrouter_model: 'openai/text-embedding-3-large',
      embedding_api_key: 'sk-or-live-test',
    });

    expect(loadEmbeddingConfig()).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-live-test',
      model: 'openai/text-embedding-3-large',
      usePrefix: false,
    });
  });
});
