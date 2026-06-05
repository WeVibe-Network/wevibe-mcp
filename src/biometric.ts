import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface NodeMacAuthModule {
  canPromptTouchID: () => boolean;
  promptTouchID: (options: { reason: string }) => unknown;
}

function loadNodeMacAuth(): NodeMacAuthModule | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    return require('node-mac-auth') as NodeMacAuthModule;
  } catch {
    return null;
  }
}

function canPromptBiometric(nodeMacAuth: NodeMacAuthModule): boolean {
  try {
    return nodeMacAuth.canPromptTouchID() === true;
  } catch {
    return false;
  }
}

/**
 * Returns whether biometric prompting is available on the current machine.
 * Availability requires macOS, a loadable node-mac-auth module, and Touch ID prompt support.
 */
export function isBiometricAvailable(): boolean {
  const nodeMacAuth = loadNodeMacAuth();
  if (!nodeMacAuth) {
    return false;
  }

  return canPromptBiometric(nodeMacAuth);
}

/**
 * Requires biometric confirmation when available.
 * On platforms where biometric prompting is unavailable, this resolves true as a graceful no-op.
 */
export async function requireBiometric(reason: string): Promise<boolean> {
  const nodeMacAuth = loadNodeMacAuth();
  if (!nodeMacAuth || !canPromptBiometric(nodeMacAuth)) {
    return true;
  }

  try {
    await Promise.resolve(nodeMacAuth.promptTouchID({ reason }));
    return true;
  } catch {
    return false;
  }
}
