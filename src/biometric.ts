import { createRequire } from 'node:module';

import { logOp, newTraceId } from './logger.js';

const require = createRequire(import.meta.url);

/**
 * Result shape returned by the native `wevibe-biometric` addon.
 * `outcome` ∈ "verified" | "unavailable" | "canceled" | "failed" | "error".
 */
interface BiometricResult {
  proceed: boolean;
  outcome: string;
  detail?: string | null;
}

interface BiometricAddon {
  isBiometricAvailable: () => boolean;
  requireBiometric: (reason: string) => Promise<BiometricResult>;
}

let cachedAddon: BiometricAddon | null | undefined;

/**
 * Loads the cross-platform native biometric addon (Touch ID / Windows Hello).
 * Returns null when the prebuilt native binding cannot be loaded (e.g. a
 * platform with no shipped prebuilt) — callers must fail open in that case.
 */
function loadAddon(): BiometricAddon | null {
  if (cachedAddon !== undefined) {
    return cachedAddon;
  }
  try {
    cachedAddon = require('wevibe-biometric') as BiometricAddon;
  } catch {
    cachedAddon = null;
  }
  return cachedAddon;
}

/**
 * Test/CI override. `WEVIBE_BIOMETRIC_FORCE` lets us exercise the gate mapping
 * without native hardware (verified | unavailable | error | deny/canceled).
 * NEVER weakens production: only active when the env var is explicitly set.
 */
function forcedOutcome(): BiometricResult | null {
  const forced = process.env.WEVIBE_BIOMETRIC_FORCE;
  if (!forced) {
    return null;
  }
  switch (forced) {
    case 'verified':
      return { proceed: true, outcome: 'verified' };
    case 'unavailable':
      return { proceed: true, outcome: 'unavailable', detail: 'forced' };
    case 'error':
      return { proceed: true, outcome: 'error', detail: 'forced' };
    case 'deny':
    case 'canceled':
      return { proceed: false, outcome: 'canceled', detail: 'forced' };
    default:
      return null;
  }
}

/**
 * Returns whether biometric prompting is available on the current machine.
 * On macOS this means Touch ID hardware present + enrolled; on Windows a
 * Windows Hello verifier is available. Never prompts; never throws.
 */
export function isBiometricAvailable(): boolean {
  const forced = process.env.WEVIBE_BIOMETRIC_FORCE;
  if (forced) {
    // A live prompt is simulated only for the verified/deny branches.
    return forced === 'verified' || forced === 'deny' || forced === 'canceled';
  }

  const addon = loadAddon();
  if (!addon) {
    return false;
  }
  try {
    return addon.isBiometricAvailable() === true;
  } catch {
    return false;
  }
}

/**
 * Requires biometric confirmation when available.
 *
 * FAIL-OPEN invariant (security + UX): a biometric failure must NEVER lock a
 * user out of their own identity. The OS keychain-at-rest is the security floor
 * (canon D-IDENTITY-CARRIER §1(iii)); the prompt is a defense-in-depth ceremony.
 * So this resolves `true` (proceed) when biometrics are unavailable / not
 * enrolled / the subsystem errors, and only resolves `false` (a retryable
 * block) on an explicit user cancel or authentication failure. Every non-verified
 * outcome is logged via the repo logger (R-37) — reasons/sizes only, no secrets.
 */
export async function requireBiometric(reason: string): Promise<boolean> {
  const trace = newTraceId();

  let result: BiometricResult;
  const forced = forcedOutcome();
  if (forced) {
    result = forced;
  } else {
    const addon = loadAddon();
    if (!addon) {
      logOp('biometric.auth', 'warn', {
        trace,
        outcome: 'error',
        reason: 'addon-load-failed',
        decision: 'fail-open-proceed',
      });
      return true;
    }
    try {
      result = await addon.requireBiometric(reason);
    } catch (err) {
      logOp('biometric.auth', 'warn', {
        trace,
        outcome: 'error',
        reason: 'addon-threw',
        err: err instanceof Error ? err.message : String(err),
        decision: 'fail-open-proceed',
      });
      return true;
    }
  }

  const proceed = result.proceed === true;
  logOp('biometric.auth', proceed ? 'info' : 'warn', {
    trace,
    outcome: result.outcome,
    detail: result.detail ?? '-',
    decision: proceed ? 'proceed' : 'block',
  });
  return proceed;
}
