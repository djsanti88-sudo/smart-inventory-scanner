# Plan C — Verified / Suggested model + prefix as guidance + never-empty floor

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Two visible states only — **Verified** (app-confirmed) and **Suggested** (everything else) — with "Needs Review" retired as a WALL; the brand-prefix firewall demoted from a hard block to advisory guidance; and a prefix-based floor so no counted row is ever empty ("Brand / product unconfirmed").

**Architecture:** Plan A already made every scan count and keeps "review" items counted, so `needs_review`/`conflict` are already non-blocking LABELS, not gates (recon-confirmed). Plan C therefore is: (1) a presentational relabel collapsing the weak states into "Suggested"; (2) demoting the brand-prefix conflict at 3 load-bearing sites so grounding/corpus evidence wins over a prefix mismatch (KEEP the category/poison guard); (3) a prefix→company floor in the provisional branch. This is a stack on Plan B (branch off `fix/corpus-lookup-vercel`).

**Tech Stack:** TypeScript, Zustand store, React components, Vitest, Playwright.

## Global Constraints

- Do NOT re-do Plan A: counting stays as-is; every scan still counts. This plan changes LABELS + the prefix TRUST behavior + the floor name — not the counting.
- **Verified** = app-confirmed exact evidence (corpus hit, or grounding-confirmed exact code). **Suggested** = everything weaker, including prefix-floor rows. No third "wall" state.
- Brand-prefix conflict is ADVISORY only — it must NEVER block a verify/count or route to review by itself. The CATEGORY / poison guard (wrong product-type, e.g. a tire UPC mislabeled as a dress) STAYS a hard guard. (Owner: prefixes are many-to-one; hard prefix blocks cause false rejects; grounding beats the prefix.)
- Prefix floor states the BRAND with confidence and flags only the PRODUCT as unconfirmed ("Michelin / product unconfirmed"); never fabricates a specific product; prefix-only is never "Verified".
- No em/en dashes in user copy. Preview deploy only; production needs explicit owner sign-off.
- Verification Gate (inherited): each task proven (unit + where user-visible, Playwright) before advancing; loop-until-fixed via systematic-debugging; never advance while red.

## File Structure
- Modify: `src/components/badges.tsx`, `src/components/NeedsReviewTable.tsx`, `src/components/LiveScanFeed.tsx` — collapse weak decode states into "Suggested"; relabel the review surface (it is a soft "Suggested items" list, not a wall).
- Modify: `src/app/api/ai-lookup/route.ts` (~L79), `src/services/ai/decode.ts`, `src/services/catalog/scanContextFirewall.ts` (~L74-88) — demote `prefixBrandConflict` / `brandPrefixConflict` / the `brand_prefix_conflict` arm to advisory (never blocks verify/count); keep the category/poison arm blocking.
- Modify: `src/stores/scanStore.ts` (~L1876-1959) — prefix floor: brand + "product unconfirmed" via `decodeBarcodeStructure().candidateCompanyPrefix` + the general prefix->company lookup (`lookupPrefix().dominant.name`).
- Tests: update label-based unit/E2E assertions; add prefix-advisory tests; add prefix-floor tests.

---

### Task 1: Relabel weak states to "Suggested" (presentational)

**Files:** `src/components/badges.tsx`, `src/components/NeedsReviewTable.tsx`, `src/components/LiveScanFeed.tsx`; label tests.

- [ ] **Step 1 (investigate + failing test):** Read `badges.tsx` DecodeBadge + `NeedsReviewTable.tsx` DecodeBadge (recon says the latter already collapses to ~3 states). Write/adjust a component test asserting that a `decodeStatus` of `needs_review` and of `conflict` both render the user-facing label **"Suggested"** (not "Needs review"/"Conflict"), and `verified` renders "Verified". Run → FAIL.
- [ ] **Step 2 (implement):** In the badge components, map `needs_review` and `conflict` (and any terminal `decoding` that never resolved) to the single "Suggested" label/style; keep `verified` as "Verified". Relabel the review surface heading/copy from "Needs Review" to a soft "Suggested items (confirm if you like)" framing (exact copy: no em dashes). Do NOT change the underlying `decodeStatus` enum values or any counting/gating logic — only the rendered label/style.
- [ ] **Step 3:** Run the component test → PASS. Update any existing unit/E2E tests that asserted the old labels ("Needs review", "Conflict", "Verified AI Decode", etc.) to the new copy — grep `Needs review|Conflict|needs_review` in `e2e/` and `src/components/*.test.tsx`. Do not weaken assertions, only relabel.
- [ ] **Step 4:** `npm run test` (0 failures), `npx tsc --noEmit` clean. Commit.

### Task 2: Demote the brand-prefix firewall to advisory (behavioral)

**Files:** `src/app/api/ai-lookup/route.ts` (~L79), `src/services/ai/decode.ts`, `src/services/catalog/scanContextFirewall.ts` (~L74-88); tests.

- [ ] **Step 1 (failing test):** Write tests capturing the target: (a) a decode whose ONLY firewall issue is a brand-prefix mismatch, WITH strong app-verified exact-code evidence, now returns **verified** (or provisionally counts as before) instead of being blocked/routed to review; (b) a CATEGORY/poison conflict (wrong product type) STILL blocks (must stay red-guarded). Put these where the current firewall is unit-tested (grep existing `scanContextFirewall`/`decode` tests to mirror). Run → the (a) case FAILS today (prefix conflict blocks).
- [ ] **Step 2 (implement):** At the 3 sites, make the brand-prefix arm advisory:
  - `route.ts:~79`: stop hard-OR-ing `prefixBrandConflict` into the blocking condition; instead pass it through as an advisory flag (still reported, never blocks).
  - `decode.ts` verify paths: stop gating the verify decision on `brandPrefixConflict` (it becomes a non-blocking annotation).
  - `scanContextFirewall.ts:~74-88`: demote the `brand_prefix_conflict` arm so `detectScanContextConflict` (which feeds the store `evidenceGatePassed`) no longer blocks on prefix alone.
  - KEEP the category/poison arm exactly as-is (it must still block a wrong-category identity).
  Surface the demoted prefix mismatch as a soft flag on the row (advisory), not a block.
- [ ] **Step 3:** Run the tests → both PASS (prefix-only now verifies; category still blocks). `npm run test` (0 failures — reconcile any test that asserted prefix-conflict-blocks as the OLD behavior, honestly). `npx tsc --noEmit`. Commit.

### Task 3: Prefix floor — never an empty row

**Files:** `src/stores/scanStore.ts` (~L1876-1959, the provisional/placeholder naming in the decode handler and in `ensureProvisionalCount`); tests. Reuse the general prefix->company lookup (recon: `decodeBarcodeStructure().candidateCompanyPrefix` + `lookupPrefix().dominant.name`, client-safe, general non-tire).

- [ ] **Step 1 (failing test):** Write a store test: an unresolved code whose GS1 prefix maps to a known company, with NO grounding/corpus hit, produces a provisional row named "<Brand> / product unconfirmed" (Suggested, verified:false), NOT the bare "Unidentified item (barcode X)". A code whose prefix maps to nothing still falls back to "Unidentified item (barcode X)". Run → FAIL.
- [ ] **Step 2 (implement):** In the placeholder-naming path(s) (the DECODE-EVERYTHING provisional block + `ensureProvisionalCount`'s `fbName`), before defaulting to "Unidentified item", resolve the prefix->company; if found, name it "<Brand> / product unconfirmed" (brand stated, product unconfirmed) and set brand on the provisional product; keep verified:false, provisional:true. (Item-reference-based specific product lookup is OPTIONAL/out-of-scope for v1 — the floor is brand + unconfirmed; note this in the plan.) Never mark prefix-only as verified.
- [ ] **Step 3:** Run tests → PASS. `npm run test` (0 failures), `npx tsc --noEmit`. Commit.

### Task 4: Gate + preview proof

- [ ] **Step 1:** Full `npm run test` (0 failures), `npx tsc --noEmit`, `npm run build` (success).
- [ ] **Step 2:** Playwright browser proof (reuse `e2e/count-always.spec.ts` patterns): scan an unknown code, confirm the feed shows the "Suggested" label (not "Needs review") and it is counted; screenshot to `e2e/proof/`. Loop until green.
- [ ] **Step 3:** Commit. (Controller pushes the branch for the cumulative preview + verifies labels/prefix behavior on the live preview.)

---

## Self-Review
- Two-state relabel → Task 1. Prefix demotion (keep poison guard) → Task 2. Prefix floor → Task 3. Proof → Task 4.
- Already done by Plan A (do NOT redo): counting, provisional rows, enrich/dedup, verified-corpus auto-count (`needsHumanReview` inert).
- Out of scope (documented): item-reference-based specific-product lookup within a brand (floor is brand + "product unconfirmed" for v1); the retail-vs-tire `needsHumanReview` inconsistency (cosmetic, optional).
- Risk: Task 2 changes the verify trust boundary (owner-approved: grounding beats prefix). The category/poison guard MUST remain blocking — Task 2 Step 1 test (b) enforces this; the final review must confirm it.
