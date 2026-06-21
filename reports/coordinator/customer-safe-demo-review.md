# Coordinator Review — Customer-Safe Demo Branch

**Role:** Coordinator / Reviewer. **Goal:** safely combine Window 1 (P0 customer-security foundation)
and Window 2 (demo-readiness + part-number) into one clean, verified review branch. **No deploy, no
merge to master/main, Vercel untouched.**

Generated: 2026-06-15. Worktree: `C:\tmp\inventory-coordinator` (isolated; Window 1 and Window 2
checkouts were not modified).

---

## 1. Branch name
`coordinator/customer-safe-demo-review`

## 2. Base commit
`7090873` — Window 1 tip (`p0-platform-customer-security-audit`), "docs: record commit hash + review
checklist in IMPLEMENTATION_STATUS". Window 1 foundation commit `a11d265` is its parent.

## 3. Window 2 commit applied
`58855dfe7ba2b0b271312f92efcbaa32c0afa6f7` ("Demo readiness part number and weekly QA plan"),
**cherry-picked** onto the base. Cherry-pick was **conflict-free**: `58855df`'s parent is exactly
`7090873`, so the applied tree is byte-identical to the Window 2 tree (verified:
`HEAD^{tree} == 58855df^{tree}`). Cherry-pick landed as `6705cf6`.

## 4. Extra scoped fix made on the coordinator branch
**One** fix, inside the `allowed_fixes` category "Customer UI leak of raw/internal field":

- **`src/components/LiveScanFeed.tsx`** — gated the **`Match` column** (`<MatchBadge type={e.matchType}/>`)
  behind `isPlatform`, mirroring the existing `Raw code` / `Clean code` gating in the same file. Customer
  `colSpan` adjusted `8 → 7`; header comment updated.

**Why this is correct and in-scope (not scope creep):** Window 2's own audit
(`reports/demo-readiness/PART_NUMBER_DISPLAY_AUDIT.md`, rows 43–44 and line 115) explicitly classifies
the internal `matchType` as **denylisted for customers** and **fixed it in `ScannerInput`** — but it only
checked *raw/clean code* gating in `LiveScanFeed` and **missed the identical `matchType` exposure in the
Match column**. On the customer-reachable `/scan` page, `MatchBadge` rendered labels including
**"Barcode", "GTIN", "UPC", "EAN", "Alias", "SKU"** to customer roles — directly violating the
`hide_barcode` hard rule and the acceptance criterion *"matchType is hidden from customer UI."* The fix
closes that gap so the branch satisfies its own customer-UI acceptance criteria, consistent with Window
2's stated principle. It is surgical (one file, pattern-matching), breaks **zero** tests, and is trivially
reversible if a reviewer prefers to keep the Match badge.

> Note: the `SecurityLeakBot` (`role-security-leak.spec.ts`) inspects `/products`, `/review`, `/settings`
> bodies + localStorage — it does **not** inspect the `/scan` Live Scan Feed Match badge, which is why its
> `findings: []` did not surface this. The fix removes the exposure regardless.

## 5. Exact files changed in the coordinator branch
**From Window 2 (`58855df`, via cherry-pick `6705cf6`) — 12 files:**
- `src/components/LiveScanFeed.tsx` (Part number column)
- `src/components/ScannerInput.tsx` (role-aware scan confirmation)
- `package.json` (+`qa:weekly-report` script, scripts-only)
- `docs/SCHEDULED_QA_BOTS.md`
- `reports/demo-readiness/{VERCEL_DEMO_CHECKLIST,PART_NUMBER_DISPLAY_AUDIT,CONTROLLED_DEMO_SCRIPT,WINDOW2_FINAL_REPORT}.md`
- `e2e/human-bots/scenarios/partnumber-display.spec.ts`
- `e2e/proof/demo-readiness/0{1,2,3}-*.png` (3 proof screenshots)

**Coordinator-only changes (this review):**
- `src/components/LiveScanFeed.tsx` (Match-column `isPlatform` gate — the scoped fix in §4)
- `reports/coordinator/customer-safe-demo-review.md` (this report)

Regenerated bot proof artifacts (screenshots, `reports/**/latest/*`, playwright HTML report) from the
verification runs were **intentionally discarded** (per `do_not_commit`: "regenerated noisy artifacts").
Window 2's committed proof artifacts remain as Window 2's historical proof.

## 6. Test results by command (all on the coordinator branch, post-fix)
| Command | Result | Notes |
|---|---|---|
| `npx tsc --noEmit` | ✅ PASS (exit 0) | |
| `npx eslint src e2e` | ✅ PASS (exit 0) | 4 pre-existing warnings, **0 errors** |
| `npx vitest run` | ✅ PASS | **394 passed, 30 skipped** |
| `npx next build` | ✅ PASS | 11/11 static pages, all routes compiled |
| `npm run qa:bots:security` | ✅ PASS | 2 passed; `security_findings.json` = `{ "findings": [] }` |
| `npm run qa:bots:data` | ✅ PASS | 1 passed |
| `npm run qa:bots:tire` | ✅ PASS | 1 passed (Falken/Camel — see §11) |
| `npm run qa:bots:ux` | ✅ PASS | 1 passed |
| `npm run qa:weekly-report` | ✅ PASS | chained security && data && tire && ux, all green |
| `partnumber-display.spec.ts` (bots config) | ✅ PASS | 1 passed |

Environment note: the isolated worktree initially used a `node_modules` **junction**, which Turbopack
rejects ("symlink points out of filesystem root"). Resolved by a clean `npm ci` (same lockfile, deps
unchanged). tsc/eslint/vitest results above were re-confirmed after the fix on real `node_modules`.

## 7. SecurityLeakBot findings
**`[]` (empty).** `reports/agent-bots/latest/security_findings.json` = `{ "findings": [] }`. The bot
asserts (hard regression guard) the customer browser holds **no** alias/catalog DB in localStorage and
shows **no** code columns — all pass.

## 8. Part number visible — confirmed
- **Live Scan Feed:** new "Part number" column renders `product.primarySku` for all roles
  (`data-testid="feed-part-number-*"`).
- **Scan confirmation (ScannerInput):** customer message is `Counted: <name> (part no. <primarySku>).`
- **Products table:** customer sees the Part number column.
- **Proof:** `partnumber-display.spec.ts` asserts the feed + products show `T432119` (Nokian) → PASS.

## 9. Barcode / raw code hidden — confirmed
- `Raw code` and `Clean code` columns in `LiveScanFeed` are `isPlatform`-gated (customer never sees them).
- `partnumber-display.spec.ts` asserts the raw barcode `6419440485331` is **absent** from the customer
  page body on `/scan` and `/products` → PASS.
- Match column (`matchType`) now also platform-only after the §4 fix.

## 10. Scan-confirmation leak fixed — confirmed
`ScannerInput` `statusMessage()` is role-aware. **Before** (Window 1 base): every role saw
`Counted: <cleanCode> (<matchType>)`. **After** (Window 2): platformOwner keeps the technical detail;
customer sees **name + part number only — no `cleanCode`, no `matchType`, no raw code**. Conflict/unknown
customer messages are code-free.

## 11. Falken / Camel regression — PROTECTED
`platformOwner-tire-resolution.spec.ts` scans all 8 critical-regression shapes and asserts none → Camel,
every part-number variant → Falken. Result artifact `tire_resolution_result.json`: `resolvedToCamelAnywhere: false`.

| Code | Resolves to | Status |
|---|---|---|
| `848983012906` (barcode) | Falken | known |
| `2881-6861` | Falken | known |
| `28816861` | Falken | known |
| `2881 6861` | Falken | known |
| `2881/6861` | Falken | known |
| `2881\6861` | Falken | known |
| `2881_6861` | Falken | known |
| `2881.6861` | Falken | known |

Seed catalog contains **no** Camel product (baseline assertion passes), so a Camel resolution could only
come from a real bug. Bot coverage active and green.

## 12. Vercel readiness status
**Untouched.** No Vercel config, no deploy, no cron, no GitHub Actions. `VERCEL_DEMO_CHECKLIST.md` is
preparation-only and states **"NO DEPLOY unless Santiago explicitly types `DEPLOY NOW`."** Readiness is
gated on the Firebase Admin credential decision (§13).

## 13. Firebase Admin credential blocker status
**OPEN — documented, not bypassed (expected ops blocker).** `/api/resolve-scan` needs Firebase Admin
credentials in the Vercel runtime; without them it returns a **graceful 503 fallback**, not a crash.
Documented in `VERCEL_DEMO_CHECKLIST.md` §2 ("the real blocker") and `WINDOW2_FINAL_REPORT.md` §4
("OPEN (ops, expected)"). The platformOwner/mock demo path is unaffected. **No credentials were
implemented or committed** (out of scope; correct).

## 14. Weekly QA bot status
`qa:weekly-report` **exists and is report-only**: `npm run qa:bots:security && qa:bots:data &&
qa:bots:tire && qa:bots:ux`. It runs the four Playwright report bots against a pinned, mock-backend,
auth-bypass dev server (port 3300) — **no auto-fix, no deploy, no cloud/production access**. Ran
end-to-end on this branch: **all four green**.

## 15. Recommendation — open ONE PR from the coordinator branch
Open a **single PR from `coordinator/customer-safe-demo-review`** (base: `master`, **for review only —
do not merge without Santiago's approval**). Rationale: the branch cleanly contains Window 1 + Window 2 +
one documented, verified customer-UI fix, with all gates green and SecurityLeakBot `[]`. It is the single
reviewable unit that proves customer-safe scanning end-to-end. Keep Window 1 and Window 2 branches intact
(do not delete). If Santiago disagrees with the §4 Match-column fix, it can be dropped with a single
revert and the rest of the branch is unaffected.

## 16. Todos
- [x] Coordinator branch created (`coordinator/customer-safe-demo-review` on `7090873`).
- [x] Window 2 commit applied (`58855df` → cherry-pick `6705cf6`, conflict-free).
- [x] Focused verification completed (tsc, eslint, vitest, qa bots, partnumber spec).
- [x] Full verification completed (next build, qa:weekly-report).
- [x] SecurityLeakBot checked — findings `[]`.
- [x] Part number visibility checked — visible to customer.
- [x] Barcode/raw code hiding checked — hidden from customer.
- [x] Scan-confirmation `cleanCode`/`matchType` leak — fixed (W2) + LiveScanFeed Match gated (coordinator).
- [x] Falken/Camel regression checked — protected (all 8 shapes → Falken).
- [x] Weekly QA status checked — exists, report-only, green.
- [x] Coordinator report created (this file).

## 17. Final confirmation
- **NO DEPLOY** — nothing deployed.
- **NO MERGE TO MASTER/MAIN** — coordinator branch only; `58855df` confirmed not in `master`.
- **VERCEL UNTOUCHED** — no Vercel config/cron/Actions.
- **NO SECRETS COMMITTED** — only `LiveScanFeed.tsx` + this report; no `.env`, no service-account JSON,
  no credentials; gitignored `data/` never staged.
