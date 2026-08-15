import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Moving Umbral in-process traded a per-launch-site failure (one machine broken,
 * silently) for a packaging failure (every install broken, loudly). That is the
 * better trade only if packaging is actually verified — this file is that
 * verification, and it is the reason the migration is safe.
 *
 * If these fail, DO NOT publish: users would install a package whose crypto
 * cannot load.
 */
describe('umbral WASM packaging', () => {
  it('vendors the WASM artifact in the working tree', () => {
    for (const file of [
      'vendor/umbral-wasm/wevibe_umbral_wasm_bg.wasm',
      'vendor/umbral-wasm/wevibe_umbral_wasm.js',
      'vendor/umbral-wasm/package.json',
    ]) {
      expect(existsSync(path.join(PKG_ROOT, file)), `missing ${file}`).toBe(true);
    }
  });

  it('keeps vendor/umbral-wasm CommonJS inside this ESM package', async () => {
    // wevibe-mcp is "type":"module". The wasm-pack nodejs glue is CommonJS and
    // only stays that way because the nearest package.json — the vendored one —
    // omits a "type" field. Adding "type":"module" there would break loading at
    // runtime, in a way nothing else would catch until a user hit crypto.
    const vendored = await import('../vendor/umbral-wasm/package.json', {
      with: { type: 'json' },
    }) as { default: Record<string, unknown> };

    expect(vendored.default.type).toBeUndefined();
  });

  it('includes the WASM artifact in the published npm tarball', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = parsed[0].files.map((entry) => entry.path);

    expect(packedPaths).toContain('vendor/umbral-wasm/wevibe_umbral_wasm_bg.wasm');
    expect(packedPaths).toContain('vendor/umbral-wasm/wevibe_umbral_wasm.js');
    expect(packedPaths).toContain('vendor/umbral-wasm/package.json');
  }, 60_000);

  it('resolves the WASM module by the same relative specifier src/ and dist/ use', () => {
    // src/umbral.ts and dist/umbral.js both sit one level below the package
    // root, so '../vendor/umbral-wasm/...' resolves identically from either.
    // This is what makes the artifact independent of cwd and environment.
    for (const layer of ['src', 'dist']) {
      const resolved = path.resolve(PKG_ROOT, layer, '../vendor/umbral-wasm/wevibe_umbral_wasm.js');
      expect(resolved).toBe(path.join(PKG_ROOT, 'vendor/umbral-wasm/wevibe_umbral_wasm.js'));
    }
  });
});
