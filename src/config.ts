import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- .env loader (CWD-independent) ----------------------------------------
// Resolve the repo's .env from THIS module's location (the package root), NOT
// from process.cwd(): the admin.js / server.js child is spawned with the
// launcher's CWD (e.g. opencode's dir), so a CWD-relative load silently
// ignores the repo .env. `import.meta.url` points at src/config.ts (tsx dev)
// or dist/config.js (built) — both sit exactly one level under the package
// root, so `..` reaches it in either case. One explicit path, no fallbacks.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(PACKAGE_ROOT, '.env');

function loadEnvFromPackageRoot(): void {
  if (!existsSync(ENV_FILE)) return; // graceful: no .env present → rely on process.env
  let raw: string;
  try {
    raw = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return; // unreadable → rely on process.env
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real process.env wins over the .env file (predictable precedence).
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFromPackageRoot();

// --- WEVIBE_ENV base-URL switch -------------------------------------------
// ONE .env-driven flag selects the base URL set for every service.
// Precedence (R-13): explicit per-URL env var > WEVIBE_ENV base default > (none).
// DEFAULT is 'local' — this project is local-first; no public URLs are live yet.
export type WevibeEnv = 'local' | 'production';

export const WEVIBE_ENV: WevibeEnv =
  process.env.WEVIBE_ENV?.trim().toLowerCase() === 'production' ? 'production' : 'local';

interface EnvBaseUrls {
  hub: string;
  chainRest: string;
  dashboard: string;
}

const LOCAL_BASE: EnvBaseUrls = {
  hub: 'http://localhost:4440',
  chainRest: 'http://localhost:1317',
  dashboard: 'http://localhost:3001',
};

// Public infra is NOT deployed yet. hub/chainRest are EXPLICIT PLACEHOLDERS on
// the reserved `.invalid` TLD (RFC 6761 — can never resolve to real infra), so
// they can't be mistaken for live hosts. Fill the real value at VPS deploy via
// the per-URL env vars below (WEVIBE_HUB_URL / WEVIBE_CHAIN_REST_URL — they win
// over this base; see .env.example). `app.wevibe.network` is the one canonical
// intended dashboard host (referenced in CANONICALUX/canon), not a placeholder.
const PRODUCTION_BASE: EnvBaseUrls = {
  hub: 'https://hub.PLACEHOLDER.invalid', // TODO(VPS): set real host at deploy
  chainRest: 'https://chain-rest.PLACEHOLDER.invalid', // TODO(VPS): set real host at deploy
  dashboard: 'https://app.wevibe.network', // canonical intended dashboard host
};

const BASE: EnvBaseUrls = WEVIBE_ENV === 'production' ? PRODUCTION_BASE : LOCAL_BASE;

export const HUB_URL = process.env.WEVIBE_HUB_URL ?? BASE.hub;
export const CHAIN_REST_URL = process.env.WEVIBE_CHAIN_REST_URL ?? BASE.chainRest;
export const DASHBOARD_URL = process.env.WEVIBE_DASHBOARD_URL ?? BASE.dashboard;

// MCP local HTTP sidecar port — env-driven so it can't silently diverge from
// the dashboard's WEVIBE_MCP_HTTP_URL. The MCP is a LOCAL sidecar in BOTH
// modes (127.0.0.1), so this is not part of the local/public URL switch.
export const HTTP_PORT = process.env.WEVIBE_MCP_HTTP_PORT
  ? Number(process.env.WEVIBE_MCP_HTTP_PORT)
  : 4450;

// Local-always services (model/embedding servers, bind host, moderation SSE
// port) — not switched by WEVIBE_ENV; still individually env-overridable.
export const OLLAMA_URL = process.env.WEVIBE_OLLAMA_URL ?? 'http://localhost:11434';
export const HTTP_HOST = process.env.WEVIBE_HTTP_HOST ?? '127.0.0.1';
export const EMBEDDING_BASE_URL = process.env.WEVIBE_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:1234/v1';
export const EMBEDDING_API_KEY = process.env.WEVIBE_EMBEDDING_API_KEY ?? 'lm-studio';
export const EMBEDDING_MODEL = process.env.WEVIBE_EMBEDDING_MODEL ?? 'nomic-embed-text:v1.5';
export const EMBEDDING_QUERY_PREFIX = process.env.WEVIBE_EMBEDDING_QUERY_PREFIX ?? 'search_query: ';
export const EMBEDDING_DOCUMENT_PREFIX = process.env.WEVIBE_EMBEDDING_DOCUMENT_PREFIX ?? 'search_document: ';
