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
import { runWeVibeGuard } from './guard.js';
import { ocrSanitize } from './ocr-sanitize.js';
import { extractArtifacts } from './artifact-extract.js';
import { checkArtifactPolicy } from './artifact-policy.js';
import { transformMemoryContent } from './artifact-transform.js';
import { vaultExists, isVaultUnlocked, unlockVault, retrievePassphraseFromKeychain, lockVault } from './vault.js';
import { read_project_manifest } from './manifest.js';
import type { MemoryResult } from './types.js';
import { setLlmProvider, getLlmProvider } from './llm.js';
import { getRiskAppetite, setRiskAppetite, getProviderPolicy, setProviderPolicy } from './risk-appetite.js';
import { createSamplingProvider } from './llm-sampling.js';
import { generateRecoveryPhrase } from './recovery.js';
import { getOrCreatePreIdentity, getPrePublicKeyHex } from './auth.js';
import { startHttpServer } from './http-server.js';
import { initSessionToken } from './session-token.js';
import { HUB_URL } from './config.js';

const ALLOW_UNREVIEWED = process.env.WEVIBE_ALLOW_UNREVIEWED === '1';

function recallTimeScan(plaintext: string): { text: string; flagged: boolean; detections: string[] } {
  try {
    const result = runWeVibeGuard(plaintext, [], {});
    if (!result.passed) {
      const detectionSummary = result.detections.map(d => `${d.field}:${d.scanner}/${d.rule}`);
      return {
        text: `[WEVIBE SECURITY: This memory was flagged by wevibe-guard at recall time and has been redacted. Detections: ${detectionSummary.join(', ')}]`,
        flagged: true,
        detections: detectionSummary,
      };
    }
    return { text: plaintext, flagged: false, detections: [] };
  } catch {
    throw new Error('wevibe-guard unavailable — cannot recall memories without security scanning. Install wevibe-guard or set WEVIBE_GUARD_BIN.');
  }
}

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

// Risk appetite is a client-side filter. The hub returns all relevant memories;
// the plugin filters by memory_type before showing the approval UI. See
// DECISIONS.md D-11.5.
server.tool(
	'wevibe_set_risk_appetite',
	"Set the consumer's risk appetite for memory recall. 'lowest' applies the strictest recall filter and 'neutral' applies the default recall filter. This affects which memories are shown for approval before agent injection.",
	{
    value: z.enum(['lowest', 'neutral']).optional().describe('Risk appetite value: "lowest" or "neutral". Omit to query current value.'),
  },
  async (args) => {
    if (args.value !== undefined) {
      try {
        setRiskAppetite(args.value);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, risk_appetite: args.value }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: (err as Error).message }) }],
        };
      }
    } else {
      const current = getRiskAppetite();
      return {
        content: [{ type: 'text', text: JSON.stringify({ risk_appetite: current }) }],
      };
    }
  }
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

async function rerankByRelevance(
    query: string,
    memories: Array<{ cid: string; epochId: number; score: number; plaintext: string }>
): Promise<Array<{ cid: string; epochId: number; score: number; plaintext: string }>> {
    const topN = Math.min(5, memories.length);
    const candidates = memories.slice(0, topN);

    const memoryDescriptions = candidates
        .map((m, i) => `[${i}] ${m.plaintext}`)
        .join('\n\n');

    const systemPrompt = `You are a relevance judge. Given a developer's query and candidate memories from a knowledge base, rank the memories by how directly they answer the query.

Return ONLY a JSON array of indices (0-based) ordered from most relevant to least relevant. Example: [2, 0, 1]

Criteria:
- The memory that most directly solves the specific problem in the query ranks first
- Topically related but not directly applicable memories rank lower
- Consider specificity: a memory about "SSH key management for Solana trading bots on VPS" is more relevant to that exact query than a generic "Solana Node.js development" memory`;

    const userMessage = `Query: ${query}\n\nCandidate memories:\n${memoryDescriptions}`;

    try {
        const llm = getLlmProvider();
        const response = await llm.chat(systemPrompt, userMessage, {
            temperature: 0.0,
            jsonFormat: true,
            timeoutMs: 30000,
        });

        const indices = JSON.parse(response) as number[];
        if (!Array.isArray(indices) || indices.length !== topN) {
            console.warn('rerankByRelevance: invalid response format');
            return memories;
        }

        const reranked: typeof memories = [];
        for (const idx of indices) {
            if (idx >= 0 && idx < topN) {
                reranked.push(candidates[idx]);
            } else {
                console.warn(`rerankByRelevance: invalid index ${idx} in response`);
                return memories;
            }
        }

        const remaining = memories.slice(topN);
        return [...reranked, ...remaining];
    } catch (e) {
        console.warn(`rerankByRelevance: failed — ${e}`);
        return memories;
    }
}

async function disambiguateMemories(
    query: string,
    memories: Array<{ cid: string; epochId: number; score: number; plaintext: string }>
): Promise<string | null> {
    const memoryDescriptions = memories
        .map((m, i) => `[Memory ${String.fromCharCode(65 + i)}] (score: ${m.score.toFixed(3)})\n${m.plaintext}`)
        .join('\n\n');

    const systemPrompt = `You are a technical advisor helping a developer choose between competing knowledge base memories.

Given a developer's query and multiple memories that address it, produce a structured comparison.

For each memory, provide:
1. A one-sentence summary of the approach
2. "Best when:" — the specific conditions where this approach is optimal
3. "Tradeoff:" — what you give up by choosing this approach

Then provide disambiguation questions — 2-3 yes/no or short-answer questions that would determine which memory is the best fit. These questions should target the specific conditions that differentiate the approaches.

Format your response EXACTLY like this (plain text, no markdown):

[Memory A] <one-sentence summary>
  Best when: <conditions>
  Tradeoff: <what you lose>

[Memory B] <one-sentence summary>
  Best when: <conditions>
  Tradeoff: <what you lose>

To determine the best approach, clarify with the user:
1. <question that differentiates A vs B>
2. <question about constraints>
3. <question about priorities>`;

    const userMessage = `Query: ${query}\n\n${memoryDescriptions}`;

    try {
        const llm = getLlmProvider();
        return await llm.chat(systemPrompt, userMessage, {
            temperature: 0.2,
            timeoutMs: 60000,
        });
    } catch {
        return null;
    }
}

type FormattedMemory = {
  cid: string;
  epochId: number;
  score: number;
  plaintext: string;
  breakdown?: MemoryResult['breakdown'];
  reranked?: boolean;
  artifactSummary?: Record<string, number>;
  annotations?: string[];
  redactedCount?: number;
  annotatedCount?: number;
};

export function formatMemoryPresentation(
  memories: FormattedMemory[],
  query: string,
  source: 'recall' | 'ambient',
): string {
  const lines: string[] = [];

  lines.push('context:');

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    lines.push(m.plaintext);

    if (m.redactedCount && m.redactedCount > 0) {
      lines.push(`[${m.redactedCount} artifact(s) redacted]`);
    }

    if (m.annotations && m.annotations.length > 0) {
      for (const ann of m.annotations) {
        lines.push(ann);
      }
    }

    if (i < memories.length - 1) {
      lines.push('');
    }

    if (m.breakdown) {
      const bd = m.breakdown;
      console.warn(`[wevibe-debug] CID:${m.cid.slice(0, 16)} vector=${bd.vector_score?.toFixed(3)} boost=${bd.capped_boost?.toFixed(3)} → ${bd.combined_score?.toFixed(3)}`);
    }
  }

  if (memories.some(m => m.redactedCount && m.redactedCount > 0)) {
    lines.push('');
    lines.push('[redacted content present]');
  }

  return lines.join('\n');
}

function buildElicitationPreview(
  memories: FormattedMemory[],
  query: string,
): string {
  const lines: string[] = [];
  lines.push(`WeVibe found ${memories.length} memory(ies) for "${query}":`);
  lines.push('');
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    lines.push(`[${i + 1}] Score:${m.score.toFixed(2)} | CID:${m.cid.slice(0, 12)}`);
    const preview = m.plaintext.length > 300
      ? m.plaintext.slice(0, 300).replace(/\n/g, ' ') + '...'
      : m.plaintext.replace(/\n/g, ' ');
    lines.push(preview);
    lines.push('');
  }
  lines.push('Approve these memories for agent use?');
  return lines.join('\n');
}

async function gateMemories(
  serverInstance: { getClientCapabilities?: () => unknown; elicitInput?: (params: unknown) => Promise<unknown> } | undefined,
  memories: FormattedMemory[],
  query: string,
  formattedOutput: string,
): Promise<{ allowed: boolean; text: string }> {
  let clientSupportsElicitation = false;

  try {
    const caps = serverInstance?.getClientCapabilities?.() as { elicitation?: unknown } | undefined;
    clientSupportsElicitation = !!caps?.elicitation;
  } catch {
    clientSupportsElicitation = false;
  }

  if (clientSupportsElicitation && typeof serverInstance?.elicitInput === 'function') {
    const preview = buildElicitationPreview(memories, query);
    try {
      const result = await serverInstance.elicitInput({
        message: preview,
        requestedSchema: {
          type: 'object' as const,
          properties: {
            approved: {
              type: 'boolean' as const,
              description: 'Allow the agent to use these memories?',
            },
          },
          required: ['approved'],
        },
      });

      const action = (result as { action?: string }).action;
      const content = (result as { content?: Record<string, unknown> }).content;
      if (action === 'accept' && content?.approved === true) {
        return { allowed: true, text: formattedOutput };
      }
      return { allowed: false, text: 'WeVibe: memories declined by user.' };
    } catch (e) {
      console.warn(`wevibe-mcp: elicitation failed — ${e}`);
      return { allowed: false, text: 'WeVibe: memory review failed. Memories withheld.' };
    }
  }

  if (ALLOW_UNREVIEWED) {
    return { allowed: true, text: formattedOutput };
  }

  return {
    allowed: false,
    text: [
      'WeVibe: found memories but your client does not support MCP elicitation (memory review).',
      'Memories are withheld to prevent unreviewed injection.',
      '',
      'Options:',
      '- Use a client that supports MCP elicitation (Claude Code, VS Code)',
      '- Set WEVIBE_ALLOW_UNREVIEWED=1 to accept unreviewed memories (at your own risk)',
    ].join('\n'),
  };
}

async function main() {
  setLlmProvider(createSamplingProvider(server.server));

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

  try {
    await initCrypto();
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

  await initSessionToken();
  startHttpServer();
}

main().catch(console.error);
