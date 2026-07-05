import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { initCrypto, decryptSymmetric } from './crypto.js';
import { loadIdentity, storeIdentitySeed, generateIdentitySeed, loadKeyEnvelope, hasStoredIdentitySeed } from './key-store.js';
import { loadMemberships, createOrg, registerPrePubkey } from './org-client.js';
import { deserializeMemoryResult } from './deserialize.js';
import { add_to_blacklist, is_blacklisted } from './blacklist.js';
import { dissect_to_keywords, detect_session } from './session.js';
import { computeEmbedding } from './extraction.js';
import { submitMemory } from './contribution.js';
import { extractArtifacts } from './artifact-extract.js';
import { checkArtifactPolicy } from './artifact-policy.js';
import { transformMemoryContent } from './artifact-transform.js';
import { vaultExists, isVaultUnlocked, unlockVault, retrievePassphraseFromKeychain, lockVault } from './vault.js';
import { read_project_manifest } from './manifest.js';
import { getProviderPolicy, setProviderPolicy } from './risk-appetite.js';
import { generateRecoveryPhrase } from './recovery.js';
import { getOrCreatePreIdentity, getPrePublicKeyHex } from './auth.js';
import { startHttpServer, stopHttpServer } from './http-server.js';
import { refreshOpenRouterCatalog } from './openrouter-catalog.js';
import { initSessionToken, persistSessionToken } from './session-token.js';
import { HUB_URL } from './config.js';

async function getIdentityPubkeyHex(): Promise<string | null> {
  const identity = await loadIdentity();
  if (!identity) return null;
  return Buffer.from(identity.edPubkey).toString('hex');
}

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

const server = new McpServer({
  name: 'wevibe',
  version: '0.2.0',
});

server.tool(
  'setup_org',
  'Create a new WeVibe Network org when no membership exists. Generates identity if needed, provisions the org on the hub, and returns the recovery phrase. The recovery phrase must be shown to the user immediately.',
  {
    org_name: z.string().describe('Human-readable org name (e.g. "Acme Engineering")'),
    domain: z.string().describe('Org domain of expertise/specialization (e.g. "React, Next.js, TypeScript")'),
  },
  async (args) => {
    await initCrypto();

    let identity = await loadIdentity();
    if (!identity) {
      const seed = generateIdentitySeed();
      await storeIdentitySeed(seed);
      identity = await loadIdentity();
      if (!identity) {
        return { content: [{ type: 'text', text: 'WeVibe: failed to create identity.' }] };
      }
    }

    const result = await createOrg({
      orgName: args.org_name,
      domain: args.domain,
      hubUrl: HUB_URL,
    });

    if (result.status !== 'created') {
      const errorText = result.error ?? 'unknown error';
      return { content: [{ type: 'text', text: `WeVibe: org creation failed — ${errorText}` }] };
    }

    const pubkeyHex = Buffer.from(identity.edPubkey).toString('hex');
    try {
      await getOrCreatePreIdentity();
      await registerPrePubkey(HUB_URL, result.orgId, pubkeyHex, getPrePublicKeyHex());
    } catch (e) {
      console.warn(`wevibe-mcp: PRE pubkey registration during setup_org failed: ${e}`);
    }

    let recoveryPhrase = '(recovery phrase unavailable — master key not found in keychain)';
    if (result.orgId) {
      const masterKey = await loadKeyEnvelope(result.orgId, 'master');
      if (masterKey) {
        try {
          recoveryPhrase = generateRecoveryPhrase(masterKey);
        } catch (e) {
          recoveryPhrase = `(recovery phrase generation failed — ${(e as Error).message})`;
        }
      }
    }

    const lines = [
      'WeVibe: org created successfully.',
      '',
      `Org ID: ${result.orgId}`,
      `Org name: ${args.org_name}`,
      `Leader pubkey: ${pubkeyHex}`,
      `Hub: ${HUB_URL}`,
      '',
      '+--------------------------------------------------------------------+',
      '|  RECOVERY PHRASE — SHOW THIS TO THE USER IMMEDIATELY               |',
      '+--------------------------------------------------------------------+',
      `|  ${recoveryPhrase.padEnd(66)}|`,
      '+--------------------------------------------------------------------+',
      '|  This phrase is the ONLY way to recover the org master key.        |',
      '|  Copy it offline now; it cannot be displayed again.                |',
      '+--------------------------------------------------------------------+',
      '',
      'The org is ready. recall and contribute will now work.',
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  'wevibe_status',
  'Query WeVibe organization subscription and billing status. Returns membership information and credit balance for the connected org.',
  {
    org_id: z.string().optional().describe('Specific org ID to check. Defaults to the first connected org.'),
  },
  async (args) => {
    await initCrypto();

    const pubkey = await getIdentityPubkeyHex();
    if (!pubkey) {
      return { content: [{ type: 'text', text: 'WeVibe: no identity found in keychain.' }] };
    }

    let memberships: Awaited<ReturnType<typeof loadMemberships>>;
    try {
      memberships = await loadMemberships(HUB_URL);
    } catch (e) {
      return { content: [{ type: 'text', text: `WeVibe: failed to load org memberships from hub — ${e}` }] };
    }

    if (memberships.length === 0) {
      return { content: [{ type: 'text', text: 'WeVibe: not connected to any org.' }] };
    }

    const membership = args.org_id
      ? memberships.find(m => m.orgId === args.org_id)
      : memberships[0];

    if (!membership) {
      return { content: [{ type: 'text', text: `WeVibe: org ${args.org_id} not found in memberships.` }] };
    }

    interface CreditsResponse {
      org_id: string;
      balance: number;
      transactions: Array<{
        txn_id: number;
        org_id: string;
        delta: number;
        reason: string;
        actor: string;
        created_at: string;
      }>;
    }

    let creditsData: CreditsResponse | null = null;
    try {
      const resp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/credits`);
      if (resp.ok) {
        creditsData = await resp.json() as CreditsResponse;
      }
    } catch {
      // Hub unavailable
    }

    const lines: string[] = [];
    lines.push(`Org: ${membership.orgName}`);
    lines.push(`Org ID: ${membership.orgId}`);
    lines.push(`Role: ${membership.role}`);
    lines.push(`Current Epoch: ${membership.currentEpoch}`);

    if (creditsData) {
      lines.push('');
      lines.push(`Credits Balance: ${creditsData.balance}`);
      if (creditsData.transactions && creditsData.transactions.length > 0) {
        lines.push('Recent Transactions:');
        for (const txn of creditsData.transactions.slice(0, 5)) {
          const date = new Date(txn.created_at).toLocaleDateString();
          const sign = txn.delta >= 0 ? '+' : '';
          lines.push(`  ${date} ${sign}${txn.delta} (${txn.reason}) by ${txn.actor}`);
        }
      }
    } else {
      lines.push('');
      lines.push('Credits: unavailable (hub unreachable)');
    }

    if (memberships.length > 1) {
      lines.push('');
      lines.push(`Connected to ${memberships.length} org(s). Use org_id to select a different one.`);

      const otherOrgs = memberships
        .filter(m => m.orgId !== membership.orgId)
        .map(m => `  - ${m.orgName} (${m.orgId}): ${m.role}`)
        .join('\n');
      if (otherOrgs) {
        lines.push(otherOrgs);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// Register a no-op prompt so the MCP SDK advertises the prompts capability
// and clients get a clean prompts/list response instead of -32601.
server.prompt(
  'wevibe_usage',
  'How to use WeVibe Network memory tools: recall (query memories), contribute (record learnings), reject (blacklist bad memories), setup_org (create new org), wevibe_status (check billing).',
  {},
  () => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: 'How do I use WeVibe Network? Available tools: recall (query team memories by topic), contribute (record technical learnings), reject (blacklist a bad memory), setup_org (create a new org), wevibe_status (check subscription status).',
      },
    }],
  }),
);

server.tool(
  'wevibe_set_provider_policy',
  "Set provider leakage policy for recall delivery. 'unrestricted' allows all providers, 'local_only' allows only local providers, and 'allowlist' allows only providers in the org allowlist.",
  {
    value: z.enum(['unrestricted', 'local_only', 'allowlist']).optional().describe('Provider policy value: "unrestricted", "local_only", or "allowlist". Omit to query current value.'),
  },
  async (args) => {
    if (args.value !== undefined) {
      try {
        setProviderPolicy(args.value);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, provider_policy: args.value }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: (err as Error).message }) }],
        };
      }
    } else {
      const current = getProviderPolicy();
      return {
        content: [{ type: 'text', text: JSON.stringify({ provider_policy: current }) }],
      };
    }
  }
);

async function main() {
  const storedPassphrase = await retrievePassphraseFromKeychain();
  if (storedPassphrase) {
    try {
      await unlockVault(storedPassphrase);
    } catch {
      // Keychain passphrase didn't work, vault stays locked
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Contract: plugin-launched detached HTTP-only mode (stdio ignored => stdin=/dev/null)
  // must set this to skip stdin/transport-close shutdown, or immediate EOF self-terminates.
  const httpOnly = process.env.WEVIBE_MCP_HTTP_ONLY === '1';

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const exitNow = (): void => {
      try {
        process.exit(0);
      } catch (err) {
        console.error(`wevibe-mcp: process exit failed: ${err}`);
      }
    };

    console.error(`wevibe-mcp: shutting down (${reason})`);
    const hardTimeout = setTimeout(() => exitNow(), 3000);
    hardTimeout.unref();

    await stopHttpServer();

    try {
      await server.close();
    } catch (err) {
      console.error(`wevibe-mcp: MCP server close failed: ${err}`);
    }

    try {
      await transport.close();
    } catch (err) {
      console.error(`wevibe-mcp: transport close failed: ${err}`);
    }

    exitNow();
  };

  if (!httpOnly) {
    const priorTransportOnClose = transport.onclose;
    transport.onclose = () => {
      priorTransportOnClose?.();
      void shutdown('transport-close');
    };

    process.stdin.on('end', () => {
      void shutdown('stdin-end');
    });

    process.stdin.on('close', () => {
      void shutdown('stdin-close');
    });
  }

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      void shutdown(sig);
    });
  }

  try {
    await initCrypto();
    // Warm the OpenRouter model catalog in the background (24h TTL, bounded fetch, never throws).
    // Non-blocking so a slow/absent network never delays server startup (R-31).
    void refreshOpenRouterCatalog();
    // Lazy identity (spec §F): do NOT load the identity OR call any hub API that
    // signs with it at boot — both trigger Touch ID. loadMemberships() internally
    // calls loadIdentity(), so it must NOT run here. Only a non-prompting
    // existence check is allowed; everything else defers to first use.
    if (!(await hasStoredIdentitySeed())) {
      console.warn('wevibe-mcp: No identity found. Run wevibe-admin setup-identity or use the wevibe_setup_org tool to get started.');
    } else {
      console.warn('wevibe-mcp: Identity present. Membership sync + PRE-pubkey registration deferred to first use (no boot-time biometric).');
    }
  } catch (e) {
    console.warn(`wevibe-mcp: first-run check failed — ${e}`);
  }

  if (isVaultUnlocked()) {
    lockVault();
  }

  initSessionToken();
  const httpStarted = await startHttpServer();
  if (httpStarted) {
    await persistSessionToken();
  }
}

main().catch(console.error);
