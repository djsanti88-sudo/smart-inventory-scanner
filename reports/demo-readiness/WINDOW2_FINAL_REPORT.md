# Window 2 — Final Report (Demo Readiness, Vercel Prep, Part Number, Scheduled QA)

**Date:** 2026-06-15
**Window:** 2 (parallel support / demo-readiness). Window 1 owns the P0 security implementation.

---

## 1. Branch
`demo-readiness-vercel-partnumber`

Worked in an **isolated git worktree** at `C:\tmp\inventory-demo` so Window 1's checkout at
`C:\Users\djsan\inventory` was never touched, switched, or made dirty by this window.

## 2. Base commit from Window 1
- **Branch:** `p0-platform-customer-security-audit`
- **Base tip:** `7090873` (docs: record commit hash + review checklist)
- **Foundation commit:** `a11d265` — "P0 customer data protection foundation"
- Verified: every display / serializer / export file this window audited is **byte-identical** between
  `cfb23e3`, `a11d265`, and `7090873`. The only diffs between them are Window 1's security internals,
  which this window did **not** touch.

## 3. Vercel readiness status
**Documented and ready to configure — NOT deployed.** See
[VERCEL_DEMO_CHECKLIST.md](VERCEL_DEMO_CHECKLIST.md). It lists required env vars (`NEXT_PUBLIC_FIREBASE_*`,
`PLATFORM_OWNER_EMAILS` / `NEXT_PUBLIC_PLATFORM_OWNER_EMAILS` = `djsanti88@gmail.com`,
`NEXT_PUBLIC_FIREBASE_BACKEND=1`), the rule that no `NEXT_PUBLIC_E2E_*` bypass vars may exist in a deployed
env, Admin-credential strategy, demo-account + no-public-signup rules, post-deploy smoke list, and rollback.
The app **builds** for production (`next build` exit 0).

## 4. Admin credential blocker status — **OPEN (ops, expected)**
`/api/resolve-scan` ([route.ts](../../src/app/api/resolve-scan/route.ts)) needs Firebase Admin credentials
at runtime. Without them it returns `503 { reason: "server_resolution_unavailable" }` and the client falls
back gracefully (no crash, no leak). Supported credential inputs today: `FIREBASE_SERVICE_ACCOUNT_PATH`
(local gitignored JSON path) or `GOOGLE_APPLICATION_CREDENTIALS` (ADC), or the emulator.
**Vercel gap:** serverless has no committed secret file. Recommended paths (ops decision, see checklist §2):
(A) a small code addition to accept `FIREBASE_SERVICE_ACCOUNT_JSON` and write it to `/tmp` — **out of this
window's scope** (touches server credential logic; Window 1 / Santiago + SecurityLeakBot re-run); or
(B) run the controlled demo platformOwner-driven and rely on the graceful 503 fallback for customer scans.

## 5. Firebase Auth domain checklist
Add the exact Vercel domain(s) (preview + production) under **Firebase Console → Authentication → Settings
→ Authorized domains**, or sign-in fails with `auth/unauthorized-domain`. Detailed in checklist §3.

## 6. Demo account checklist
- platformOwner: `djsanti88@gmail.com` (must match `PLATFORM_OWNER_EMAILS`).
- Customer demo account: separate, non-owner, member of one demo business with **fake seed data only**.
- **No public signup**; create accounts manually. **No real customer data.** Controlled/private URL only.

## 7. Part number audit result
Full audit: [PART_NUMBER_DISPLAY_AUDIT.md](PART_NUMBER_DISPLAY_AUDIT.md). Key results:
- The canonical part-number field is **`Product.primarySku`** — there is **no** separate `partNumber` /
  `manufacturerPartNumber` field. `primarySku` is customer-safe (not denylisted).
- **Already correct before this window:** Final Count table, Products table, customer CSV exports
  (`part_number` column), and the `/api/resolve-scan` customer response (`partNumber`) — all show the part
  number to customers and hide barcode/UPC/EAN/GTIN/aliases/raw codes.
- **Two gaps found & fixed by this window** (see §8).
- Deliberately left as-is (unconfirmed suggestions): Needs Review rows and the unknowns export.

## 8. Part number fixes made
Two small, customer-safe, non-conflicting UI fixes (no Window 1 security file touched):
1. **[LiveScanFeed.tsx](../../src/components/LiveScanFeed.tsx)** — added a **"Part number"** column
   (`primarySku`, `"Part number missing"` fallback, never a code) to the live scan feed / scan result.
2. **[ScannerInput.tsx](../../src/components/ScannerInput.tsx)** — the scan **confirmation line** previously
   showed the **denylisted `cleanCode`** + internal `matchType` to customers. Now role-aware: customers see
   *"Counted: &lt;product name&gt; (part no. &lt;primarySku&gt;). New quantity N."* (code-free); platformOwner
   keeps the technical detail. **This was a real customer-facing leak SecurityLeakBot missed** because it
   never performs a scan; this window's adversarial proof spec caught it.

## 9. Files changed
**Code (3, +39/−9 vs `7090873`):**
- `src/components/LiveScanFeed.tsx`
- `src/components/ScannerInput.tsx`
- `package.json` (added one script: `qa:weekly-report`)

**New docs / proof (this window):**
- `reports/demo-readiness/VERCEL_DEMO_CHECKLIST.md`
- `reports/demo-readiness/PART_NUMBER_DISPLAY_AUDIT.md`
- `reports/demo-readiness/CONTROLLED_DEMO_SCRIPT.md`
- `reports/demo-readiness/WINDOW2_FINAL_REPORT.md` (this file)
- `docs/SCHEDULED_QA_BOTS.md`
- `e2e/human-bots/scenarios/partnumber-display.spec.ts` (proof spec)
- `e2e/proof/demo-readiness/01..03-*.png` (screenshots)

**Auto-regenerated by running the verification bots** (not hand-edited): `reports/agent-bots/latest/*`,
`reports/human-bots/*` (the bots rewrite their own report/screenshot outputs on each run). `security_findings.json`
remains `{ "findings": [] }`.

## 10. Demo script path
[reports/demo-readiness/CONTROLLED_DEMO_SCRIPT.md](CONTROLLED_DEMO_SCRIPT.md)

## 11. Scheduled bot plan path
[docs/SCHEDULED_QA_BOTS.md](../../docs/SCHEDULED_QA_BOTS.md) + package script `qa:weekly-report`
(`qa:bots:security && qa:bots:data && qa:bots:tire && qa:bots:ux`). No GitHub Actions, no Vercel cron, no
auto-fix mode (all explicitly deferred).

## 12. Commands run (all in the isolated worktree; all PASS)
| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | exit 0 |
| `npx eslint src e2e` | exit 0 (4 pre-existing warnings, none in changed files) |
| `npx vitest run` | **394 passed**, 30 skipped, exit 0 |
| `npx next build` | exit 0 (production build OK; `/api/resolve-scan` route present) |
| `npm run qa:bots:security` | **2 passed**; `security_findings.json = { "findings": [] }` (P0:0/P1:0/P2:0) |
| `npm run qa:bots:ux` | 1 passed |
| `npx playwright test … partnumber-display` | 1 passed; 3 screenshots in `e2e/proof/demo-readiness/` |

> Proof type: **automated** (tsc/eslint/vitest/build/bots) + **visual** (screenshots) + **mocked backend**
> (bots run the in-memory mock; no real Firestore, no tokens, no network secrets). No live-cloud proof was
> run (would need Admin credentials — the documented blocker).

## 13. Safe to proceed to Vercel preview?
**Yes, with the Admin-credential caveat.** The branch builds, all gates are green, security proof is clean,
and the part number is now visible everywhere a customer needs it while raw codes stay hidden. A Vercel
**preview** is safe to configure per the checklist. Real-cloud **customer scan resolution** will return the
graceful 503 fallback until Admin credentials are configured (Option A or B in the checklist). **Still no
deploy** without `DEPLOY NOW`.

## 14. What Santiago must review in the final hour
1. Decide the Admin-credential path: (A) ops code addition for `FIREBASE_SERVICE_ACCOUNT_JSON`, or
   (B) platformOwner-driven demo with graceful 503 fallback.
2. Confirm Vercel env vars + that **no** `NEXT_PUBLIC_E2E_*` bypass vars are set in the deployed env.
3. Add the Vercel domain to Firebase **Authorized domains**.
4. Confirm public signup disabled, demo accounts created, demo catalog = **fake data only**.
5. Skim the two code diffs (`LiveScanFeed.tsx`, `ScannerInput.tsx`) — both additive/role-aware, no security
   file touched.
6. Confirm whether this branch should be **committed** (this window did **not** commit — awaiting your word).
7. Note the recommendation to extend SecurityLeakBot with a post-scan sweep (Window 1 scope).

## 15. Confirmation: NO DEPLOY
Nothing was deployed. Vercel was not touched. No `DEPLOY NOW` was given.

## 16. Confirmation: NO MERGE
Nothing was merged. The branch is unmerged and isolated in its own worktree. `main` is untouched.
No commit was made (awaiting Santiago's instruction per the commit rule).
