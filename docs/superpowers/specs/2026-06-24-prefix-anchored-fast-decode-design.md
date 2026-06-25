# Prefix-Anchored Fast Decode (design spec)

Date: 2026-06-24
Status: APPROVED design, pending spec review -> implementation plan
Owner: djsanti88@gmail.com
Scope: tire decode only (current focus)

## 1. Goal

Make the AI decode of an unknown tire (one NOT already in the deterministic database) both **fast**
(target p50 ~1-3s, no 35s outliers) and **verified** (auto-counts without a human), so that almost
nothing goes to needs-review unless the product is genuinely unfindable online. Do this without
weakening the project's hard safety rule: a wrong product identity is failure; the false-auto-count
rate must stay 0.

This is the AI-only fast path for cache/DB misses. It complements (does not replace) the deterministic
database the owner is building toward 30k known tires.

## 2. Why it is slow / always "suggested" today (verified in code)

- **Slow:** there is no cheap barcode-DB fast path, so any tire not in the deterministic corpus falls
  to a synchronous deep fallback that runs grounded providers out to a ~10s per-call timeout
  (`src/services/ai/decodeOrchestrator.ts:99` default `providerTimeoutMs ?? 10_000`), and up to a 30s
  whole-fallback ceiling (`FALLBACK_HARD_CAP_MS`, `src/app/api/ai-lookup/route.ts:23,321`) when the
  Firecrawl web race also misses.
- **Always "suggested":** `decideDecode` (`src/services/ai/decode.ts:75-196`) only returns "verified"
  via three paths (`canVerify`, `tireCorroborated`, `pageFetchModelAgreement`), and ALL require
  `strong === true` = the exact scanned code confirmed in `snippet | grounding_chunk | fetched_source`
  (`src/services/ai/evidenceVerifier.ts:139-141`). Barcode-lookup hosts are distrusted; only
  `TRUSTED_HOSTS = gs1.org, gtin.info` make `url_only` strong (`route.ts:57`). The fast grounded
  providers time out before citing app-verifiable evidence, so `strong` is false -> `suggested` with
  `exactCodeEvidenceVerifiedByApp: false` (`decode.ts:172-183`).

## 3. Decisions locked in brainstorming

- **Verification model: prefix-anchored.** Brand comes deterministically from the GS1 company prefix
  (first 6-8 digits) via the tire prefix table; the AI never guesses the brand. The AI only supplies
  size + model.
- **Counting identity: brand + size + model name.** Two tires are the same product when brand, size,
  and model line match. Load index and speed rating are optional enrichment, NOT required to count.

## 4. Architecture: the prefix-anchored fast path

Small, independently testable units:

1. **PrefixBrandResolver** `(code) -> { brand, prefixFamily, isTirePrefix } | null`
   Deterministic lookup of the GS1 prefix against the tire prefix table
   (`tire_prefixes_FINAL.csv` -> generated index under `src/server/tire-knowledge/`). Pure, $0, no AI.
   Reuses the existing prefix-family logic (`isBrandInPrefixFamily` in `decode.ts`).

2. **GroundedSpecFinder** `(code, anchorBrand) -> SpecResult | null`
   ONE fast grounded call (Gemini Flash + Google Search grounding, the configured mini model) with a
   hard ~3s timeout. Structured-JSON output:
   `{ brand, model, size, loadIndex?, speedRating?, sourceUrl, exactCodeGrounded: boolean }`.
   Prompt anchors on the known brand ("UPC {code} is a {anchorBrand} tire; return its model and size
   and whether the cited source shows this exact code"). Because brand is given, the model spends its
   budget on model+size, not brand discovery, so it grounds within the timeout.

3. **CountableTireIdentity** `(spec) -> boolean`
   Replaces the strict `hasRequiredTireSpecs` (size+load+speed) for the COUNT decision with
   brand + size + model present. Load/speed remain captured when available (enrichment), not gating.

4. **VerifyDecision** (extend `decideDecode`)
   Returns **verified + auto-count** when ALL hold:
   - PrefixBrandResolver returned a brand and `isTirePrefix` is true, AND
   - GroundedSpecFinder returned `exactCodeGrounded === true` (strong evidence), AND
   - `spec.brand` matches the prefix brand (`isBrandInPrefixFamily`, strong), AND
   - CountableTireIdentity(spec) is true (brand + size + model).
   Returns **conflict -> review** when `spec.brand` does not match the prefix brand, or the prefix is
   not a tire prefix, or the grounded source is the poison/near-code class. Returns **suggested ->
   review** when grounded but missing model or size. The existing poison probe (745125495781) must
   land in review, never counted.

5. **HotPathOrchestration** (in the `/api/ai-lookup` decode route)
   prefix lookup -> grounded call (3s) -> VerifyDecision -> return. NO synchronous Firecrawl/deep
   fallback on the hot path. If the prefix is unknown, route to the unknown-prefix policy (section 5).

6. **BackgroundEnrichment** (on a miss)
   When the hot path returns review, enqueue a deeper async decode (the existing Firecrawl/deep path)
   that attaches a suggestion to the Needs-Review item, so the human sees a near-complete answer
   instead of a blank. Runs off the hot path; the scan never waits on it. Local/single-tenant: a
   deferred in-process task is acceptable for v1; document the upgrade path to a real queue.

7. **Learning** (on verified)
   Write the code -> product as an approved alias (instant next time) and, when a new but confident
   prefix-brand pairing is seen, propose a prefix-table addition. This grows coverage toward the 30k DB
   and reduces future AI calls.

8. **AutoCountGate alignment** (`src/stores/scanStore.ts` ~1612-1618)
   Today auto-count also requires `confidence >= 0.9` (stricter than the 0.85 decode threshold). Ensure
   a prefix-anchored + grounded + identity-complete decode satisfies the gate (the prefix anchor makes
   the brand confidence effectively 1.0); confirm the gate accepts the new "verified" without lowering
   safety for non-anchored paths.

## 5. Unknown-prefix policy

If PrefixBrandResolver returns null (prefix not in the table):
- Run GroundedSpecFinder WITHOUT a brand anchor, and require a stricter bar to auto-count: the model
  must return brand + size + model AND `exactCodeGrounded`, AND a second confirmation (a second fast
  model agreeing on brand, OR a fetched_source page) - i.e. fall back to the existing two-AI-agreement
  verify path. Otherwise -> review. This keeps wrong-counts near zero for the long tail.
- Every confident unknown-prefix decode proposes a new prefix-table row (learning).

## 6. Safety invariants (must not regress)

- False-auto-count rate stays 0 on the eval dataset (`src/eval/dataset.ts`, the poison) and on the
  weekly tire scan poison probe.
- Brand is never AI-guessed on the anchored path; brand-vs-prefix mismatch -> conflict -> review.
- Non-tire prefix or the poison/near-code class -> review.
- The change is gated by the Human Bot Proof Gate (`docs/REVISION_GATE.md`) before merge.

## 7. Speed and cost targets

- p50 hot-path latency <= ~3s (from ~10s); no synchronous path exceeds the hot-path timeout (~3s) plus
  the prefix lookup; eliminate the 35s class from the hot path.
- One grounded mini-model call per unknown scan; Firecrawl/deep only in the background. Cost per unknown
  scan well under the current run (today's run was $0.036 for 16 codes with Firecrawl in the hot path).
- Known/cached/alias tires: $0, instant.

## 8. Measurement (already built)

`scripts/weekly-tire-scan.ts` + `scan-health.json` is the regression monitor. After this change, on the
15 fresh-tire sample expect: decode-success (verified) rate rises from 0% toward >= 70% of findable
tires; p50 latency drops to ~1-3s; false-auto-count stays 0; cost per run drops. The weekly report shows
the trend week over week.

## 9. Acceptance criteria

1. A real tire UPC with a known prefix and a findable online product page auto-verifies (status
   "verified", auto-counts) with product = brand + size + model, in <= ~3s.
2. The poison code and any brand-vs-prefix mismatch route to review; false-auto-count = 0 on the eval
   dataset and the weekly poison probe.
3. Unknown-prefix codes never auto-count without the stricter two-confirmation path; otherwise review.
4. Hot path issues no synchronous Firecrawl/deep call; misses return to review immediately and a
   background job attaches a suggestion.
5. Verified decodes write an alias (instant on re-scan) and propose prefix-table growth.
6. The weekly tire scan shows verified rate up and p50 latency down versus the 2026-06-24 baseline
   (0% verified, p50 ~10s), with false-auto-count still 0.
7. Existing decode/resolver unit + eval tests pass; the Human Bot Proof Gate passes before merge.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prefix table coverage gaps | Unknown-prefix stricter path + review; learning proposes new rows |
| Grounded call still misses model/size for poorly-listed tires | Returns to review (the owner's bar); background enrichment attaches a suggestion |
| Relaxing specs (size+model, not load+speed) merges variants | Acceptable per the counting-identity decision; load/speed still captured when present |
| Changing the verify gate weakens safety | Eval poison + weekly poison probe + Human Bot Proof Gate as hard regression guards; anchored path cannot guess brand |
| Background job infra | v1 deferred in-process task; document upgrade to a real queue for multi-tenant |
| Auto-count 0.9 confidence gate blocks anchored decodes | Verify the gate accepts prefix-anchored verified results; do not lower it for non-anchored paths |

## 11. Out of scope

- Non-tire trades (this spec is tire-only for now).
- Bulk 30k DB ingestion (separate effort; this is the AI path for misses).
- The platform-owner UX polish item (separate, low priority).
- Multi-tenant background-queue infrastructure (documented as a future upgrade).
