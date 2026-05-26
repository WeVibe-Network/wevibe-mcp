#!/usr/bin/env node

/**
 * wevibe-mcp dashboard server — MCP-over-SSE for the WeVibe dashboard.
 *
 * Runs as a separate process from the agent-facing wevibe-mcp.
 * Exposes moderation tools (queue, approve, deny) over HTTP/SSE
 * so the dashboard can use wevibe-mcp as its crypto + AI backend.
 *
 * Usage:
 *   node dist/dashboard-server.js [--port 4450]
 *
 * Environment:
 *   WEVIBE_HUB_URL           Hub URL (default: http://localhost:4440)
 *   WEVIBE_DASHBOARD_PORT    Server port (default: 4450)
 *   WEVIBE_OLLAMA_URL        Ollama URL (default: http://localhost:11434)
 *   WEVIBE_EXTRACTION_MODEL  LLM model for keyword extraction (default: qwen3:4b)
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { initCrypto, decryptSymmetric } from './crypto.js';
import { loadIdentity } from './key-store.js';
import { loadMemberships } from './org-client.js';
import { buildWeVibeSignedAuth } from './auth.js';
import {
  fetchPendingQueue,
  decryptPendingItem,
  approveSubmission,
  denySubmission,
  scanForSteganography,
  voteOnSubmission,
} from './moderation.js';
import { setLlmProvider } from './llm.js';
import { createOllamaProvider } from './llm-ollama.js';
import { vaultExists, isVaultUnlocked, unlockVault, retrievePassphraseFromKeychain } from './vault.js';
import { submitMemory } from './contribution.js';
import { getOrgKeywords } from './org-client.js';
import { extractKeywords, extractMemories, type ClassifiedKeyword, type SuggestedKeyword } from './extraction.js';

const HUB_URL = process.env.WEVIBE_HUB_URL ?? 'http://localhost:4440';

function resolvePort(): number {
  // CLI flag
  const portFlagIdx = process.argv.indexOf('--port');
  if (portFlagIdx !== -1 && process.argv[portFlagIdx + 1]) {
    const parsed = parseInt(process.argv[portFlagIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  // Env var
  if (process.env.WEVIBE_DASHBOARD_PORT) {
    const parsed = parseInt(process.env.WEVIBE_DASHBOARD_PORT, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 4450;
}

const PORT = resolvePort();

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function requireMembership(orgId?: string) {
  const memberships = await loadMemberships(HUB_URL);
  if (memberships.length === 0) {
    throw new Error('No org memberships found. Run wevibe-admin setup-identity and create or join an org first.');
  }
  if (orgId) {
    const m = memberships.find(m => m.orgId === orgId);
    if (!m) throw new Error(`Not a member of org ${orgId}`);
    return m;
  }
  return memberships[0];
}

function createMcpServer(): McpServer {
  const srv = new McpServer({
    name: 'wevibe-dashboard',
    version: '0.2.0',
  });

  srv.tool(
  'wevibe_mod_queue',
  'Fetch the moderation queue and decrypt all pending submissions. Returns plaintext content, stack hints, contributor info, and steganography scan results for each item.',
  { org_id: z.string().optional() },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);

    if (membership.role !== 'leader' && membership.role !== 'moderator') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `role "${membership.role}" cannot moderate` }) }],
      };
    }

    const items = await fetchPendingQueue(HUB_URL, membership.orgId);

    const decryptedItems = items.map(item => {
      const decrypted = decryptPendingItem(item, membership);
      let stegClean = true;
      let stegFindings: unknown[] = [];

      if (!decrypted.decryptError && decrypted.plaintext) {
        const scan = scanForSteganography(decrypted.plaintext);
        if (scan && !scan.clean) {
          stegClean = false;
          stegFindings = scan.findings ?? [];
        }
      }

      return {
        submission_hash: decrypted.submissionHash,
        epoch_id: decrypted.epochId,
        contributor_pubkey: decrypted.contributorPubkey,
        contributor_wallet: decrypted.contributorWallet ?? null,
        contributor_display_name: decrypted.contributorDisplayName ?? null,
        memory_type: decrypted.memoryType,
        stack_hint: decrypted.stackHint,
        created_at: decrypted.createdAt,
        plaintext: decrypted.plaintext || null,
        decrypt_error: decrypted.decryptError || null,
        steg_clean: stegClean,
        steg_findings: stegFindings,
        votes: item.votes ?? 0,
        required_approvals: item.required_approvals ?? 1,
        voter_pubkeys: item.voter_pubkeys ?? [],
      };
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(decryptedItems) }],
    };
  }
  );

srv.tool(
    'wevibe_mod_approve',
    'Approve a pending submission. This performs the full approval pipeline: unseal DEK with mod key, decrypt content, re-wrap DEK with encryption key, extract keywords via LLM, compute embedding vector, sign canonical message, and POST approval to hub.',
    {
      submission_hash: z.string().describe('The submission_hash from the moderation queue'),
      org_id: z.string().optional(),
    },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);

    if (membership.role !== 'leader' && membership.role !== 'moderator') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `role "${membership.role}" cannot approve` }) }],
      };
    }

    // Fetch queue and find the specific item
    const items = await fetchPendingQueue(HUB_URL, membership.orgId);
    const item = items.find(i => i.submission_hash === args.submission_hash);
    if (!item) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `submission ${args.submission_hash} not found` }) }],
      };
    }

    const result = await approveSubmission(
      HUB_URL,
      membership.orgId,
      item,
      membership,
    );

    if (result.status === 'error') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: result.error ?? 'approval failed' }) }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'approved',
          submission_hash: args.submission_hash,
          memory_type: item.memory_type,
          similar_memories: result.similarMemories ?? [],
        }),
      }],
    };
  }
  );

  srv.tool(
    'wevibe_mod_deny',
  'Deny a pending submission with a reason.',
  {
    submission_hash: z.string().describe('The submission_hash from the moderation queue'),
    reason: z.string().describe('Why this submission is being denied'),
    org_id: z.string().optional(),
  },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);

    if (membership.role !== 'leader' && membership.role !== 'moderator') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `role "${membership.role}" cannot deny` }) }],
      };
    }

    const result = await denySubmission(HUB_URL, membership.orgId, args.submission_hash, args.reason);

    if (result.status === 'error') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: result.error ?? 'denial failed' }) }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'denied',
          submission_hash: args.submission_hash,
          reason: args.reason,
        }),
      }],
    };
  }
);

srv.tool(
  'wevibe_mod_vote',
  'Cast an approval vote on a pending submission. For orgs with required_approvals > 1, multiple moderators must vote before the submission is approved. Returns current vote count and whether quorum is reached.',
  {
    submission_hash: z.string().describe('The submission_hash from the moderation queue'),
    org_id: z.string().optional(),
  },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);

    if (membership.role !== 'leader' && membership.role !== 'moderator') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `role "${membership.role}" cannot vote` }) }],
      };
    }

    const result = await voteOnSubmission(HUB_URL, membership.orgId, args.submission_hash);

    if (result.status === 'error') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: result.error ?? 'vote failed' }) }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: result.status,
          submission_hash: args.submission_hash,
          votes: result.votes,
          required_approvals: result.required_approvals,
          ready: result.ready,
        }),
      }],
    };
  }
);

  srv.tool(
    'wevibe_org_info',
  'Return information about the current org membership, identity, and connection status.',
  { org_id: z.string().optional() },
  async (args) => {
    await initCrypto();

    const identity = await loadIdentity();
    if (!identity) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'no identity found in keychain' }) }],
      };
    }

    const pubkeyHex = uint8ArrayToHex(identity.edPubkey);

    let memberships: Awaited<ReturnType<typeof loadMemberships>>;
    try {
      memberships = await loadMemberships(HUB_URL);
    } catch (e) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `failed to load org memberships: ${e}`,
            identity: pubkeyHex,
          }),
        }],
      };
    }

    if (memberships.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'no org membership found',
            identity: pubkeyHex,
          }),
        }],
      };
    }

    const membership = args.org_id
      ? memberships.find(m => m.orgId === args.org_id)
      : memberships[0];

    if (!membership) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `not a member of org ${args.org_id}` }) }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          org_id: membership.orgId,
          org_name: membership.orgName,
          role: membership.role,
          current_epoch: membership.currentEpoch,
          egress_mode: membership.egressMode,
          identity: pubkeyHex,
          hub_url: HUB_URL,
          mod_key_available: !!membership.modPrivkey,
          enc_key_count: membership.encKeys.size,
        }),
      }],
    };
  }
);

srv.tool(
  'wevibe_list_memories',
  'List all approved memories in the org with decrypted content. Returns a JSON array of memories with plaintext, keywords, epoch, and contributor info.',
  { org_id: z.string().optional(), limit: z.number().optional(), offset: z.string().optional() },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);
    const { headers } = await buildWeVibeSignedAuth();

    const limit = args.limit && Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 50;

    const params = new URLSearchParams({ limit: limit.toString() });
    if (args.offset) {
      params.set('offset', args.offset);
    }

    const listResp = await fetch(
      `${HUB_URL}/v1/orgs/${membership.orgId}/memories?${params.toString()}`,
      { headers },
    );

    if (!listResp.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `hub returned ${listResp.status}` }) }],
      };
    }

    const listData = await listResp.json() as {
      memories: Array<{
        cid: string;
        org_id: string;
        epoch_id: number;
        memory_type: 'correct_implementation' | 'negative_signal';
        wrapped_dek_enc: string;
        keywords?: Array<{ keyword: string; weight: number }>;
        content_flags?: string[];
        retrieval_count?: number;
      }>;
      count: number;
      next_offset?: string | null;
    };

    const decryptedMemories: Array<Record<string, unknown>> = [];

    for (const mem of listData.memories) {
      const encKey = membership.encKeys.get(mem.epoch_id);
      if (!encKey) {
        decryptedMemories.push({
          cid: mem.cid,
          epoch_id: mem.epoch_id,
          error: `no enc key for epoch ${mem.epoch_id}`,
        });
        continue;
      }

      if (!mem.wrapped_dek_enc) {
        decryptedMemories.push({ cid: mem.cid, epoch_id: mem.epoch_id, error: 'no wrapped_dek_enc' });
        continue;
      }

      try {
        const ctResp = await fetch(`${HUB_URL}/v1/orgs/${membership.orgId}/memories/${mem.cid}`);
        if (!ctResp.ok) {
          decryptedMemories.push({
            cid: mem.cid,
            epoch_id: mem.epoch_id,
            error: `ciphertext fetch failed: ${ctResp.status}`,
          });
          continue;
        }

        const ctData = await ctResp.json() as { ciphertext_hex: string };

        const wrappedDekEncBytes = new Uint8Array(Buffer.from(mem.wrapped_dek_enc, 'hex'));
        const dek = decryptSymmetric(wrappedDekEncBytes, encKey);
        const ciphertextBytes = new Uint8Array(Buffer.from(ctData.ciphertext_hex, 'hex'));
        const plaintextBytes = decryptSymmetric(ciphertextBytes, dek);
        const plaintext = Buffer.from(plaintextBytes).toString('utf-8');

        decryptedMemories.push({
          cid: mem.cid,
          epoch_id: mem.epoch_id,
          memory_type: mem.memory_type,
          plaintext,
          keywords: mem.keywords ?? [],
          content_flags: mem.content_flags ?? [],
          retrieval_count: mem.retrieval_count ?? 0,
        });
      } catch (e) {
        decryptedMemories.push({
          cid: mem.cid,
          epoch_id: mem.epoch_id,
          error: `decrypt failed: ${(e as Error).message}`,
        });
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          memories: decryptedMemories,
          count: listData.count,
          next_offset: listData.next_offset ?? null,
        }),
      }],
    };
  }
);

srv.tool(
  'wevibe_author_memory',
  'Leader-only administrative tool; not a normal contributor path. Authors a new memory directly and immediately approves it through the full pipeline (encryption, keyword extraction, embedding, indexing).',
  {
    content: z.string().describe('The memory content — a specific technical insight'),
    stack: z.array(z.string()).optional().describe('Technology tags (e.g. ["rust", "qdrant"])'),
    org_id: z.string().optional(),
    memory_type: z.enum(['correct_implementation', 'negative_signal']).optional(),
  },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);

    if (membership.role !== 'leader') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `role "${membership.role}" cannot author memories` }) }],
      };
    }

    const submitResult = await submitMemory(
      args.content,
      membership.orgId,
      HUB_URL,
      membership,
      args.memory_type ?? 'correct_implementation',
      args.stack ?? [],
    );

    if (submitResult.status !== 'pending' || !submitResult.submissionHash) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', error: submitResult.error ?? 'submit failed' }),
        }],
      };
    }

    const items = await fetchPendingQueue(HUB_URL, membership.orgId);
    const item = items.find(i => i.submission_hash === submitResult.submissionHash);
    if (!item) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', error: 'submitted but not found in queue — may need manual approval' }),
        }],
      };
    }

    const approveResult = await approveSubmission(HUB_URL, membership.orgId, item, membership);
    if (approveResult.status !== 'approved') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', error: `approval failed: ${approveResult.error ?? 'unknown error'}` }),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'authored',
          cid: submitResult.submissionHash,
          content_preview: args.content.slice(0, 120),
        }),
      }],
    };
  }
);

srv.tool(
  'wevibe_extract_keywords_batch',
  'Extract keywords from multiple memories in batch. For each memory, uses LLM to select from org vocabulary and suggest new keywords.',
  {
    org_id: z.string().optional(),
    memories: z.array(z.object({
      id: z.string(),
      plaintext: z.string(),
      stack_hint: z.array(z.string()),
      memory_type: z.string(),
    })),
  },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);

    const orgVocabulary = await getOrgKeywords(HUB_URL, membership.orgId);

    const results = await Promise.all(args.memories.map(async (mem) => {
      const { classified, suggestions } = await extractKeywords(
        mem.plaintext,
        mem.stack_hint,
        orgVocabulary,
      );
      return {
        id: mem.id,
        classified,
        suggestions,
      };
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(results) }],
    };
  }
);

srv.tool(
  'wevibe_extract_memories',
  'Extract structured technical insights from a session transcript.',
  {
    transcript: z.string(),
    project_context: z.object({
      title: z.string(),
      directory: z.string(),
      stack: z.array(z.string()).optional(),
    }),
  },
  async (args) => {
    await initCrypto();

    const result = await extractMemories(args.transcript, {
      name: args.project_context.title,
      stack: args.project_context.stack ?? [],
      directory: args.project_context.directory,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result.memories) }],
    };
  }
);

  return srv;
}

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const transports: { [sessionId: string]: { transport: SSEServerTransport; server: McpServer } } = {};

app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const srv = createMcpServer();

  transports[transport.sessionId] = { transport, server: srv };
  console.warn(`wevibe-dashboard: client connected (session: ${transport.sessionId})`);

  res.on('close', () => {
    console.warn(`wevibe-dashboard: client disconnected (session: ${transport.sessionId})`);
    srv.close().catch(() => {});
    delete transports[transport.sessionId];
  });

  await srv.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const entry = transports[sessionId];
  if (!entry) {
    res.status(400).json({ error: 'No transport found for sessionId' });
    return;
  }
  await entry.transport.handlePostMessage(req, res, req.body);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'wevibe-dashboard',
    hub: HUB_URL,
    sessions: Object.keys(transports).length,
  });
});

async function main(): Promise<void> {
  const ollamaUrl = process.env.WEVIBE_OLLAMA_URL ?? 'http://localhost:11434';
  const model = process.env.WEVIBE_EXTRACTION_MODEL ?? 'qwen3:4b';
  setLlmProvider(createOllamaProvider(ollamaUrl, model));
  console.warn(`wevibe-dashboard: LLM provider: Ollama (${ollamaUrl}, model: ${model})`);

  const storedPassphrase = await retrievePassphraseFromKeychain();
  if (storedPassphrase) {
    try {
      await unlockVault(storedPassphrase);
      console.warn('wevibe-dashboard: vault unlocked from keychain');
    } catch (e) {
      console.warn(`wevibe-dashboard: keychain vault unlock failed: ${e}`);
    }
  }

  await initCrypto();

  const identity = await loadIdentity();
  if (!identity) {
    console.error('wevibe-dashboard: FATAL — no identity found. Run wevibe-admin setup-identity first.');
    process.exit(1);
  }

  const pubkeyHex = uint8ArrayToHex(identity.edPubkey);
  console.warn(`wevibe-dashboard: identity: ${pubkeyHex.slice(0, 16)}...`);

  const memberships = await loadMemberships(HUB_URL);
  if (memberships.length === 0) {
    console.error('wevibe-dashboard: FATAL — no org membership found. Create or join an org first.');
    process.exit(1);
  }

  const m = memberships[0];
  console.warn(`wevibe-dashboard: org: ${m.orgName} (${m.orgId.slice(0, 8)}...), role: ${m.role}, epoch: ${m.currentEpoch}`);

  if (m.role !== 'leader' && m.role !== 'moderator') {
    console.error(`wevibe-dashboard: FATAL — role "${m.role}" cannot moderate. Dashboard requires leader or moderator role.`);
    process.exit(1);
  }

  if (!m.modPrivkey) {
    console.error('wevibe-dashboard: FATAL — moderation private key not available. Cannot decrypt submissions.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.warn(`wevibe-dashboard: MCP server running on http://localhost:${PORT}`);
    console.warn(`wevibe-dashboard: SSE endpoint: http://localhost:${PORT}/sse`);
    console.warn(`wevibe-dashboard: Health check: http://localhost:${PORT}/health`);
  });
}

main().catch(e => {
  console.error(`wevibe-dashboard: FATAL — ${e}`);
  process.exit(1);
});
