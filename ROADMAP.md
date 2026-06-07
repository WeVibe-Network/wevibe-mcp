## Status

`wevibe-mcp` is in active alpha and already ships the local TypeScript pipeline used for memory retrieval and review.

Current delivered surface includes:

- Two-pass extraction support (memory extraction + keyword classification).
- Local safety processing (guard scanning, blacklist handling, artifact policy, OCR sanitization).
- Umbral encrypt/decrypt integration and PRE identity registration flows.
- Local identity lifecycle, recovery workflows, and vault-backed key management.
- OpenCode onboarding support, including install/uninstall automation and identity pairing helpers.

Today, the OpenCode plugin path is the production plugin integration.

## Near-term

- Add structured session profiling and stack-aware pre-filtering for recall quality.
- Harden endpoint resolution and response-auth assurance across hub interactions.
- Migrate toward a shared passkey-wrapped client key flow so local and dashboard usage can converge on the same identity model.

## Future

- Expand first-party integration support beyond OpenCode (Claude Code, Cursor, and Cline plugin surfaces).
- Surface attested provenance grades in approval experiences as the attestation framework becomes available.

## Design references

- WeVibe docs repository: https://github.com/WeVibe-Network/wevibe-docs
