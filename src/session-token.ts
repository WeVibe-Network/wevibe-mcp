import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile, chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKEN_BYTES = 32;
const TOKEN_REGEX = /^[A-Za-z0-9]+$/;

function readTokenFromDisk(tokenPath: string): string | null {
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    if (token.length > 0 && TOKEN_REGEX.test(token)) {
      return token;
    }
  } catch {
    // Fall through to random token generation on any read error.
  }
  return null;
}

export class SessionTokenStore {
  private currentToken: string | null = null;

  constructor(public readonly tokenPath: string) {}

  initialize(): void {
    // Read-from-disk-first so concurrent MCP instances (e.g. multiple OpenCode windows)
    // share one stable token; only the process that binds the HTTP port persists it.
    const token = readTokenFromDisk(this.tokenPath) ?? randomBytes(TOKEN_BYTES).toString('hex');
    this.currentToken = token;
  }

  async writeToDisk(): Promise<void> {
    if (!this.currentToken) {
      throw new Error('Session token not initialized');
    }

    const dir = dirname(this.tokenPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(this.tokenPath, this.currentToken, { mode: 0o600 });
    await chmod(this.tokenPath, 0o600);
  }

  async init(): Promise<void> {
    this.initialize();
    await this.writeToDisk();
  }

verify(presented: string | undefined): boolean {
    if (!presented || !this.currentToken) return false;
    if (presented.length !== this.currentToken.length) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.currentToken);
    return timingSafeEqual(a, b);
  }

  getToken(): string | null {
    return this.currentToken;
  }

  _reset(): void {
    this.currentToken = null;
  }
}

function defaultTokenPath(): string {
  return join(homedir(), '.wevibe', 'mcp-session-token');
}

export const defaultStore = new SessionTokenStore(defaultTokenPath());

export function initSessionToken(): void {
  defaultStore.initialize();
}

export async function persistSessionToken(): Promise<void> {
  await defaultStore.writeToDisk();
}

export function verifySessionToken(presented: string | undefined): boolean {
  return defaultStore.verify(presented);
}

export function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+([A-Za-z0-9]+)$/);
  return m ? m[1] : undefined;
}

export function __resetTokenForTests(): void {
  defaultStore._reset();
}

let _activeStore: SessionTokenStore = defaultStore;

export function _setTokenStoreForTests(store: SessionTokenStore): void {
  _activeStore = store;
}

export function _getActiveStore(): SessionTokenStore {
  return _activeStore;
}

export const TOKEN_FILE_PATH = defaultTokenPath();
