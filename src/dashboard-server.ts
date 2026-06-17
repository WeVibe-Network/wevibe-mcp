#!/usr/bin/env node

/**
 * wevibe-mcp dashboard server — MCP-over-SSE for the WeVibe dashboard.
 *
 * Runs as a separate process from the agent-facing wevibe-mcp.
 * Exposes moderation tools (queue, approve, deny) over HTTP/SSE
 * so the dashboard can use wevibe-mcp as its crypto + AI backend.
 *
 * Usage:
 *   node dist/dashboard-server.js [--port 4451]
 *
 * Environment:
 *   WEVIBE_HUB_URL           Hub URL (default from config)
 *   WEVIBE_DASHBOARD_PORT    Server port (default: 4451)
 *   WEVIBE_OLLAMA_URL        Ollama URL (default from config)
 *   WEVIBE_EXTRACTION_MODEL  LLM model for keyword extraction (default: qwen3:4b)
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { initCrypto, openEnvelope } from './crypto.js';
import { loadIdentity, hasStoredIdentitySeed } from './key-store.js';
import { loadMemberships, getEpochUmbralPk } from './org-client.js';
import {
  fetchPendingQueue,
  fetchModerationHistory,
  decryptPendingItem,
  decryptCiphertext,
  approveSubmission,
  denySubmission,
  scanForSteganography,
  voteOnSubmission,
  voteOnKeyword,
} from './moderation.js';
import { setLlmProvider, getLlmProvider } from './llm.js';
import { createOllamaProvider } from './llm-ollama.js';
import { vaultExists, isVaultUnlocked, unlockVault, retrievePassphraseFromKeychain } from './vault.js';
import { submitMemory } from './contribution.js';
import { getOrgKeywords } from './org-client.js';
import { extractKeywords, extractMemories, type ClassifiedKeyword, type SuggestedKeyword } from './extraction.js';
import { HUB_URL, DASHBOARD_PORT, OLLAMA_URL, EXTRACTION_MODEL, EMBEDDING_MODEL } from './config.js';
import { parseMemoryText, type StructuredMemory } from './retrieval-card.js';
import { embedRetrievalCard } from './embed-card.js';
import { umbralEncrypt } from './sidecar.js';

function resolvePort(): number {
  // CLI flag
  const portFlagIdx = process.argv.indexOf('--port');
  if (portFlagIdx !== -1 && process.argv[portFlagIdx + 1]) {
    const parsed = parseInt(process.argv[portFlagIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  // Env var (from config)
  if (Number.isFinite(DASHBOARD_PORT) && DASHBOARD_PORT > 0) {
    return DASHBOARD_PORT;
  }
  return 4451;
}

const PORT = resolvePort();
const BIND_HOST = process.env.WEVIBE_BIND_HOST ?? '127.0.0.1';

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

    if (membership.role !== 'leader' && !membership.canModerate) {
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
    'wevibe_decrypt_batch',
    'Decrypt a batch of encrypted submissions (ciphertext_hex + wrapped_dek_mod) using the moderation key. Returns plaintext per item.',
    {
      org_id: z.string().optional(),
      items: z.array(z.object({
        id: z.string(),
        ciphertext_hex: z.string(),
        wrapped_dek_mod: z.string(),
      })),
    },
    async (args) => {
      await initCrypto();
      const membership = await requireMembership(args.org_id);

      const results = args.items.map((item) => {
        const r = decryptCiphertext(item.ciphertext_hex, item.wrapped_dek_mod, membership);
        return {
          id: item.id,
          plaintext: r.plaintext ?? null,
          error: r.error,
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(results) }],
      };
    }
  );

  srv.tool(
    'wevibe_embed_retrieval_card',
    'Decrypt and embed retrieval cards for encrypted submissions. Returns document vectors and embedding metadata per item.',
    {
      org_id: z.string().optional(),
      items: z.array(z.object({
        id: z.string(),
        ciphertext_hex: z.string(),
        wrapped_dek_mod: z.string(),
        epoch_id: z.number(),
        stack_hint: z.array(z.string()),
      })),
    },
    async (args) => {
      await initCrypto();
      const membership = await requireMembership(args.org_id);
      const chatAdapter = async (system: string, user: string): Promise<string> => getLlmProvider().chat(system, user);

      const results: Array<{
        id: string;
        vector: number[] | null;
        embedding_model_id: string;
        embedding_schema_version: string;
        umbral_capsule: string | null;
        umbral_ciphertext: string | null;
        error?: string;
      }> = [];

      for (const item of args.items) {
        try {
          const decrypted = decryptCiphertext(item.ciphertext_hex, item.wrapped_dek_mod, membership);
          if (decrypted.error) {
            throw new Error(decrypted.error);
          }
          if (typeof decrypted.plaintext !== 'string') {
            throw new Error('decryption failed');
          }

          if (!membership.modPrivkey) {
            throw new Error('no moderation private key');
          }

          const dek = openEnvelope(
            new Uint8Array(Buffer.from(item.wrapped_dek_mod, 'hex')),
            membership.modPrivkey,
          );
          const epochUmbralPkHex = await getEpochUmbralPk(HUB_URL, membership.orgId, item.epoch_id);
          const { capsule, ciphertext } = await umbralEncrypt(
            epochUmbralPkHex,
            Buffer.from(dek).toString('hex'),
          );

          const parsed = parseMemoryText(decrypted.plaintext);
          const structured: StructuredMemory = {
            implement: parsed.implement,
            context: parsed.context,
            dnd: parsed.dnd,
            stack: item.stack_hint,
          };

          const { vector, embeddingModelId } = await embedRetrievalCard(structured, chatAdapter, { strictAnticipated: true });

          results.push({
            id: item.id,
            vector,
            embedding_model_id: embeddingModelId,
            embedding_schema_version: 'retrieval-card-v1',
            umbral_capsule: capsule,
            umbral_ciphertext: ciphertext,
          });
        } catch (e) {
          results.push({
            id: item.id,
            vector: null,
            embedding_model_id: EMBEDDING_MODEL,
            embedding_schema_version: 'retrieval-card-v1',
            umbral_capsule: null,
            umbral_ciphertext: null,
            error: (e as Error).message,
          });
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(results) }],
      };
    }
  );

  srv.tool(
    'wevibe_mod_history',
    'List moderation decisions from the last 24 hours (metadata only).',
    {},
    async () => {
      await initCrypto();
      const membership = await requireMembership();

      if (membership.role !== 'leader' && !membership.canModerate) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `role "${membership.role}" cannot moderate` }) }],
        };
      }

      const items = await fetchModerationHistory(HUB_URL, membership.orgId);

      return {
        content: [{ type: 'text', text: JSON.stringify(items) }],
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

    if (membership.role !== 'leader' && !membership.canModerate) {
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

    if (membership.role !== 'leader' && !membership.canModerate) {
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
  'Cast an advisory moderation vote (approve or flag) on a pending submission. Returns current vote tallies.',
  {
    submission_hash: z.string().describe('The submission_hash from the moderation queue'),
    vote: z.enum(['approve', 'flag']).describe('Advisory vote to cast on the submission'),
  },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership();

    if (membership.role !== 'leader' && !membership.canModerate) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `role "${membership.role}" cannot vote` }) }],
      };
    }

    try {
      const result = await voteOnSubmission(
        HUB_URL,
        membership.orgId,
        args.submission_hash,
        args.vote,
        membership,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: (e as Error).message }) }],
      };
    }
  }
);

srv.tool(
  'wevibe_mod_keyword_vote',
  'Cast an advisory include/exclude vote on a submission keyword. Returns current keyword vote tallies.',
  {
    submission_hash: z.string().describe('The submission_hash from the moderation queue'),
    keyword: z.string().describe('Keyword being voted on'),
    vote: z.enum(['include', 'exclude']).describe('Advisory keyword vote'),
  },
  async (args) => {
    await initCrypto();
    const membership = await requireMembership();

    if (membership.role !== 'leader' && !membership.canModerate) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `role "${membership.role}" cannot vote` }) }],
      };
    }

    try {
      const result = await voteOnKeyword(
        HUB_URL,
        membership.orgId,
        args.submission_hash,
        args.keyword,
        args.vote,
        membership,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: (e as Error).message }) }],
      };
    }
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
  'wevibe_author_memory',
  'Leader-only administrative tool; not a normal contributor path. Authors a new memory directly and immediately approves it through the full pipeline (encryption, keyword extraction, embedding, indexing).',
	{
		content: z.string().describe('The memory content — a specific technical insight'),
		stack: z.array(z.string()).optional().describe('Technology tags (e.g. ["rust", "qdrant"])'),
		org_id: z.string().optional(),
		memory_type: z.enum(['memory']).optional(),
	},
  async (args) => {
    await initCrypto();
    const membership = await requireMembership(args.org_id);

    if (membership.role !== 'leader') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: `role "${membership.role}" cannot author memories` }) }],
      };
    }

    const stackHint = args.stack ?? [];
    let keywords: { classified: ClassifiedKeyword[]; suggestions: SuggestedKeyword[] } = {
      classified: [],
      suggestions: [],
    };

    try {
      const orgVocabulary = await getOrgKeywords(HUB_URL, membership.orgId);
      keywords = await extractKeywords(args.content, stackHint, orgVocabulary);
    } catch (error) {
      console.warn(`wevibe-dashboard: wevibe_author_memory keyword extraction failed for org ${membership.orgId}: ${error}`);
    }

    const submitResult = await submitMemory(
      args.content,
      membership.orgId,
      HUB_URL,
		membership,
		args.memory_type ?? 'memory',
		stackHint,
		undefined,
		keywords,
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
    const membership = await requireMembership();

    const result = await extractMemories(args.transcript, {
      name: args.project_context.title,
      stack: args.project_context.stack ?? [],
      directory: args.project_context.directory,
    }, {
      orgContext: {
        orgId: membership.orgId,
        hubUrl: HUB_URL,
      },
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
  setLlmProvider(createOllamaProvider(OLLAMA_URL, EXTRACTION_MODEL));
  console.warn(`wevibe-dashboard: LLM provider: Ollama (${OLLAMA_URL}, model: ${EXTRACTION_MODEL})`);

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

  // Lazy identity (spec §F — mirrors server.ts): do NOT loadIdentity() here. It
  // triggers Touch ID at boot, and a member may legitimately have NO org membership
  // for a long time before joining one (by design). Requiring identity+membership at
  // boot made this launchd KeepAlive agent FATAL-exit on the no-membership state and
  // crash-loop, re-prompting Touch ID every ~10-15s. Identity, membership, and the mod
  // key now resolve lazily on first tool use; boot ALWAYS binds the port and idles.
  // Do NOT reintroduce a boot-time loadIdentity()/membership requirement here.
  if (!(await hasStoredIdentitySeed())) {
    console.warn('wevibe-dashboard: no identity yet — deferring; tools resolve identity/membership on first use (no boot biometric).');
  } else {
    console.warn('wevibe-dashboard: identity present; membership + mod key deferred to first use (no boot biometric).');
  }

  app.listen(PORT, BIND_HOST, () => {
    console.warn(`wevibe-dashboard: MCP server running on http://localhost:${PORT}`);
    console.warn(`wevibe-dashboard: SSE endpoint: http://localhost:${PORT}/sse`);
    console.warn(`wevibe-dashboard: Health check: http://localhost:${PORT}/health`);
  });
}

main().catch(e => {
  console.error(`wevibe-dashboard: FATAL — ${e}`);
  process.exit(1);
});
