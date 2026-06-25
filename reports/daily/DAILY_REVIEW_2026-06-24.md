# Daily Comprehensive Review — Smart Inventory Scanner — 2026-06-24

Branch: `decoder-hardening-v1-local` · Dir: `C:\Users\djsan\inventory` · Mode: **read-only audit**
Reviewer: lead QA + product reviewer (4 parallel code-dive sub-agents + status/report reading + targeted code verification).
Nothing edited, committed, pushed, merged, or deployed. No live providers called.

## Run limitation (honest)
The inventory dev server was **not running** on the owner's machine this session — `localhost:3000` and
`localhost:3100` both refused connection. The sandbox is a separate Linux box and cannot host/reach the
Windows dev server, so **no fresh screenshots and no new live scans were possible**, and the live browser
console could not be inspected. Live per-tire accuracy below is from the most recent on-disk live run
(**06-22 Phase 9**, `coordination/AUTOCOUNT_LIVE_STATUS.json`) plus existing `e2e/proof/` artifacts.
`npm run test` (vitest) cannot execute on this Linux mount — the `node_modules` was installed for Windows
and the native `@rolldown/binding-linux-x64-gnu` is missing; per-file `npx vitest run` works and the
safety-critical suites pass (377 of them, 0 fail). Last full green local run was **618 passed / 0 failed (06-22)**.

---

## Area grades (at a glance)

| Area | Grade | Headline |
|------|-------|----------|
| A. Correctness & safety | **PASS** | Poison blocked, auto-count gate intact, idempotency/dedup double-walled. Dead flag confirmed dead. |
| B. Ease-of-use (65+) | **NEEDS WORK** | Jargon decode badge + 12px/11px text + low-contrast grays leak to the customer; raw business ID shown. |
| C. Design / IA | **NEEDS WORK** | No responsive breakpoints (13-col horizontal scroll on a phone); dead/contradictory tokens; copy-pasted button strings. |
| C2. Export | **PASS** | All four formats (CSV/XLSX/PDF/interactive-HTML) real, library-backed, sanitized + XSS-tested from one source. |
| D. Security / privacy | **NEEDS WORK** | `autoVerifyScore` + `confidence` (not on denylist) render **ungated** to the customer on `/review`; `verifiedFacts` UI render is ungated too (belt-and-suspenders gap). |
| E. Performance & health | **NOT VERIFIED THIS RUN** | App down; no console check possible. 06-22 tire decode p95 ~10s. |

---

## A. Correctness & safety — PASS
All five safety invariants verified by code read; corroborated by the 06-22 test run (377 safety-critical tests green per-file).

- **Poison `745125495781` → Needs Review, never auto-counts.** Structural, multi-layer, no bypassable list:
  evidence (`evidenceVerifier.ts` exact-code boundary; near-match `7451254957818` never satisfies the scanned
  code), firewall (`scanContextFirewall.ts:19,72` — decodes to a rivet kit → `non_tire` → `category_context_conflict`),
  decode (`decode.ts` requires `isTireContext`), store gate (`scanStore.ts:1613-1620`). Side-door deterministic
  path re-checks domain via `detectIdentityContextConflict` (`scanStore.ts:860-862`). 06-22 live: poison → needs_review, 0% auto-count.
- **Auto-count gate not loosened.** Store gate requires ALL of: `status==="verified"` + `exactCodeEvidenceVerifiedByApp`
  + `confidence>=0.9` + usable name + tire specs (`tireOk`) + no firewall/brand-prefix conflict, gated again by
  `autoAddDecodedProducts`. `decideDecode` emits `verified` only via two-provider agreement, STRONG-tier prefix
  family, or page-fetch+independent-model agreement — each requiring app-verified strong evidence + full specs.
  Provider self-claimed `exactCodeEvidence` is never trusted (only `EvidenceVerifier`).
- **Resolver trust intact.** `aliasMatcher.ts` returns `known` only from `approved===true` alias or `verified===true`
  product; AI = suggestion only; vendor/FNSKU + conflicts → Needs Review.
- **Idempotency / dedup.** `idempotencyKey` built once at scan time (`idempotency.ts:7`, `scanStore.ts:847-848`),
  reused on retry; apply-once at mockDb + `InventoryCount` (`inventory.ts:40`). The 235× "Manstel rivet kit"
  duplicate-product bug is **fixed** — `resolveUnknown` create-new funnels through a 3-layer dedup guard
  (`scanStore.ts:1749-1834`); `>1 match → conflict`, never a guess.
- **Dead flag** `autoAcceptVerifiedDecodes` confirmed declared-but-unused; does **not** gate auto-count.

**Hardening nits (low priority, not failures):** `NON_TIRE_RE` firewall is keyword-based (a poisoned source with
no listed keyword + no specs classifies `unknown`, but still cannot auto-count — spec/prefix/two-source gates hold);
`npm run test` is unrunnable on Linux/CI (rolldown native binding) — portability gap, not a logic defect.

## B. Ease-of-use (65+) — NEEDS WORK
The recent P3/P4/P5 work is real and substantial (ScannerInput, Settings, SyncStatusBar are exemplary; confirmations
on every destructive action; good plain-language empty states). Remaining customer-facing defects:

1. **Decode badge leaks jargon to the customer.** `DecodeStatusBadge` (`badges.tsx:5-21`) is rendered in the
   customer scan feed (`LiveScanFeed.tsx:69-73`) **without an `isPlatform` gate**, showing hardcoded
   "Decoding with AI…", "Verified AI Decode", "Vendor label", "Conflict". `NeedsReviewTable`'s `DecodeBadge` already
   does role-aware copy — this one was missed.
2. **Body copy below the 16px floor.** `text-xs`(12px)/`text-[11px]` on customer-visible timestamps + part numbers
   (`LiveScanFeed.tsx:53,64`, `FinalCountTable.tsx:116,141`, `products/page.tsx:74`), the whole `CleanupRecommendations`
   panel, and `ExportMenu` format chips.
3. **Contrast below WCAG AA.** `text-zinc-400` on white (~2.5:1) at `business/page.tsx:69,112`, `FinalCountTable.tsx:127`;
   borderline `text-zinc-500` timestamps.
4. **Raw business ID + role shown to user** (`business/page.tsx:75`) — show the business **name**, not the ID/"admin".
5. **Acronym chips** "CSV / XLSX / PDF / HTML" (`ExportMenu.tsx:116-121`) — a 65+ user won't know XLSX.

## C. Design / IA — NEEDS WORK
- **No responsive breakpoints — the biggest gap for a phone scanner.** Tables rely on `overflow-auto`; up to 13
  columns (`FinalCountTable.tsx:53`) means a horizontal-scroll slog on a phone in a tire shop. Add a stacked-card
  layout under `sm:` (or freeze Qty + Product columns).
- **Dead/contradictory tokens:** Geist fonts declared (`globals.css:11-12`) but body renders Arial (`:25`); dark-mode
  tokens exist (`:15-20`) with zero dark-mode components → on a dark-OS device the body bg flips dark while every card
  stays white (latent visual bug). Pick one / delete the unused block.
- **Copy-pasted button strings** across 5 files; shared `btnPrimary/btnSecondary` constants already exist in
  `NeedsReviewTable.tsx:140-142` — lift into one `src/components/ui.ts`.
- **Missing Products empty state** (`products/page.tsx:45`); **dense Needs-Review action row** (up to 7 buttons) for platform owner.

## C2. Export — PASS
CSV (`exportFormats.ts:62`, BOM + RFC-4180 + injection guard), XLSX (`:67`, exceljs, all cells text `@` so barcodes
never become `1.23E+11`), PDF (`:89`, jspdf+autotable), interactive HTML (`:118`, standalone, `</`→`<`, textContent).
All four derive from the one sanitized CSV, so no format can leak a field CSV wouldn't. Round-trip + injection +
script-breakout tested. Minor: PDF/HTML header hardcodes `"Smart Inventory Scanner"` instead of the real business name.

## D. Security / privacy — NEEDS WORK (one real customer leak, confirmed from 06-23 and still live)
Defense-in-depth is otherwise strong: server-authoritative gate (`api/resolve-scan/route.ts`), denylist
(`sensitiveFields.ts`), allowlist serializers, sanitizer before every provider call (`sanitizer.ts`, run at
`api/ai-lookup/route.ts:168-169`), keys server-side only (`keySafety.test.ts` enforces), no secrets committed,
prompt isolates `<untrusted_input>`. **But:**

- `NeedsReviewTable.tsx:150-152` renders `autoVerifyScore` ("Confidence: X/100 (below auto-save threshold)") and
  `:207` renders `review.confidence` as a `%` column — **both ungated** (no `isPlatform`), and **neither field is on
  the denylist** (`sensitiveFields.ts`), so they survive into the customer client store and **display to the customer**.
- `:186-187` renders `verifiedFacts` ungated; `verifiedFacts` *is* on the denylist (stripped at the data layer), so
  it is a latent belt-and-suspenders gap rather than a guaranteed leak — but the UI should still gate it.
- **Fix (defense-in-depth):** add `confidence`, `autoVerifyScore` (and any `autoVerifyScoreReason`) to
  `SENSITIVE_FIELDS`, AND wrap the three renders in `{isPlatform && …}`. Add the strings "Confidence:" / "/100" /
  "Facts:" to the `role-security-leak` bot's customer-page denylist sweep so this can't regress.

## E. Performance & health — NOT VERIFIED THIS RUN
App down → no live console/network check. From 06-22: tire decode p50/p95 ≈ 10s (bounded by the unchanged 13s budget);
poison deep-fallback ≈ 35s (pre-existing). Needs a live re-check once the server is up.

---

## Live per-tire accuracy (most recent on-disk run — 06-22 Phase 9; NOT re-run this session)

| Barcode | Expected | Decoded | Decision | Conf | Auto-counted | Why not (if review) |
|---|---|---|---|---|---|---|
| 086699205636 | Michelin | Michelin | suggested | 0.55 | No | source page lacks load index + speed rating |
| 051342144969 | Continental | Continental | suggested | 0.55 | No | source page lacks full specs |
| 029142712886 | Cooper | Cooper | **verified** | 0.92 | **Yes** (deterministic_prefix) | — |
| 029142815167 | Cooper | Cooper | suggested | 0.55 | No | source page truncated speed rating |
| 8807622002083 | Nexen | Nexen | suggested | 0.55 | No | source page lacks full specs |
| 8807622002649 | Nexen | Nexen | suggested | 0.55 | No | source page lacks full specs |
| 715459332915 | Hankook | Hankook | suggested | 0.55 | No | source page lacks full specs |
| 697662123125 | Goodyear | Goodyear | suggested | 0.55 | No | source page lacks full specs |
| 697662036067 | Goodyear | Goodyear | suggested | 0.55 | No | source page lacks full specs |
| 745125495781 | (poison) | (none) | needs_review | 0.00 | No (correct) | poison → Needs Review, never counted |

**Identity accuracy: 100% (9/9 brands correct). Auto-count: 11% live (1/9). False auto-count: 0%. Poison: blocked.**
The low live auto-count rate is **not a safety defect** — 8/9 barcode-DB source pages don't expose a parseable load
index + speed rating, and the tire-spec completeness gate (a hard safety rule) correctly withholds rather than
auto-count an under-specified tire. Mock baseline with full specs is 89%. The durable fix is grounded full-spec
retrieval (RAG over the prefix table + catalog flywheel + manufacturer spec sheets — Improvement Plan P2), NOT a
corroboration/threshold change.

---

## What still needs live verification (next time the server is up)
1. Re-run the 10-scan live sample (9 tires + poison) and confirm the 06-22 table still holds.
2. Browser console clean on Scan / Products / Needs Review / Settings; no network errors.
3. Screenshot the customer `/review` page to confirm the `confidence`/`autoVerifyScore`/`verifiedFacts` leak visually
   (before) and after the fix (after).
4. Phone-width (≤390px) screenshots of Final counts + Products to confirm the responsive fix.
