import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSidecarPath, readIdentitySidecar, writeIdentitySidecar } from '../src/identity-sidecar.js';

const previousWevibeHome = process.env.WEVIBE_HOME;
const realHomeSidecarPath = join(homedir(), '.wevibe', 'identity.json');

function restoreWevibeHome(): void {
  if (previousWevibeHome === undefined) {
    delete process.env.WEVIBE_HOME;
    return;
  }

  process.env.WEVIBE_HOME = previousWevibeHome;
}

describe('identity-sidecar WEVIBE_HOME isolation', () => {
  afterEach(() => {
    restoreWevibeHome();
  });

  it('uses the real user home WeVibe directory when WEVIBE_HOME is unset', () => {
    delete process.env.WEVIBE_HOME;

    expect(getSidecarPath()).toBe(realHomeSidecarPath);
  });

  it('reads and writes under WEVIBE_HOME without writing the real user home sidecar', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'wevibe-identity-sidecar-'));
    const realHomeBefore = existsSync(realHomeSidecarPath) ? readFileSync(realHomeSidecarPath, 'utf-8') : null;

    try {
      process.env.WEVIBE_HOME = isolatedHome;
      const isolatedSidecarPath = join(isolatedHome, 'identity.json');

      expect(getSidecarPath()).toBe(isolatedSidecarPath);
      expect(readIdentitySidecar()).toBeNull();

      const written = writeIdentitySidecar({
        ed25519PublicKey: 'aa',
        x25519PublicKey: 'bb',
        createdAt: '2026-07-30T12:40:00.000Z',
        platform: process.platform,
        biometric: false,
      });

      expect(written.ed25519PublicKey).toBe('aa');
      expect(existsSync(isolatedSidecarPath)).toBe(true);
      expect(readIdentitySidecar()?.x25519PublicKey).toBe('bb');

      const realHomeAfter = existsSync(realHomeSidecarPath) ? readFileSync(realHomeSidecarPath, 'utf-8') : null;
      expect(realHomeAfter).toBe(realHomeBefore);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});
