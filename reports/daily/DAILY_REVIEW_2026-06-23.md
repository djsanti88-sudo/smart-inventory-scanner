# Daily Comprehensive Review — Smart Inventory Scanner — 2026-06-23

Branch: `decoder-hardening-v1-local` · Dir: `C:\Users\djsan\inventory` · Mode: **read-only audit**
Reviewer: lead QA + product reviewer (4 parallel code-dive sub-agents + status/report reading).
Nothing edited, committed, pushed, merged, or deployed. No live providers called.

## Run limitation (honest)
The inventory dev server was **not running** this session — `localhost:3000` showed an error page and
`localhost:3100` was serving the *other* project (Sharpenly). The sandbox is a separate Linux box and cannot
host/reach the Windows dev server, so **no fresh screenshots and no new live scans were possible**. Live
accuracy numbers below are from the on-disk **06-22 run** (`coordination/AUTOCOUNT_LIVE_STATUS.json`) and the
existing `e2e/proof/` artifacts. The vitest suite also can't execute in this Linux workspace (Windows-built
`node_modules`, native rolldown binding mismatch) — last green local run was **663 passed / 0 failed (06-22)**.
**What still needs live verification is listed per area.**

---

## Area grades (at a glance)

| Area | Grade | Headline |
|------|-------|----------|
| A. Correctness & safety | **PASS** | Poison blocked, auto-count gate intact, idempotency/dedup double-walled. 2 hardening nits. |
| B. Ease-of-use (65+) | **NEEDS WORK** | Jargon badges + 12px text + low-contrast grays leak to the customer; dark-mode trap. |
| C. Design / IA | **NEEDS WORK** | Zero responsive breakpoints (critical for a phone scanner); orphaned `/business`; Settings wall. |
| C2. Export | **PASS** | All four formats (CSV/XLSX/PDF/interactive-HTML) real + sanitized from one source. Labels jargon. |
| D. Security / privacy | **NEEDS WORK** | 3 AI-internal fields (confidence, autoVerifyScore, verifiedFacts) render to the customer on `/review`. |
| E. Performance & health | **NOT VERIFIED THIS RUN** | App down; tire decode p95 ~10s on 06-22; no console check possible. |

---

## A. Correctness & safety — PASS
All five safety invariants hold structurally (verified by code read; corroborated by 06-22 test run).

- **Poison `745125495781` → Needs Review, never auto-counts.** No single bypassable "poison list" — the block
  is structural across 4 layers: evidence (`evidenceVerifier.ts:17-47`, exact-code boundary + invalidation
  regex; near-match `7451254957818` never satisfies the scanned code), firewall
  (`scanContextFirewall.ts:18-19,72`), decode (`decode.ts:119-146` requires `isTireContext`), store gate
  (`scanStore.ts:1612-1618`). 06-22 live: poison → needs_review, 0% auto-count.
- **Auto-count only via real corroboration, no loosened threshold.** `decideDecode` (`decode.ts:75-196`)
  returns `verified` only via two-AI agreement, deterministic STRONG-tier prefix family, or
  page-fetch+model agreement — each requiring app-verified strong evidence + full tire specs + a hard
  `confidence >= 0.9` floor at the store gate (`scanStore.ts:1615`). Provider self-claimed `exactCodeEvidence`
  is **never** trusted — only `EvidenceVerifier` output is (`decodeOrchestrator.ts:132-133`). `url_only`
  untrusted unless host-allowlisted (`evidenceVerifier.ts:90-103`). `autoAcceptVerifiedDecodes` confirmed
  **dead/unused** (does not gate counting).
- **Resolver trust intact.** `resolver.ts` / `aliasMatcher.ts` return `known` only from an approved alias
  (`approved===true`) or verified product (`verified===true`); AI = suggestion only; vendor/FNSKU → Needs
  Review; conflict (one code → many products) → Needs Review.
- **Idempotency / side-door.** `idempotencyKey` built once at scan time and reused on retry (no regeneration
  in `syncPending`); apply-once at both mockDb and InventoryCount layers; never a duplicate count row.
- **No duplicate products.** create-new dedup funnels through one resolver-consistent guard
  (`scanStore.ts:1749-1800`) incl. barcode-in-name token match (P2 fix for the 235× "Manstel rivet kit" bug);
  `>1 match → conflict`, never a guess.

**Hardening nits (low priority, not failures):**
1. `evidenceVerifier.ts:132-136` `strongestEvidence` ranks by strength, not `verified` — safe today because
   `isStrongEvidence` separately requires `verified`, but a latent footgun. Tie-break on `verified` first.
2. `scanContextFirewall.ts:18-19` `NON_TIRE_RE` keyword list is the weakest firewall link; a poisoned
   non-tire product with none of the listed nouns classifies `unknown`. Defense-in-depth only (corroboration
   gate still protects the count). Expand the noun list periodically.

**Needs live verification:** re-run the vitest + qa-bots suite on Windows to reconfirm the 663-green baseline
before any handoff (couldn't execute in this Linux workspace).

---

## B. Ease-of-use for a 65+ / low-vision / non-technical user — NEEDS WORK
The role-split architecture already hides most jargon, every destructive action confirms (often with a backup +
Undo — excellent), and the scan-success panel is a model low-vision confirmation. Gaps are on the *secondary*
surfaces (badges, table metadata, settings):

- **Jargon badges leak to the customer.** `badges.tsx:8-9` ("Decoding with AI…", "Verified AI Decode") and
  `:55-59` SyncBadge ("Synced", "Sync error") render **unguarded** in the customer scan feed
  (`LiveScanFeed.tsx:69-81`). Customer sees "AI", "Decode", "Sync". (NeedsReviewTable and SyncStatusBar were
  de-jargoned; these in-table chips were missed.)
- **12px text on customer content.** `LiveScanFeed.tsx:53,57,64,75`; `FinalCountTable.tsx:116,141`;
  `products/page.tsx:74`; `badges.tsx:17,45,61,84` (`text-sm`). The failure *reason* a customer must read is
  `text-xs` gray.
- **Low contrast.** `text-zinc-400` on white (~2.8:1, fails AA) at `FinalCountTable.tsx:183,187`,
  `business/page.tsx:69,112`, `CleanupRecommendations.tsx:169,183,187`; pervasive `text-zinc-500` at 12px.
- **Dark-mode trap.** `globals.css:15-20` ships a `prefers-color-scheme: dark` theme but every component
  hardcodes `bg-white`/`text-zinc-*` → on a dark-mode device the user gets clashing/near-invisible text.
  Either delete the block or make components theme-aware.
- **No clear primary on the customer count row.** `FinalCountTable.tsx:189-207`: "Correct" and "Remove from
  count" are equal-weight; "Remove" invites accidental data loss.
- **Sub-44px customer controls.** "+ Approve {code}" `FinalCountTable.tsx:121-128` (`text-[11px] py-0.5`);
  Export chips `ExportMenu.tsx:164` (~26px tall); cleanup buttons `CleanupRecommendations.tsx:117,203`.
- **Strengths to keep:** confirms on every destructive action; backup+Undo on delete/cleanup; plain-language
  empty states; `aria-live` scan success panel.

**Needs live verification:** contrast ratios + tap-target heights should be confirmed in-browser (axe/DevTools)
once the app is up.

---

## C. Design / IA — NEEDS WORK · Export — PASS

- **Mobile responsiveness is entirely absent (most serious).** `grep` for `sm:/md:/lg:/xl:` across
  `src/app` + `src/components` returns **nothing**. Five wide tables (Final counts 13 cols, Products 11,
  Needs Review 9, scan feed 10) rely on a single `overflow-auto` → tiny horizontal-scroll table on a phone,
  the core use case for a barcode scanner. No card-stack fallback; fixed `w-56/w-64` edit forms overflow.
- **IA gaps.** `/business` is orphaned from `Nav.tsx` (no way back to switch businesses once selected);
  two different sign-out controls (`Nav.tsx:44` confirm vs `business/page.tsx:59` no-confirm); brand wordmark
  isn't a link.
- **Settings is a 9-section wall** (`settings/page.tsx`) with no tabs/accordions — overwhelming for the
  platform owner; cluttered even for the gated customer view.
- **Competing row actions** in FinalCountTable (up to 4 buttons, two red) — apply the cleaner Needs-Review
  primary/secondary pattern.
- **No design tokens** — raw Tailwind literals repeated by hand; radius drift (`rounded` vs `rounded-lg` vs
  `rounded-xl`); dead Geist-font-then-Arial in `globals.css:8-26`.
- **Export PASS:** all four formats exist and are real (exceljs/jspdf installed), all derived from one
  sanitized CSV (`exportFormats.ts`) so no format can leak a field CSV wouldn't. Only gap: format chips are
  bare acronyms — "XLSX"→"Excel", "HTML"→"Web page (search + sort)" for the elderly audience.

---

## D. Security / privacy — NEEDS WORK (3 real customer leaks)
Architecture is strong (two-tier role gate, central denylist + stripper, role-aware serializers, gated CSV
export). Secrets **PASS** (no real secrets tracked; keys server-side only, enforced by `keySafety.test.ts`;
`.env*` gitignored). Sanitizer / semantic firewall **PASS** (masks PII both client + server side; untrusted
scan text wrapped in `<untrusted_input>`, never obeyed). **But three AI-internal fields render to the customer
on the `/review` route:**

1. **AI confidence %** — `NeedsReviewTable.tsx:207` (`{review.confidence}%`) + ungated "Confidence" header
   `:83`. Renders to **all roles**.
2. **`autoVerifyScore`** — `NeedsReviewTable.tsx:150-153` ("Confidence: X/100 (below auto-save threshold)") —
   no `isPlatform` guard.
3. **`verifiedFacts`** — `NeedsReviewTable.tsx:187-188` ("Facts: …", AI evidence quotes; on the denylist) —
   no `isPlatform` guard.

   The adjacent `evidenceStrength`, `providerName`, `sourceUrls`, `rawCode/cleanCode`, `decodeProviderSummaries`
   **are** correctly gated — these three slipped through.
4. **Automation gap:** `role-security-leak.spec.ts` `SENSITIVE_TERMS` does not include `confidence`/`facts`/
   `/100`, so the regression bot is **green while these leak**. Extend the term list.
5. **(P3 consistency):** `LiveScanFeed.tsx:63` (`product.name`) and `NeedsReviewTable.tsx:175-176`
   (`suggestedProductName`) render raw, bypassing `customerDisplayName()` — a code embedded in a name could
   reach the customer.

**Needs live verification:** confirm `/review` is reachable by the `business` (customer) role and that these
fields actually render there (couldn't load the UI this run). If `/review` is platform-only, severity drops —
but the missing `isPlatform` guards should be added regardless.

---

## E. Performance & health — NOT VERIFIED THIS RUN
App not running → no console-error sweep, no broken-link/stale-count live check. From 06-22 data: tire decode
p50/p95 ≈ 10s (bounded by the unchanged 13s budget / 10s provider timeout); poison deep-fallback ~35s
(pre-existing). Re-check console + Lighthouse once the server is up.

---

## Live accuracy sample (from 06-22 run; NOT re-run today)
Identity accuracy **100% (9/9)**, false auto-count **0%**, poison correctly withheld.

| Code | Expected | Decoded | Decision | Conf | Auto-counted | Why not (if not) |
|------|----------|---------|----------|------|--------------|------------------|
| 086699205636 | Michelin | Michelin | suggested | 0.55 | No | source page lacks load index + speed rating |
| 051342144969 | Continental | Continental | suggested | 0.55 | No | source page lacks full specs |
| 029142712886 | Cooper | Cooper | **verified** | 0.92 | **Yes** (deterministic_prefix) | — |
| 029142815167 | Cooper | Cooper | suggested | 0.55 | No | source page lacks full specs (title truncated speed) |
| 8807622002083 | Nexen | Nexen | suggested | 0.55 | No | source page lacks full specs |
| 8807622002649 | Nexen | Nexen | suggested | 0.55 | No | source page lacks full specs |
| 715459332915 | Hankook | Hankook | suggested | 0.55 | No | source page lacks full specs |
| 697662123125 | Goodyear | Goodyear | suggested | 0.55 | No | source page lacks full specs |
| 697662036067 | Goodyear | Goodyear | suggested | 0.55 | No | source page lacks full specs |
| 745125495781 | (poison) | (none) | needs_review | 0.0 | No | POISON — timed out on deep fallback → Needs Review (correct) |

Read: identity is perfect and safety is perfect; auto-count rate is low live **because 8/9 barcode-DB source
pages don't expose a parseable load index + speed rating**, and the tire-spec completeness gate correctly
withholds. The durable fix is grounded full-spec retrieval (RAG over the prefix table + catalog flywheel +
manufacturer spec sheets), **not** a corroboration/threshold change. Do not weaken the spec gate.

---

## Top priorities (impact order: correctness/safety > ease-of-use > design)
1. **P1 privacy:** gate the 3 AI-internal fields on `/review` behind `isPlatform` (confidence %, autoVerifyScore,
   verifiedFacts) + extend the leak bot to catch them. *(safety/privacy)*
2. **P1 ease-of-use:** de-jargon the in-feed badges for customers (Decoding/Verified/Synced/Sync error). *(ease)*
3. **P2 ease-of-use:** raise customer body text to ≥16px; fix zinc-400/500 low contrast; resolve dark-mode trap.
4. **P2 design:** add mobile responsiveness (card-stack fallback) to the 5 data tables. *(core scanner UX)*
5. **P3:** apply `customerDisplayName` in LiveScanFeed + NeedsReviewTable; one clear primary on the count row;
   enlarge sub-44px controls; plain-language export labels; nav `/business` + unify sign-out; Settings grouping.
6. **P4 hardening:** strongestEvidence tie-break on `verified`; expand `NON_TIRE_RE`; `import "server-only"` on
   the provider modules.
