# Contributing to WeVibe Network

Thank you for your interest in WeVibe Network.

**External contributions are currently paused during alpha development.**

This repository is private and under active development by the core team.
Pull requests from outside the organization will not be reviewed at
this time.

Once the network enters public testnet, this policy will change and
this document will be updated with contribution guidelines.

For questions about the project, see https://wevibe.network.

---

## Umbral WASM (vendor/umbral-wasm) — load-bearing facts

Umbral PRE runs in-process from WASM shipped inside this package
(`vendor/umbral-wasm`). There is no binary, no path, and no environment
variable. Three facts bind this repo:

1. **The `.wasm` is a COMMITTED build artifact.** Regenerating it is a
   maintainer step in `wevibe-umbral` (`scripts/build-wasm.sh`); the rebuilt
   `vendor/umbral-wasm/` must then be committed here. Nothing in this repo
   builds the WASM at install time — a missing or stale `vendor/` means the MCP
   is incomplete.

2. **`vendor/umbral-wasm/package.json` must NEVER gain `"type":"module"`.**
   This package is ESM (`"type":"module"`); the wasm-pack glue is CommonJS and
   only works because the vendored `package.json` omits a `type` field.

3. **Secrets must never transit argv.** The old sidecar passed
   `--seed`/`--delegating-sk`/`--receiving-sk` as argv (readable via `ps`/proc).
   If any subprocess is ever reintroduced for crypto, pass secrets on stdin —
   never argv.

Full build facts (core-crate wasm32 constraints, getrandom backend, toolchain
traps) live in `wevibe-umbral/CONTRIBUTING.md`.