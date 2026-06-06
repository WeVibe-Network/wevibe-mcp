import { loadIdentity } from './key-store.js';
import { getOrCreatePreIdentity, getPrePublicKeyHex } from './auth.js';
import { loadMemberships, registerPrePubkey } from './org-client.js';
import { HUB_URL } from './config.js';

/**
 * Lazy identity access (spec §F).
 *
 * Previously the MCP server loaded the identity at boot (server.ts main()),
 * which triggered a Touch ID prompt on every startup with no visible feedback.
 * Identity loading is now deferred to the first action that actually needs
 * signing/decryption. The first successful load (per process) also performs
 * one-time PRE-pubkey registration with the hub for each membership — work that
 * used to happen eagerly at boot.
 *
 * `loadIdentity()` itself memoizes the derived identity for the process, so the
 * biometric prompt happens at most once per MCP process, and only on demand.
 */

let registrationDone = false;

export async function ensureIdentity(): Promise<Awaited<ReturnType<typeof loadIdentity>>> {
  const identity = await loadIdentity(); // prompts biometric on first call per process
  if (!identity) return null;

  if (!registrationDone) {
    // Mark first so a transient failure doesn't re-prompt or spin; reset on error.
    registrationDone = true;
    try {
      await getOrCreatePreIdentity();
      const prePubkeyHex = getPrePublicKeyHex();
      const memberPubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
      const memberships = await loadMemberships(HUB_URL);
      for (const membership of memberships) {
        await registerPrePubkey(HUB_URL, membership.orgId, memberPubkeyHex, prePubkeyHex);
      }
    } catch (e) {
      registrationDone = false;
      console.warn(`wevibe-mcp: deferred PRE-pubkey registration failed — ${e}`);
    }
  }

  return identity;
}
