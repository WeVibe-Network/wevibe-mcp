// WeVibe onboarding + engagement hook for the opencode TUI (opencode >= 1.16).
//
// Registered via tui.json:  "plugin": [["<abs>/wevibe.tsx", { "adminScript": "<abs>/dist/admin.js" }]]
// Module shape per the TUI plugin spec: default export { id, tui }; no `server`.
//
// Surface (verified on 1.16.0): api.ui.DialogConfirm / DialogAlert via
// api.ui.dialog.replace(), api.ui.toast, api.keymap.registerLayer (slash
// commands), api.kv (persistence), api.event.on (session lifecycle).
//
// All privileged work (identity creation = Touch ID, pairing) is delegated to
// the `wevibe-admin` CLI via a child process. No JSX is authored here (dialog
// components are invoked as functions), so no @opentui build dependency.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIDECAR_PATH = path.join(os.homedir(), ".wevibe", "identity.json");

function readSidecar(): any | null {
  try {
    return JSON.parse(fs.readFileSync(SIDECAR_PATH, "utf8"));
  } catch {
    return null;
  }
}

type AdminLoc = { node: string; script: string | null; bin: string };

interface PluginOptions {
  adminScript?: string;
  node?: string;
}

const THRESHOLD = 3;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const KV_COUNTED = "wevibe.counted";
const KV_LAST_NUDGE_AT = "wevibe.lastNudgeAt";
const KV_LAST_NUDGE_N = "wevibe.lastNudgeN";

async function locateAdmin(api: any, options: PluginOptions | undefined): Promise<AdminLoc> {
  const node = options?.node || process.execPath || "node";
  // 1) explicit option (baked by install-opencode)
  if (options?.adminScript) {
    return { node, script: options.adminScript, bin: "wevibe-admin" };
  }
  // 2) derive from the opencode MCP config: mcp.wevibe.command = ["node", ".../dist/server.js"]
  try {
    const cfg = await api?.client?.config?.get?.();
    const cmd = cfg?.data?.mcp?.wevibe?.command;
    if (Array.isArray(cmd) && typeof cmd[1] === "string") {
      const script = path.join(path.dirname(cmd[1]), "admin.js");
      return { node: typeof cmd[0] === "string" ? cmd[0] : node, script, bin: "wevibe-admin" };
    }
  } catch {
    /* fall through */
  }
  // 3) PATH fallback
  return { node, script: null, bin: "wevibe-admin" };
}

function runAdmin(loc: AdminLoc, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const file = loc.script ? loc.node : loc.bin;
    const argv = loc.script ? [loc.script, ...args] : args;
    let out = "";
    let err = "";
    try {
      const child = spawn(file, argv, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e) }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e) });
    }
  });
}

function parseLastJson(s: string): any {
  const lines = s.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep scanning upward */
    }
  }
  return null;
}

const tui = async (api: any, options: PluginOptions | undefined, _meta: unknown) => {
  const loc = await locateAdmin(api, options);

  const toast = (variant: string, message: string, duration?: number) => {
    try {
      api.ui.toast({ variant, title: "WeVibe", message, duration });
    } catch {
      /* ignore */
    }
  };
  const alert = (message: string) => {
    try {
      api.ui.dialog.replace(() => api.ui.DialogAlert({ title: "WeVibe", message, onConfirm: () => api.ui.dialog.clear() }));
    } catch {
      /* ignore */
    }
  };
  const confirm = (message: string, onYes: () => void) => {
    try {
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "WeVibe",
          message,
          onConfirm: () => {
            api.ui.dialog.clear();
            onYes();
          },
          onCancel: () => api.ui.dialog.clear(),
        }),
      );
    } catch {
      /* ignore */
    }
  };

  const kvGet = <T,>(key: string, fallback: T): T => {
    try {
      return api.kv.get(key, fallback) as T;
    } catch {
      return fallback;
    }
  };
  const kvSet = (key: string, value: unknown) => {
    try {
      api.kv.set(key, value);
    } catch {
      /* ignore */
    }
  };

  const getStatus = async () => parseLastJson((await runAdmin(loc, ["identity-status", "--json"])).stdout);

  const createIdentity = () => {
    toast("info", "Creating your WeVibe identity — approve the Touch ID prompt…");
    runAdmin(loc, ["setup-identity", "--json"]).then((r) => {
      const res = parseLastJson(r.stdout);
      if (res?.status === "created") {
        alert(
          "WeVibe identity created \u2713\n\n" +
            "That's step 1 (your local keypair). Next, open app.wevibe.network to " +
            "join an org and become a contributor \u2014 contributing is how you earn " +
            "reputation & rewards. Run /wevibe-connect when you're ready.",
        );
      } else if (res?.status === "exists") {
        toast("info", "You already have a WeVibe identity.");
      } else if (/biometric|touch id|cancel/i.test(r.stderr)) {
        toast("warning", "Touch ID was cancelled — run /wevibe-setup to retry.", 6000);
      } else {
        toast("error", "Identity setup failed: " + (res?.error ?? r.stderr.slice(0, 140) ?? "unknown"), 8000);
      }
    });
  };

  const openDashboard = () => {
    toast("info", "Opening app.wevibe.network \u2014 join your org and contribute there\u2026");
    runAdmin(loc, ["export-pairing", "--open", "--json"]).then((r) => {
      const res = parseLastJson(r.stdout);
      if (res?.ok && res.opened) {
        toast("success", "Approve in your browser, then join your org to start contributing.", 7000);
      } else if (res?.ok && res.url) {
        toast("warning", "Open this to continue on the dashboard: " + res.url, 12000);
      } else {
        toast("error", "Couldn't open the dashboard: " + (r.stderr.slice(0, 140) || "unknown"), 8000);
      }
    });
  };

  // --- First-run onboarding -------------------------------------------------
  // Determine identity presence WITHOUT touching the keychain at startup (that
  // can raise a macOS keychain/Touch ID prompt). Prefer the non-secret sidecar
  // read over fs. Only if the sidecar is missing do we fall back to a (non-
  // biometric) CLI status probe — this covers legacy identities created before
  // sidecars existed.
  let identityPresent = false;
  let extracted = false;
  let adopted = false;

  const sc = readSidecar();
  if (sc?.ed25519PublicKey) {
    identityPresent = true;
    extracted = sc.extractedAt != null;
    adopted = sc.adoptedAt != null;
  } else {
    try {
      const status = await getStatus();
      if (status?.hasIdentity) {
        identityPresent = true;
        extracted = !!status.extracted;
        adopted = !!status.adopted;
        // Legacy identity with no sidecar — nudge to backfill, but don't nag with a modal.
        toast("info", "Finish WeVibe setup: run /wevibe-setup to refresh status.", 8000);
      }
    } catch {
      /* unknown — do not nag on error */
    }
  }

  if (!identityPresent) {
    // Small delay so the TUI is fully ready before the modal.
    setTimeout(() => {
      confirm(
        "No WeVibe identity detected.\n\n" +
          "Create your WeVibe identity now? This is step 1 (a local keypair). " +
          "You'll then join an org and contribute on app.wevibe.network.",
        createIdentity,
      );
    }, 900);
  }

  // --- Session-count nudge --------------------------------------------------
  const counted = new Set<string>(kvGet<string[]>(KV_COUNTED, []));

  const maybeNudge = () => {
    if (!identityPresent || extracted) return;
    const n = counted.size;
    if (n < THRESHOLD) return;
    const now = Date.now();
    const lastAt = kvGet<number>(KV_LAST_NUDGE_AT, 0);
    const lastN = kvGet<number>(KV_LAST_NUDGE_N, 0);
    if (now - lastAt < COOLDOWN_MS) return;
    if (n <= lastN) return;
    kvSet(KV_LAST_NUDGE_AT, now);
    kvSet(KV_LAST_NUDGE_N, n);
    confirm(
      adopted
        ? `You have ${n} coding sessions ready to contribute.\n\nOpen app.wevibe.network to contribute them?`
        : `You have ${n} coding sessions WeVibe can turn into contributions.\n\n` +
            `Open app.wevibe.network to join your org and start contributing? (Contributing is how you earn reputation & rewards.)`,
      openDashboard,
    );
  };

  const recordSession = (sessionID: unknown) => {
    if (typeof sessionID !== "string" || !sessionID) return;
    if (counted.has(sessionID)) return;
    counted.add(sessionID);
    kvSet(KV_COUNTED, [...counted]);
    maybeNudge();
  };

  const extractSessionId = (e: any): unknown =>
    e?.properties?.sessionID ?? e?.sessionID ?? e?.properties?.info?.id ?? e?.properties?.id;

  // session.idle is deprecated in favor of session.status; listen to both, dedupe by id.
  try {
    api.event.on("session.idle", (e: any) => recordSession(extractSessionId(e)));
  } catch {
    /* ignore */
  }
  try {
    api.event.on("session.status", (e: any) => {
      const status = e?.properties?.status?.type ?? e?.properties?.status;
      if (status === "idle" || status === undefined) recordSession(extractSessionId(e));
    });
  } catch {
    /* ignore */
  }

  // --- Slash commands / palette entries ------------------------------------
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "wevibe.setup",
          title: "WeVibe: Create / check identity",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-setup",
          run: createIdentity,
        },
        {
          name: "wevibe.connect",
          title: "WeVibe: Open dashboard (join org & contribute)",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-connect",
          run: openDashboard,
        },
        {
          name: "wevibe.status",
          title: "WeVibe: Show identity status",
          category: "WeVibe",
          namespace: "palette",
          slashName: "wevibe-status",
          run: () => {
            getStatus().then((s) => {
              if (!s) return toast("error", "Could not read WeVibe status.");
              if (!s.hasIdentity) return toast("info", "No WeVibe identity yet — run /wevibe-setup.");
              alert(
                `Identity: present\nKey: ${s.ed25519PublicKey ?? "(sidecar missing)"}\n` +
                  `Created: ${s.createdAt ?? "unknown"}\nExtracted: ${s.extracted}\n` +
                  `Sessions counted: ${counted.size}`,
              );
            });
          },
        },
      ],
    });
  } catch {
    /* keymap unavailable — slash commands simply won't register */
  }
};

export default { id: "wevibe", tui };
