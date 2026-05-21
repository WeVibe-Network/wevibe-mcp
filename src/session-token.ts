import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TOKEN_BYTES = 32;

export class SessionTokenStore {
  private currentToken: string | null = null;

  constructor(public readonly tokenPath: string) {}

async init(): Promise<void> {
    const dir = dirname(this.tokenPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    await writeFile(this.tokenPath, token, { mode: 0o600 });
    await chmod(this.tokenPath, 0o600);
    this.currentToken = token;
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

export async function initSessionToken(): Promise<void> {
  return defaultStore.init();
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
