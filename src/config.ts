try {
  (process as NodeJS.Process & { loadEnvFile: () => void }).loadEnvFile();
} catch {
  // no .env present; rely on process.env
}

export const HUB_URL = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';
export const DASHBOARD_URL = process.env.WEVIBE_DASHBOARD_URL ?? 'https://app.wevibe.network';
export const OLLAMA_URL = process.env.WEVIBE_OLLAMA_URL ?? 'http://localhost:11434';
export const OLLAMA_EMBEDDING_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
export const HTTP_HOST = process.env.WEVIBE_HTTP_HOST ?? '127.0.0.1';
export const DASHBOARD_PORT = process.env.WEVIBE_DASHBOARD_PORT ? Number(process.env.WEVIBE_DASHBOARD_PORT) : 4451;
export const EXTRACTION_MODEL = process.env.WEVIBE_EXTRACTION_MODEL ?? 'qwen3:4b';
export const EMBEDDING_MODEL = process.env.WEVIBE_EMBEDDING_MODEL ?? 'nomic-embed-text';
