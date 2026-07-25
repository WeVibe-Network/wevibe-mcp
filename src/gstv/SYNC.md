# GSTV sync rule

`src/gstv/**` is PRODUCT machinery (WP-DESIGN-SPEC §2.7/§8.12; DECISIONS §24
D-GSTV-CHAIN-PRIMITIVE / D-GSTV-BOUNDARY-STAMP / D-GSTV-PREDICATE-DEFAULT).

Source of truth = the canonical repo `wevibe-mcp`. The bench clone
(`wevibe-bench/scaffold/wevibe-mcp-clone`) carries byte-identical copies synced
FROM canonical. Edit canonical FIRST, then re-sync the clone (copy the module
and verify sha256). Never edit the clone's copies directly.
