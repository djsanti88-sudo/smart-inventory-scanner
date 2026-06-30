# Daily Comprehensive Review — Smart Inventory Scanner — 2026-06-26

Dir: `C:\Users\djsan\inventory` · Checked-out branch (HEAD): **`tire-barcode-db`** (the task assumed `decoder-hardening-v1-local`; HEAD currently points at `tire-barcode-db`, latest local commit "Master Baseline v1: any-source decode … 0.8 auto-count, bulk scan").
Mode: **read-only audit**. Reviewer: lead QA + product reviewer — 4 parallel code-dive sub-agents (correctness/safety, elderly accessibility, design/IA/export, security-leak/secrets) + status-doc reading + targeted code verification + live-app probe.
Nothing edited, committed, pushed, merged, or deployed. No live AI providers called.

## Run limitations (honest)
- **No live scans this session.** The Inventory dev server was **not running**. `localhost:3000` is currently serving the **Sharpenly** project (the other repo), and `localhost:3100` refuses the connection. The sandbox is a separate Linux box and cannot host/reach the Windows dev server. So **no fresh screenshots and no new live scans** were possible, and the live browser console could not be inspected. Live accuracy below is from the most recent on-disk runs (06-22 Phase 9 `coordination/AUTOCOUNT_LIVE_STATUS.json` + the larger 06-25 `reports/product-intel/2026-06-25/prefix-decode-validation.json`).
- **`npm run test` (vitest) is unrunnable on this Linux mount** — `node_modules` is Windows-built and the native `@rolldown/binding-linux-x64-gnu` is missing. Safety claims below are from current-code reads; last on-disk green run was **618 passed / 0 failed (06-22)**, and the corpus branch reported **646 passed / 0 failed**.
- **`git` history is unreadable from the sandbox** (OneDrive partial-sync of `.git/objects`). Working-tree files read fine; review is file-based.

---

## Area grades (at a glance)

| Area | Grade | Headline |
|------|-------|----------|
| A. Correctness & safety | **PASS** | All 6 invariants hold under the new 0.8 single-source baseline. Poison blocked at 4 layers. Dedup double-walled. **One hygiene flag: code comments + status docs still say "0.9" while enforced floor is 0.8 — reconcile so nobody "fixes" it back.** |
| B. Ease-of-use (65+) | **NEEDS WORK** | Decode badge still leaks "Verified AI Decode / Vendor label / Decoding with AI…" to customers ungated; 12px/11px body text + zinc-400 contrast + raw business UUID persist. (ExportMenu acronym chips fixed.) |
| C. Design / IA | **NEEDS WORK** | **Zero responsive breakpoints** in the whole app → 13-col tables horizontal-scroll on a phone. Geist→Arial; half-wired dark mode; duplicated button strings; missing Products empty state; export title hardcoded. |
| C2. Export | **PASS** | CSV/XLSX/PDF/interactive-HTML all real, library-backed, derived from one sanitized CSV, injection-tested. Only nit: business-name hardcode at the call site. |
| D. Security / privacy | **NEEDS WORK** | The 06-24 customer leak is **still live**: `confidence`, `autoVerifyScore`, `verifiedFacts` render **ungated** on `/review`; `confidence`/`autoVerifyScore` aren't even on the denylist. |
| E. Performance & health | **NOT LIVE-VERIFIED** | App down; no console check. 06-25 100-sample run shows **p95 ≈ 36s, max 40s** (vs ~10s on 06-22) — a latency regression to re-check live. |

---

## A. Correctness & safety — PASS (with a documentation-drift flag)

All six safety invariants were re-verified against **current** code (not just the prior report). Evidence file:line:

- **Poison `745125495781` → Needs Review, never auto-counts.** Four independent layers: (1) `evidenceVerifier.ts:39-47,87` — `INVALIDATION_RE`/`looksInvalidating()` reject "did you mean 7451254957818" pages; near-match never satisfies the scanned code; (2) `scanContextFirewall.ts:18-19,72` — `rivet` → `non_tire` → `category_context_conflict` (also guards the deterministic side-door via `detectIdentityContextConflict:37-54`); (3) `decode.ts:145,166,185,191` — non-tire never satisfies `isTireContext`/`hasCountableTireIdentity`, brand mismatch blocked by `brandPrefixConflict`; (4) store gate `scanStore.ts:1739,2031` requires `!contextConflict`. Tested by `scanContextFirewall.test.ts:20-22`.
- **Auto-count gate NOT loosened beyond the owner-approved baseline.** Gates at `scanStore.ts:1733-1739` and `:2025-2031` require ALL of: `status==="verified"` + `decodeCorroborated(decision)` (app-verified exact code OR `internet_two_source_size`) + `confidence >= 0.8` + `isUsableProductName` + `tireOk` (`tireAutoCountOk`) + `!contextConflict`, gated by `autoAddDecodedProducts ?? true`. `brandPrefixConflict` enforced upstream in `decideDecode`.
- **`decideDecode` (`decode.ts:191`)** emits `verified` only on `!brandPrefixConflict && (canVerify || singleSourceVerified || tireCorroborated || pageFetchModelAgreement || internetTwoSourceSize)`. Provider self-claimed `exactCodeEvidence` is **never** trusted — only `EvidenceVerifier` output (`decode.ts:86-87`). Disagreement → `conflict`.
- **Resolver trust intact.** `aliasMatcher.ts:56,86` filter `approved===true` / `verified===true`; vendor/FNSKU + conflicts → Needs Review (`resolver.ts:64-76`); ambiguous tiers → conflict, never guessed.
- **Idempotency / dedup double-walled.** Key built once (`idempotency.ts:7-14`), reused on retry; apply-once at mockDb + `InventoryCount` (`inventory.ts:40-56`); 3-layer dedup guard in `resolveUnknown` (`scanStore.ts:2112-2155`) — `>1 match → conflict` (the 235× rivet-kit bug guard), `===1 → reuse`.
- **Dead flag** `autoAcceptVerifiedDecodes` still declared-but-unused (`types.ts:304`, `scanStore.ts:216`); does not gate anything.

**The 0.8 vs 0.9 question (important, not a bug):** the latest commit is an owner-approved **"Master Baseline v1 — any-source decode (Gemini-first → ChatGPT escalation), 0.8 auto-count."** A single source confirming the exact code in **strong app-verified evidence** now auto-counts at **≥0.8** (no trusted-host requirement), with `prefixBrandConflict` as the catalog-derived brand sanity check. This is consistent with the inventory `CLAUDE.md` Master Baseline v1 and is **safe** — poison still fails evidence + firewall + brand-prefix + tire-spec gates. **BUT** the code comments (`scanStore.ts:145,156,1720`, `route.ts` comments) and every `coordination/*STATUS.json` still say "confidence >= 0.90". This drift is a real risk: a future session could read the comment and "restore" 0.9, silently reverting the approved baseline, or conversely think the floor is higher than it is. **Action: reconcile all comments + status docs to 0.8 and cite the Master Baseline v1 approval inline.**

Low-priority hardening nits (not failures): `NON_TIRE_RE` firewall is keyword-based; `npm run test` is unrunnable on Linux (rolldown native binding) — CI/portability gap.

## B. Ease-of-use (65+) — NEEDS WORK

The recent elderly-UX work (`UI_OVERHAUL_STATUS.json`: big green success panel, ≥44px targets on the scan page, plainer copy, confirmations + Undo on destructive actions) is real and good. Remaining customer-facing defects, verified present in current code:

1. **HIGH — Decode badge leaks AI/decode jargon to customers, ungated.** `badges.tsx:8-13` defines `"Decoding with AI…"`, `"Verified AI Decode"`, `"Vendor label"`, `"Conflict"`; rendered in the customer scan feed at `LiveScanFeed.tsx:69-73` with **no `isPlatform` gate**. The store sets `decodeStatus:"verified"` even for plain catalog matches (`scanStore.ts:1171,1467,2044`), so a 65+ customer scanning a *known* product sees **"Verified AI Decode."** The sibling `NeedsReviewTable.tsx:35-57` `DecodeBadge` **already** gates and uses customer-safe copy ("Verified match") — this one was missed. ~10-line fix mirroring that file.
2. **HIGH — Body text below the 16px floor in the scan feed.** `LiveScanFeed.tsx:53,56-57,64,75-77` use `text-xs`(12px) for the timestamp, the scanned barcode, the part number, and **the reason a scan did/didn't count** (the most important line for a non-technical user). Also `FinalCountTable.tsx:130` and `NeedsReviewTable.tsx:247,250`.
3. **MED — Contrast below WCAG AA.** `text-zinc-400` on white (~2.8:1) at `business/page.tsx:69,112`, `products/page.tsx:105,109`, `CleanupRecommendations.tsx:169,183,187,190`; borderline `zinc-500` on 12px text.
4. **MED — Raw business UUID shown to the user** (`business/page.tsx:75`, `font-mono text-xs`) when picking which business to enter — show the **name**, not the ID.
5. **MED — Tap targets <44px** on customer-tappable controls: `FinalCountTable.tsx:130` approve button (~22px), `business/page.tsx:82` "Select" (~28px) / `:102-109` "Create" (~36px) / `:59-65` "Sign out" bare link, `ExportMenu.tsx:164` chip height (~28px). The scan-page buttons already do this right — match them.
6. **FIXED since 06-24:** ExportMenu acronym chips are now plain format labels (CSV/XLSX/PDF/HTML as file-format buttons, plain dataset titles) — acceptable.

## C. Design / IA — NEEDS WORK

1. **P0 — No responsive breakpoints anywhere.** Grep found **zero** `sm:`/`md:`/`lg:` usage in `src/`. All three data tables wrap up-to-13-column tables in a single `overflow-auto` (`FinalCountTable.tsx:37-53`, `products/page.tsx:27-42`, `NeedsReviewTable.tsx:76-88`), so a phone in a tire shop gets a tiny horizontally-scrolling spreadsheet. **Highest-impact issue for the real use environment.** Fix: stacked-card layout under `md:` (label/value pairs) or at minimum `sticky left-0` on the Qty/Name column.
2. **P1 — Geist fonts loaded but body renders Arial.** `layout.tsx` loads Geist and sets the CSS vars, but `globals.css:25` hardcodes `font-family: Arial…`. The font files download and never render. Fix: `var(--font-geist-sans), Arial,…` (or `font-sans` on body).
3. **P1 — Dark-mode tokens half-wired (latent bug).** `globals.css:15-20` flips `--background`/`--foreground` under `prefers-color-scheme: dark`, but **no `dark:` utilities exist** and every card is hardcoded `bg-white text-zinc-900`. On a phone set to dark mode the page background goes near-black while cards stay white — partially unreadable. Fix: delete the block (ship light-only) or do a real dark pass.
4. **P2 — Duplicated button class strings across 7 files.** `btnBase/btnPrimary/btnSecondary` live function-local inside `NeedsReviewTable.tsx:140-142`; the same literal is copy-pasted in `FinalCountTable`, `scan/page`, `ExportMenu`, `Nav`, `SyncStatusBar`, `UndoDeleteBanner`. Extract to a shared `src/components/ui.ts`.
5. **P2 — Products page has no empty state** (`products/page.tsx:45-49`) — a fresh business sees "0 products" above a bare header. The other two tables have empty states; add the same `colSpan` pattern.
6. **P2 — Needs-Review action row: up to 8 controls in one `<td>`** (`NeedsReviewTable.tsx:316-422`) — Approve + select + Link + Create + Ignore + Live decode + Re-decode + checkbox. Move advanced actions into a "More" menu (FinalCountTable already cut its row to 2 via `SHOW_ADVANCED_ACTIONS=false`).
7. **P3 — `confirmAndDeleteProduct` uses native `window.confirm`** (`products/page.tsx:92`, `FinalCountTable.tsx:206`) — jarring on mobile; an in-app `UndoDeleteBanner` already exists.

## C2. Export — PASS
CSV (BOM + RFC-4180 + injection guard), XLSX (exceljs, all cells text `@` so barcodes never become `1.23E+11`), PDF (jspdf+autotable), interactive HTML (standalone, escaped, no CDN). All four derive from the one sanitized CSV via `parseCsv`, so no format can leak a field CSV wouldn't; round-trip + injection + script-breakout tested. **Only nit:** the export header/business name is hardcoded `"Smart Inventory Scanner"` at the **call site** `ExportMenu.tsx:81` (`exportFormats.ts` itself is correctly parameterized via `meta.businessName`). Read the real business name from the store and pass it through.

## D. Security / privacy — NEEDS WORK (one real customer leak, confirmed still live)
Defense-in-depth is otherwise strong: server-authoritative gate (`api/resolve-scan/route.ts`), denylist (`security/sensitiveFields.ts`), allowlist serializers, sanitizer before every provider call (`sanitizer.ts` applied at `api/ai-lookup/route.ts:188-189`, masks email/price/names, never masks UPC/EAN digit runs), keys server-side only (`keySafety.test.ts` enforces `src/components|stores|app/(app)|login|lib` never read `*_API_KEY`), `.env.local` gitignored, `.env.example` names-only. **But the 06-24 leak persists:**

- `NeedsReviewTable.tsx:150-154` renders `autoVerifyScore` → **"Confidence: {n}/100 (below auto-save threshold)"** — **ungated**, and `autoVerifyScore`/`autoVerifyScoreReason` are **NOT** in `SENSITIVE_FIELDS`.
- Header `:84` + cell `:206-208` render `review.confidence` as a **"%" column** — **ungated**, and `confidence` is **NOT** on the denylist.
- `:186-188` renders `verifiedFacts` → **"Facts: …"** — **ungated** in the JSX; `verifiedFacts` IS on the denylist so the wire is stripped, but any review object that reaches this component with the field (platform data path / local-mock) renders it to a customer.

**Fix (defense-in-depth):** wrap `:84`, `:150-154`, `:186-188`, `:206-208` in `{isPlatform && …}`, AND add `confidence`, `autoVerifyScore`, `autoVerifyScoreReason` to `SENSITIVE_FIELDS`, AND add the strings `"Confidence:"`, `"/100"`, `"Facts:"` to the `role-security-leak` bot's customer-page denylist sweep so it can't regress. Everything else (LiveScanFeed, FinalCountTable, ScannerInput, ExportMenu) is correctly gated.

## E. Performance & health — NOT LIVE-VERIFIED THIS RUN
App down → no live console/network check. From on-disk runs: 06-22 tire decode p50/p95 ≈ 10s; **but the 06-25 100-code validation shows p50 10s, p95 ≈ 36s, max 40s** — a latency regression (likely the any-source page-fetch/deep-fallback under Master Baseline v1). Needs a live re-check with the console open once the server is up.

---

## Live per-code accuracy (most recent on-disk runs — NOT re-run this session)

**06-22 Phase 9 (the task's 9 tires + poison) — `coordination/AUTOCOUNT_LIVE_STATUS.json`:**

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
| 745125495781 | (poison) | (none) | needs_review | 0.00 | No (correct) | poison → Needs Review, deep-fallback timeout, never counted |

06-22 summary: **identity 100% (9/9), auto-count 11% (1/9), false auto-count 0%, poison blocked.**

**06-25 larger run (100 codes, after Master Baseline v1) — `reports/product-intel/2026-06-25/prefix-decode-validation.json`:** sampled 100 · **verified 58%** · needs-review 42% · **brand-correct 89%** · latency p50 10s / **p95 36s / max 40s** · cost $0 (cache/replay, 0 live calls). The single-source-0.8 baseline materially raised the auto-count/verified rate (11% → 58%) **without** a false-count, while brand accuracy stayed ~89%. The remaining 42% review rate is mostly the tire-spec completeness gate correctly withholding under-specified source pages — the durable fix is grounded full-spec retrieval (the server-only tire-knowledge corpus / RAG flywheel, `RAG_KNOWLEDGE_STATUS.json`), not a threshold change.

---

## What still needs live verification (next time the server is up)
1. Re-run the 10-scan live sample (9 tires + poison) and confirm identity 100% + poison blocked under the 0.8 baseline.
2. Browser console clean on Scan / Products / Needs Review / Settings; no network errors.
3. Screenshot the customer `/review` page to confirm the `confidence`/`autoVerifyScore`/`verifiedFacts` leak visually (before), then after the fix (after).
4. Phone-width (≤390px) screenshots of Final counts + Products to confirm the responsive fix.
5. Re-measure decode p95 live (06-25 showed 36s) with the console/network panel open.

---

=== PASTE THIS INTO CLAUDE CODE (daily master plan) ===

```xml
<task>
You are a senior product engineer + QA on "Smart Inventory Scanner" (C:\Users\djsan\inventory).
Branch in use: tire-barcode-db (HEAD). Execute the phases below IN ORDER. This is execution, not
planning — do not return another plan. Work in small, verified commits on the CURRENT branch.

<critical_rules>
- DO NOT deploy, push, merge, or change Firebase/RTDB rules. Local commits only.
- PRESERVE every data-testid and the customer/platform privacy gate. Customer (non-platform) users
  must NEVER see: barcode/gtin/upc/ean, aliases, provider internals, confidence scores, autoVerify
  scores, verifiedFacts, decode traces, or AI jargon.
- PRESERVE all poison/auto-count safety invariants. The poison code 745125495781 MUST stay in Needs
  Review and never auto-count. Do NOT change the 0.8 auto-count floor, the tire-spec completeness
  gate, the firewall, brand-prefix conflict, evidence verifier, resolver trust, or idempotency/dedup.
  This is owner-approved "Master Baseline v1" — do not "restore" 0.9.
- After EACH phase: npx tsc --noEmit && npx eslint src e2e && npx next build && npx vitest run
  (per-file if the full run fails) && npm run qa:bots:security && npm run qa:bots:ux. If a UI phase,
  also take before/after screenshots into e2e/proof/ at phone width (390px) and desktop.
- Proof required for every "done" claim (test output / screenshot path). If something fails twice,
  STOP and report the exact blocker — do not fake a pass or hide a TODO.
- Update coordination/*STATUS.json + reports/daily as you go. Commit per phase with a clear message.
</critical_rules>

<phase id="1" priority="P0-SECURITY" title="Close the /review customer leak">
Problem: confidence, autoVerifyScore, and verifiedFacts render to CUSTOMERS on Needs Review.
Changes in src/components/NeedsReviewTable.tsx:
  - Wrap the "Confidence" <th> (~line 84), the autoVerifyScore "Confidence: n/100" block (~150-154),
    the verifiedFacts "Facts:" block (~186-188), and the confidence "%" cell (~206-208) in
    {isPlatform && ( ... )}.
Changes in src/services/security/sensitiveFields.ts:
  - Add "confidence", "autoVerifyScore", "autoVerifyScoreReason" to SENSITIVE_FIELDS.
Regression guard:
  - Add the literal strings "Confidence:", "/100", and "Facts:" to the role-security-leak bot's
    customer-page denylist sweep (the qa:bots:security spec) so this can never regress.
Acceptance: a non-platform user on /review sees NO confidence value, NO "/100", NO "Facts:".
qa:bots:security leak findings == []. Add/extend a unit test asserting the three fields are gated.
Proof: qa:bots:security output + a customer-role /review screenshot showing none of the three.
</phase>

<phase id="2" priority="P1-UX" title="Stop the decode badge leaking AI jargon to customers">
Problem: src/components/badges.tsx DecodeStatusBadge shows "Verified AI Decode" / "Vendor label" /
"Decoding with AI…" and is rendered ungated in src/components/LiveScanFeed.tsx (~69-73). The store
sets decodeStatus:"verified" even for plain catalog matches, so every customer sees AI jargon.
Changes:
  - Give DecodeStatusBadge an isPlatform prop + a customer-safe label map (mirror the already-correct
    DecodeBadge in NeedsReviewTable.tsx:35-57): verified→"Confirmed", decoding→"Checking…",
    suggested→"Suggested", conflict→"Needs a look", vendor_label/needs_review→"Needs a look".
  - Pass isPlatform from LiveScanFeed where the badge renders.
Acceptance: customer scan feed shows plain words only; platform users still see the diagnostic labels.
Proof: customer-role + platform-role scan-feed screenshots.
</phase>

<phase id="3" priority="P1-UX" title="Readability floor for 65+ users">
In src/components/LiveScanFeed.tsx raise the timestamp, scanned barcode, part number, and reason cells
(~53,56-57,64,75-77) from text-xs(12px) to text-base(16px); darken text-zinc-400 → text-zinc-700 and
borderline text-zinc-500 used for important text. Fix the same in FinalCountTable.tsx:130 and the
ungated text-zinc-400 at business/page.tsx:69,112, products/page.tsx:105,109,
CleanupRecommendations.tsx:169,183,187,190. Ensure every customer-tappable control is min-h-[44px]
with adequate horizontal padding: FinalCountTable approve button (~130), business/page Select(82)/
Create(102-109)/Sign out(59-65), ExportMenu format chips (~164). Replace the raw business UUID at
business/page.tsx:75 with the business NAME (join/lookup; if only the id exists, label it plainly and
enlarge — never show a bare UUID as the only identifier).
Acceptance: no customer-visible text under 16px; all customer tap targets ≥44px; contrast ≥4.5:1.
Proof: before/after phone-width screenshots of the scan feed + business page.
</phase>

<phase id="4" priority="P0-DESIGN" title="Make the data tables usable on a phone">
Problem: zero responsive breakpoints; 13-column tables horizontal-scroll on a phone (the real tire-shop
device). Add a stacked-card layout under md: (label/value pairs per row) for FinalCountTable.tsx (37-53),
products/page.tsx (27-42), and NeedsReviewTable.tsx (76-88). If a full card layout is too large for one
phase, ship sticky left-0 on the Qty/Name first column as the minimum, then iterate. Add the missing
Products empty state (products/page.tsx:45-49) using the same colSpan pattern the other two tables use.
Acceptance: at 390px width, Qty + Product are always readable without horizontal scrolling; Products
shows a friendly empty state when there are 0 products.
Proof: 390px screenshots of all three tables + the empty Products state.
</phase>

<phase id="5" priority="P2-POLISH" title="Tokens, shared buttons, export name, doc drift">
- globals.css:25 — make body font use var(--font-geist-sans) (or add font-sans to body) so the loaded
  Geist font actually renders instead of Arial.
- globals.css:15-20 — either delete the prefers-color-scheme:dark block (ship light-only) OR add real
  dark: variants to cards/tables. Do not leave it half-wired.
- Extract btnBase/btnPrimary/btnSecondary/btnDanger from NeedsReviewTable.tsx:140-142 into a shared
  src/components/ui.ts and import across FinalCountTable, scan/page, ExportMenu, Nav, SyncStatusBar,
  UndoDeleteBanner.
- ExportMenu.tsx:81 — read the real business name from the store and pass it as ExportMeta.businessName
  (and wb.creator) instead of the hardcoded "Smart Inventory Scanner".
- Doc/comment drift: update the stale "confidence >= 0.90" comments (scanStore.ts:145,156,1720 and any
  route.ts comment) and the coordination/*STATUS.json "0.90" notes to the enforced 0.8, citing
  "Master Baseline v1 (owner-approved)". DO NOT change any runtime threshold — comments/docs only.
Acceptance: app renders in Geist; dark-mode is consistent or removed; one shared button module; exports
show the shop's name; no doc says 0.9 where the code enforces 0.8.
Proof: tsc/eslint/build/vitest green; a PDF/HTML export screenshot showing the business name.
</phase>

<phase id="6" priority="VERIFY" title="Full verification + live re-check + status file">
- Run: npx tsc --noEmit, npx eslint src e2e, npx next build, vitest (full or per-file), npm run qa:bots
  (security + ux + data + tire). Capture outputs.
- Start the dev server locally and run the 10-scan live sample (086699205636 Michelin, 051342144969
  Continental, 029142712886 Cooper, 029142815167 Cooper, 8807622002083 Nexen, 8807622002649 Nexen,
  715459332915 Hankook, 697662123125 Goodyear, 697662036067 Goodyear, then poison 745125495781).
  Record decoded brand / verified-vs-review / confidence / auto-counted, and confirm poison stays in
  Needs Review. Respect the app daily cap (stop if dailyLookupCount>=dailyLimit). Measure decode p95
  (06-25 showed ~36s — note if it is still that high).
- Write reports/daily/DAILY_FIX_2026-06-26_STATUS.md: per-phase changes, files, test/bot/build output,
  screenshot paths, live accuracy table, branch + commit hashes, known risks, what was NOT done, and
  rollback instructions. DO NOT push/merge/deploy.
</phase>

<definition_of_done>
All 6 phases committed locally on tire-barcode-db. Customer /review shows no confidence/score/facts;
scan feed shows no AI jargon to customers; no customer text <16px; tap targets ≥44px; tables usable at
390px; Products has an empty state; Geist renders; one shared button module; exports show the shop name;
docs reconciled to 0.8. Poison still blocked; auto-count gate + 0.8 floor + spec gate unchanged.
tsc/eslint/build/vitest/qa:bots green with proof. Status file written. Nothing pushed/merged/deployed.
</definition_of_done>
</task>
```
