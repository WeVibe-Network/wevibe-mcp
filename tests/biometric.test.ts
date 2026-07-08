import { describe, it, expect, afterEach } from 'vitest';

import { requireBiometric, isBiometricAvailable } from '../src/biometric.js';

/**
 * Verifies the fail-open + gate mapping in biometric.ts WITHOUT native hardware,
 * via the WEVIBE_BIOMETRIC_FORCE test override. This is the security/UX invariant
 * from the task + canon D-IDENTITY-CARRIER §1(iii): a biometric failure must
 * never lock a user out; only an explicit cancel/deny blocks (retryably).
 */
describe('biometric gate mapping (fail-open)', () => {
  const original = process.env.WEVIBE_BIOMETRIC_FORCE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WEVIBE_BIOMETRIC_FORCE;
    } else {
      process.env.WEVIBE_BIOMETRIC_FORCE = original;
    }
  });

  it('fail-open (proceeds) when biometrics are unavailable', async () => {
    process.env.WEVIBE_BIOMETRIC_FORCE = 'unavailable';
    expect(await requireBiometric('unlock')).toBe(true);
    expect(isBiometricAvailable()).toBe(false);
  });

  it('fail-open (proceeds) on a subsystem/prompt error', async () => {
    process.env.WEVIBE_BIOMETRIC_FORCE = 'error';
    expect(await requireBiometric('unlock')).toBe(true);
  });

  it('blocks (retryable) on explicit user cancel/deny', async () => {
    process.env.WEVIBE_BIOMETRIC_FORCE = 'deny';
    expect(await requireBiometric('unlock')).toBe(false);
    expect(isBiometricAvailable()).toBe(true);
  });

  it('proceeds on a verified prompt', async () => {
    process.env.WEVIBE_BIOMETRIC_FORCE = 'verified';
    expect(await requireBiometric('unlock')).toBe(true);
    expect(isBiometricAvailable()).toBe(true);
  });
});
