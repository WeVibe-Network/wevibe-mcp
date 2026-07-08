import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts reads the repo .env from its package root via node:fs. Mock it so
// the tests are hermetic (no real .env leaks in) and so we can prove the loader
// resolves an ABSOLUTE package-root path rather than a CWD-relative one.
const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => false),
  readFileSyncMock: vi.fn(() => ''),
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

const ENV_KEYS = [
  'WEVIBE_ENV',
  'WEVIBE_HUB_URL',
  'WEVIBE_CHAIN_REST_URL',
  'WEVIBE_DASHBOARD_URL',
  'WEVIBE_MCP_HTTP_PORT',
];

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function loadConfig() {
  vi.resetModules();
  return import('../src/config.js');
}

describe('WEVIBE_ENV base-URL switch (wevibe-mcp/config.ts)', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false); // no .env → pure process.env resolution
    readFileSyncMock.mockReturnValue('');
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it('defaults to LOCAL base URLs when WEVIBE_ENV is unset', async () => {
    const cfg = await loadConfig();
    expect(cfg.WEVIBE_ENV).toBe('local');
    expect(cfg.DASHBOARD_URL).toBe('http://localhost:3001');
    expect(cfg.HUB_URL).toBe('http://localhost:4440');
    expect(cfg.CHAIN_REST_URL).toBe('http://localhost:1317');
    expect(cfg.HTTP_PORT).toBe(4450);
  });

  it('WEVIBE_ENV=local resolves to LOCAL base URLs', async () => {
    process.env.WEVIBE_ENV = 'local';
    const cfg = await loadConfig();
    expect(cfg.WEVIBE_ENV).toBe('local');
    expect(cfg.DASHBOARD_URL).toBe('http://localhost:3001');
    expect(cfg.HUB_URL).toBe('http://localhost:4440');
    expect(cfg.CHAIN_REST_URL).toBe('http://localhost:1317');
  });

  it('WEVIBE_ENV=production flips dashboard to app.wevibe.network + hub/chain to explicit placeholders', async () => {
    process.env.WEVIBE_ENV = 'production';
    const cfg = await loadConfig();
    expect(cfg.WEVIBE_ENV).toBe('production');
    // app.wevibe.network is the one canonical intended dashboard host (kept).
    expect(cfg.DASHBOARD_URL).toBe('https://app.wevibe.network');
    // hub/chain are EXPLICIT placeholders on the reserved .invalid TLD until the
    // real hosts are set at VPS deploy — assert the exact tokens AND prove they
    // are obvious placeholders, NOT invented real-looking domains.
    expect(cfg.HUB_URL).toBe('https://hub.PLACEHOLDER.invalid');
    expect(cfg.CHAIN_REST_URL).toBe('https://chain-rest.PLACEHOLDER.invalid');
    for (const url of [cfg.HUB_URL, cfg.CHAIN_REST_URL]) {
      expect(url).toContain('PLACEHOLDER');
      expect(url.endsWith('.invalid')).toBe(true);
      expect(url).not.toContain('wevibe.network'); // never a plausible real host
    }
  });

  it('an explicit per-URL env var wins over the WEVIBE_ENV base (production)', async () => {
    process.env.WEVIBE_ENV = 'production';
    process.env.WEVIBE_DASHBOARD_URL = 'http://localhost:9999';
    const cfg = await loadConfig();
    // override wins for dashboard; the others still follow the production base
    expect(cfg.DASHBOARD_URL).toBe('http://localhost:9999');
    expect(cfg.HUB_URL).toBe('https://hub.PLACEHOLDER.invalid');
  });

  it('WEVIBE_MCP_HTTP_PORT overrides the default 4450', async () => {
    process.env.WEVIBE_MCP_HTTP_PORT = '4460';
    const cfg = await loadConfig();
    expect(cfg.HTTP_PORT).toBe(4460);
  });

  it('loads wevibe-mcp/.env from the package root regardless of CWD', async () => {
    // A .env at the package root sets an override; process.env does NOT have it.
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      '# repo .env\nWEVIBE_DASHBOARD_URL=http://localhost:7777\nWEVIBE_HUB_URL="http://localhost:8888"\n',
    );
    const cfg = await loadConfig();
    expect(cfg.DASHBOARD_URL).toBe('http://localhost:7777');
    expect(cfg.HUB_URL).toBe('http://localhost:8888'); // quotes stripped
    // The loader read an ABSOLUTE package-root path (…/wevibe-mcp/.env), NOT a
    // CWD-relative './.env' — this is what makes it CWD-independent.
    const readPath = String(readFileSyncMock.mock.calls[0]?.[0] ?? '');
    expect(readPath.endsWith('/.env')).toBe(true);
    expect(readPath).toContain('wevibe-mcp');
  });

  it('real process.env wins over a value in the .env file', async () => {
    process.env.WEVIBE_DASHBOARD_URL = 'http://localhost:1111';
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('WEVIBE_DASHBOARD_URL=http://localhost:7777\n');
    const cfg = await loadConfig();
    expect(cfg.DASHBOARD_URL).toBe('http://localhost:1111');
  });
});
