# Decoder Architecture (v2.0.0 - decode ladder era)

How an unknown scanned code becomes (or does not become) a counted product. Deterministic code owns
truth; AI only suggests; counting happens only through human approval or the app-verified auto-count
gate. Quick map for a new session or developer. (v1.0.0 described the concurrent two-provider
orchestrator; v2 replaced it with the cost-ordered ladder below. Sections 3-9 carry over.)

**Doc boundary:** `docs/ARCHITECTURE.md` section 3 owns file/line wiring (what imports what, where a
symbol lives); THIS doc owns behavioral semantics (what the ladder decides, in what order, and why);
`CLAUDE.md` holds only the at-a-glance summary and links here for detail. If the three ever disagree,
fix the stale one rather than trusting it.

## 1. Deterministic-first resolution
- Known scans are instant and deterministic. The resolver (`src/services/resolver.ts`) returns `known`
  ONLY from an APPROVED alias (`alias.approved === true`) or a VERIFIED product (`product.verified`).
- AI is NEVER called for a known match. Different codes can map to one product via aliases; duplicate
  scans increment quantity, never create duplicate product rows.
- Unknown / vendor-label / conflicting codes route to the Needs Review queue, never a guess.

## 2. Decode ladder (unknown codes only) - `src/server/decode/pipeline.ts` orchestrates, `src/server/upc/ladder.ts` drives rungs
- The REAL decode orchestrator is `runDecodePipeline` in `src/server/decode/pipeline.ts` (fronted by
  `app/api/ai-lookup/route.ts`): it owns the overall stage sequence, deadlines, daily-cap gating, and
  which rung SET runs next. `src/server/upc/ladder.ts`'s `runLadder` is the RUNG DRIVER it calls
  repeatedly - once per stage (free rungs, then Go-UPC-only, then FetchV2, then GPT) - to walk a given
  list of rungs and stop at the first settled one. Do not treat `ladder.ts` as the top-level
  orchestrator: it has no knowledge of the free/paid staging or the daily cap; that logic lives in
  `pipeline.ts`. `src/services/ai/decodeOrchestrator.ts` is a different, DEPRECATED module (types only)
  and must not be extended.
- An unknown code walks ORDERED RUNGS, cheapest first; the FIRST settled rung (verified OR a
  suggestion) STOPS the ladder, so a later rung is never paid for when an earlier one answered:
  0. Local tire corpus / decode cache (Turso + local SQLite) - free, ~143ms.
  1. `goupc` - Go-UPC API; the rung is added ONLY for a real GTIN shape with a valid GS1 check digit
     (the gate lives at the caller, `buildLadderRungs`, so `runLadder` stays shape-agnostic).
  2. `fetchv2` - trusted-door open-web discovery.
  3. `gpt` - GPT-5.5 ladder end.
- Every rung that ran records its reason (miss / unavailable / transient); the route surfaces the
  full reason chain, so a Needs Review row always says honestly why each rung failed.
- GEMINI IS NOT USED FOR DECODE (grounding bills every executed search with no cap control; see
  LESSONS_LEARNED L11). Settings labels it "not used for decode".
- The daily AI cap charges ONLY paid rungs, exactly once, inside the rung, after the free
  corpus/cache peek (L12). Corpus/cache hits are free and never consume cap slots.
- The model's own `exactCodeEvidence` claim is never trusted. The app independently verifies the exact
  code in real evidence via `EvidenceVerifier` (strength ladder: none < url_only < snippet <
  grounding_chunk < fetched_source; url_only trusted only from an allowlisted host).
- `CrossCheckEngine` still compares sources structurally when more than one answered:
  agree | conflict | single_provider | weak.

## 3. Verified-only early exit (W1)
- `runDecode` early-exits ONLY when `decideDecode` returns `verified`. A usable product NAME alone is
  not enough; unverified / suggested / conflict keep running until a verified hit or the budget.
- `decideDecode` returns `verified` only for a public barcode (upc_a / ean_13 / gtin_14) with strong
  app-verified evidence, provider agreement (or single provider), non-empty identity, and confidence
  at or above the threshold. Otherwise suggested / needs_review; provider disagreement is conflict.
- A "Verified AI Decode" AUTO-COUNTS by default: the master gate `autoAddDecodedProducts` defaults
  true (scanStore.ts) and requires status verified + app-verified exact code + confidence >= 0.8 +
  (for tires) full specs + a public barcode shape + no firewall/brand-prefix conflict. Set it false
  for manual-review-everything mode. High-trust SUGGESTIONS (>= 0.8 or app-verified exact) auto-apply
  to the counted row; lower-confidence identities display with a "(suggested)" tag and stay
  review-first.
- Identity merge is SIZE-AWARE (`src/services/catalog/identityMerge.ts`): tire size is derived from
  `specsShort`/`specsFull` (corpus names are slugs that never carry sizes), so same-model-DIFFERENT-SIZE
  decodes mint distinct products instead of collapsing into review suggestions.
- Brand-prefix sanity uses evidenced corporate families (`brandFamilies.ts`): Michelin owns
  BFGoodrich/Uniroyal-NA, Continental owns General, Goodyear owns Cooper - a company's own brands on a
  shared GS1 prefix never false-conflict, while unrelated brands still block the verify path.

## 4. Token-waste cap (W4)
- `MAX_AI_SNIPPET_CHARS = 1500` (`snippetCap.ts`) caps each AI-bound snippet / grounding chunk in
  `normalizeResult`. The full fetched page text used by `verifyEvidence` for exact-code matching is a
  separate `ProviderEvidence.fetchedSourceText` field and is NEVER truncated, so a code appearing deep
  in a page still verifies.

## 5. GS1 region hint (W3) - NON-AUTHORITATIVE
- For public barcodes the route computes `formatGs1Hint(code, codeType)` and passes it as
  `AiLookupRequest.gs1RegionHint`. `buildLookupPrompt` injects it into the TRUSTED context only.
- It is a hint to help the AI search, NOT product identity. It never overrides exact-code evidence,
  alias approval, verified-source agreement, resolver truth, or auto-count rules. It is never placed in
  untrusted scraped text. See docs/GS1_COUNTRY_REFERENCE.md.

## 5b. Business scan-context conflict firewall (Phase 8) - exact-code evidence is necessary, not sufficient
- A public UPC source can be WRONG. Proven live: go-upc.com maps tire UPC `745125495781` to an
  aluminum-rivet kit, and Gemini Pro repeated it because the source itself is poisoned. Model strength
  cannot fix poisoned exact-code evidence.
- So exact-code evidence is necessary but NOT sufficient. Before auto-counting, the decode must also
  agree with the business scan context and learned brand hints (`scanContextFirewall.ts`):
  - `decodeBarcodeStructure(code, codeType)` (`barcodeAnatomy.ts`) gives NON-AUTHORITATIVE structure:
    GS1 numbering-authority region, mod-10 check-digit validity, a CANDIDATE company prefix (the real
    GS1 company prefix is variable-length), and the item reference.
  - `deriveBrandPrefixHints(products, aliases)` learns brand <- candidate-prefix ONLY from
    APPROVED aliases of branded products in the active business catalog. A prefix mapped to more than
    one brand is ambiguous and never used. Never learns from AI/Needs-Review/unapproved/scraped data.
  - `detectScanContextConflict(...)` returns:
    - `category_context_conflict` when the scan context is `tire` and the decoded product is clearly
      non-tire (the poisoned-source guard).
    - `brand_prefix_conflict` when an unambiguous learned brand for the code's candidate prefix is
      contradicted by the decoded brand.
- A conflict BLOCKS auto-count and routes to Needs Review with a safe, product-facing reason
  ("category conflict" / "brand conflict"). It never deletes evidence. The scan context is a setting
  (`scanContext`, default `any` to preserve the multi-trade product; set `tire` to enable the firewall).
- Internal barcode anatomy / conflict diagnostics are platformOwner-only; customers never see them.
- Phase 8B: the scan context (tire) and the unambiguous learned brand-prefix hint are also injected into
  the AI prompt's trusted context as ADVISORY, non-authoritative hints (the prompt is told the brand-prefix
  hint is not identity truth, and to reject non-tire results in tire context). Hints only help the model
  search; the firewall above remains the hard auto-count gate.

## 6. Needs Review human approval (W2)
- A human resolves an unknown by linking to an existing product or creating a new one. Resolution sets
  the alias `approved: true` (source `human_review`); only then does the code count and become
  deterministic on the next scan.
- Discovered identifiers (extra codes the decode surfaced) are presented for selection and approved as
  aliases onto the chosen product. They are SUGGESTIONS until the human clicks approve - never auto-saved.

## 7. Duplicate and conflict handling
- Duplicate prevention: an alias is not created twice for the same clean code + product (idempotent).
- Cross-product conflict: a code already an approved alias of a DIFFERENT product is surfaced as a
  conflict and never silently overwritten.
- Human-mistake guard: a high-risk link (e.g. a Falken part number to Camel) is blocked until the
  owner explicitly overrides.

## 8. Idempotent sync + offline tolerance
- Every event carries a stable id + idempotency key generated once; retries never double-count or
  duplicate aliases. Failed sync keeps scans locally as pending and retries on reconnect.

## 9. Customer data firewall
- Customer roles must NEVER see raw/internal decode diagnostics: barcode / raw code, cleanCode,
  matchType, provider details, AI details, source evidence, lookup traces, or GS1 diagnostics.
- These are platformOwner-only in the UI (gated by `isPlatform`), enforced by the SecurityLeakBot and
  ExportBot (`npm run qa:bots:security`).

## Test safety
- Automated tests never call live providers. Unit tests mock engines/fetch; e2e mocks `/api/ai-lookup`;
  the Playwright bot webServer runs with `IS_E2E=1` (mock-only). No live tokens in CI.
