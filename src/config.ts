try {
  (process as NodeJS.Process & { loadEnvFile: () => void }).loadEnvFile();
} catch {
  // no .env present; rely on process.env
}

export const HUB_URL = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';
export const CHAIN_REST_URL = process.env.WEVIBE_CHAIN_REST_URL ?? 'http://localhost:1317';
export const DASHBOARD_URL = process.env.WEVIBE_DASHBOARD_URL ?? 'https://app.wevibe.network';
export const OLLAMA_URL = process.env.WEVIBE_OLLAMA_URL ?? 'http://localhost:11434';
export const HTTP_HOST = process.env.WEVIBE_HTTP_HOST ?? '127.0.0.1';
export const DASHBOARD_PORT = process.env.WEVIBE_DASHBOARD_PORT ? Number(process.env.WEVIBE_DASHBOARD_PORT) : 4451;
export const EMBEDDING_BASE_URL = process.env.WEVIBE_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:1234/v1';
export const EMBEDDING_API_KEY = process.env.WEVIBE_EMBEDDING_API_KEY ?? 'lm-studio';
export const EMBEDDING_MODEL = process.env.WEVIBE_EMBEDDING_MODEL ?? 'nomic-embed-text:v1.5';
export const EMBEDDING_QUERY_PREFIX = process.env.WEVIBE_EMBEDDING_QUERY_PREFIX ?? 'search_query: ';
export const EMBEDDING_DOCUMENT_PREFIX = process.env.WEVIBE_EMBEDDING_DOCUMENT_PREFIX ?? 'search_document: ';
