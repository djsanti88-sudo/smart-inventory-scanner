# Decoder Architecture (v1.0.0)

How an unknown scanned code becomes (or does not become) a counted product. Deterministic code owns
truth; AI only suggests, and only a human approves. Quick map for a new session or developer.

## 1. Deterministic-first resolution
- Known scans are instant and deterministic. The resolver (`src/services/resolver.ts`) returns `known`
  ONLY from an APPROVED alias (`alias.approved === true`) or a VERIFIED product (`product.verified`).
- AI is NEVER called for a known match. Different codes can map to one product via aliases; duplicate
  scans increment quantity, never create duplicate product rows.
- Unknown / vendor-label / conflicting codes route to the Needs Review queue, never a guess.

## 2. Live AI decode (unknown codes only)
- Up to two fast providers (Gemini flash + OpenAI mini) run concurrently WITH a page-fetch enrichment
  under one hard time budget (`decodeOrchestrator.ts`). On timeout, all work is aborted and the code
  routes to Needs Review (never a partial product).
- The model's own `exactCodeEvidence` claim is never trusted. The app independently verifies the exact
  code in real evidence via `EvidenceVerifier` (strength ladder: none < url_only < snippet <
  grounding_chunk < fetched_source; url_only trusted only from an allowlisted host).
- `CrossCheckEngine` compares two providers structurally: agree | conflict | single_provider | weak.

## 3. Verified-only early exit (W1)
- `runDecode` early-exits ONLY when `decideDecode` returns `verified`. A usable product NAME alone is
  not enough; unverified / suggested / conflict keep running until a verified hit or the budget.
- `decideDecode` returns `verified` only for a public barcode (upc_a / ean_13 / gtin_14) with strong
  app-verified evidence, provider agreement (or single provider), non-empty identity, and confidence
  at or above the threshold. Otherwise suggested / needs_review; provider disagreement is conflict.
- A "Verified AI Decode" is still a SUGGESTION; it auto-counts only if the owner opts into
  `autoAcceptVerifiedDecodes` (default OFF) and the evidence-scoring gate (`planAutoVerify`) passes.

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
