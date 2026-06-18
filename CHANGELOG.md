# Changelog

Notable changes to the Smart Inventory Scanner decode pipeline, grouped by the Architecture Version
stamped on the work. Git history is the source of truth for timing.

## v1.0.0 - Decoder hardening

Local-only work on branch `decoder-hardening-v1-local`. NOT deployed. Verified locally each phase
(vitest, tsc, eslint, next build, and the qa:bots security/data/tire/ux suites).

### Phase 2 - GS1 region config (commit 29fc308)
- Added `src/services/gs1Prefixes.ts`: a VERIFIED GS1 prefix to numbering-authority region table with
  `deriveGs1RegionHint(code, codeType)` and `formatGs1Hint(...)`. Public barcodes only (UPC-A / EAN-13
  / GTIN-14); returns null for SKUs, vendor labels, messy/empty, and unmapped or uncertain prefixes.
- Exposes the mandated non-authoritative disclaimer `GS1_HINT_DISCLAIMER`.
- No fabricated brand or manufacturer prefix tables (see docs/GS1_COUNTRY_REFERENCE.md).

### Phase 3 - W1 + W4 decode hardening (commit 29fc308)
- W1: removed the "trust-the-AI fast path" early-exit in `decodeOrchestrator.ts`. An unknown code now
  early-exits ONLY on an app-VERIFIED decision (exact code in strong evidence + agreement or single
  provider on a public barcode); otherwise it runs to the time budget. A usable product name alone
  never stops the wait.
- W4: added `src/services/ai/snippetCap.ts` (`MAX_AI_SNIPPET_CHARS = 1500`). `normalizeResult` caps
  each AI-bound source snippet / grounding chunk. The full fetched page text used by the
  EvidenceVerifier for exact-code matching is a separate field and is NEVER truncated.

### Phase 4 - W2 Needs Review discovered-alias approval (commit 1b091c1)
- Discovered identifiers (extra UPC/EAN/GTIN/SKU/codes surfaced by a decode) can be human-approved in
  Needs Review onto a NEW or an EXISTING product.
- Approved aliases are `approved: true`, `source: "human_review"`. Deduped per product (idempotent).
- A code already an approved alias of a DIFFERENT product is a surfaced conflict (`lastAliasConflicts`)
  and is NEVER silently overwritten.
- Discovered identifiers stay platformOwner-only and never auto-save before explicit human approval.

### Phase 5 - W3 GS1 wiring + W5 docs (this commit)
- W3: the AI-lookup route computes `formatGs1Hint(code, codeType)` and passes it as
  `AiLookupRequest.gs1RegionHint`. `buildLookupPrompt` injects it into the TRUSTED (app-derived) prompt
  context only, with the disclaimer. It is never placed in untrusted scraped text and never changes
  resolver truth, alias approval, auto-count, or evidence thresholds.
- W3 UI: no customer-facing or platformOwner UI label added. The GS1 hint is not returned in the decode
  response, so a UI label would be broad churn; the hint is prompt-only in this version.
- W5: added CHANGELOG.md, docs/DECODER_ARCHITECTURE.md, docs/GS1_COUNTRY_REFERENCE.md.
