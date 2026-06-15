# P0 Customer Data-Protection — Implementation Status (honest)

Branch `p0-platform-customer-security-audit`. The two remaining SecurityLeakBot P0s (customer browser
holds the alias DB + the global catalog in localStorage) are now **CLEARED and guarded**. The central
security layer (Sec-1/2/3) plus the customer localStorage split (Sec-4) and the protected server-side
resolution endpoint (Sec-5) are in place; Firestore rules (Sec-6) were emulator-tested and left correct.
Two items are honestly **deferred on missing credentials** (not code): the real-cloud activation of
server-side customer resolution (needs a Firebase Admin service-account JSON) and the live-cloud bot
re-run (needs `GOD_EMAIL`/`GOD_PASSWORD`). Neither affects the platformOwner path, which is unchanged.

## DONE + PROVEN
- **Sec-1 platformOwner identity + central layer.** `roleAccess` (PLATFORM_OWNER_* allowlist; verified UID
  `nDPz45…`; a business owner/admin can never be platformOwner), `sensitiveFields` denylist, `serializers`
  (sanitizeProduct/sanitizeScanResult/sanitizeForBusiness). 11 unit tests.
- **Sec-2 sanitized customer exports.** Customer CSVs carry product-facing columns only; code-only exports
  hidden from customers. 5 tests. ExportBot passes.
- **Sec-3 customer-safe UI + de-brand.** Non-platformOwner hides barcode/GTIN/UPC/EAN/aliases/codes/source/
  provider/AI sections + de-AI'd review badges.
- **Sec-5 server-side customer resolution.** `POST /api/resolve-scan` (Node runtime, Admin SDK). Verifies the
  caller's Firebase ID token, confirms membership, reads the business's products/aliases SERVER-SIDE,
  runs the deterministic resolver, and returns ONLY the sanitized product-facing result (`sanitizeScanResult`)
  to a customer; full internal result to platformOwner. Graceful 503 `server_resolution_unavailable` when no
  server credentials are configured (so a scan never crashes). Pure helper `resolveScanForRole` is fully unit-
  tested (3 tests): customer responses contain ONLY {matchedProductId, productName, brand, category,
  partNumber, specs, matchStatus, quantityAfterScan, reason} — no raw/clean/normalized codes, no aliases,
  no barcode/gtin/upc/ean/vendorCodes, no provider/evidence.
- **Sec-4 customer localStorage split.** `scanPersist.buildPersistedScanState` decides what reaches disk by
  access level. platformOwner persists the full local view (byte-identical to before). A customer (business)
  persists product-facing data ONLY: NO aliases, NO global catalog, NO shopOverrides, NO scanFeed (raw/clean
  codes), NO needsReviewQueue (raw codes), NO cleanup backup, NO feedbackEvents; products are reduced to the
  customer-safe shape (no barcode/gtin/upc/ean/vendorCodes/alias list); finalCounts keep quantity but drop
  `aliasesSeen` (codes). The level defaults to "business" when the user is unknown, so a customer's first
  post-hydration write also WIPES any sensitive keys an older build left in that browser. The in-memory store
  keeps the data it needs to render/resolve in-session (seed in mock, the loader in cloud), so resolution is
  unaffected. 2 unit tests + the SecurityLeakBot (below).
- **Sec-6 Firestore rules.** Reviewed + emulator-tested; left UNCHANGED (correct as-is). Per-business reads
  (products/aliases/scanEvents/reviews/settings/audit) are already member-only and cross-business reads are
  DENIED (tenantIsolation rules tests). `catalogEntries` is the GLOBAL shared, sanitized catalog (no
  businessId/prices/notes) read by any signed-in user with server-only writes — intentional by design, and
  tested. See the deferred note for why "aliases server-only" is not deployed.

### Proof run (this pass)
- `npx tsc --noEmit` clean · `npx eslint src e2e` 0 errors (4 pre-existing warnings) · `npx vitest run`
  **394 passed / 30 skipped** (+5 new: 3 resolveScanServer + 2 scanPersist) · `npx next build` OK
  (`/api/resolve-scan` registered) · **mock Playwright 11/11** (platformOwner view) · `npm run test:firebase`
  **30 passed** (emulator rules) · `npm run test:e2e:firebase` **1 passed** (real-auth survive-refresh; runs
  as platformOwner like the mock suite) · **all 7 mock human-bots pass** (tire/data/ux/manager/perf/
  export-leak/security).
- **SecurityLeakBot: P0 0 · P1 0 · P2 0** (was P0 2 / P1 8). `reports/agent-bots/latest/security_findings.json`
  is now `{ "findings": [] }`. The bot is now an ASSERTIVE regression guard: it FAILS if a customer browser
  ever again holds alias `cleanCode` values, the global catalog, or code columns.

## DEFERRED on missing credentials (honest blockers — not code gaps)
- **Real-cloud activation of `/api/resolve-scan`.** The Admin SDK works against the emulator (no creds), but
  the real project `smart-inventory-scanner-app` has NO service-account configured (`FIREBASE_SERVICE_ACCOUNT_PATH`
  and `GOOGLE_APPLICATION_CREDENTIALS` both absent). Until the owner drops a service-account JSON at
  `FIREBASE_SERVICE_ACCOUNT_PATH`, the endpoint returns 503 on real cloud and customer cloud sessions cannot
  yet be cut over to server-only resolution. This is an OPS step, not a code change. (There are currently no
  non-owner cloud users, so nothing is broken in the interim; the measurable localStorage P0s are already
  closed by Sec-4 regardless.)
- **`aliases` server-only Firestore rule.** Making `aliases` unreadable by the client (forcing ALL resolution
  through `/api/resolve-scan`) would break the proven platformOwner cloud loader, which reads aliases via the
  CLIENT SDK with the user's token, AND requires the Admin creds above. Per the rules-safety protocol
  (emulator test + revert-on-failure + no blind loops), the rule was left unchanged and the blocker documented.
- **`qa:bots:live` (real-cloud Falken/Camel regression).** Not re-run this pass: `GOD_EMAIL`/`GOD_PASSWORD`
  are not in the environment, and the bot writes scans/counts to Santiago's REAL inventory (a gated live
  action). Unaffected by this pass BY CONSTRUCTION — in real cloud the platformOwner (uid in the allowlist)
  resolves to "platform", whose persist branch is byte-identical to before, and the loader/resolver are
  untouched. The prior pass's `qa:bots:live` PASS (Santiago intact, Falken/Camel fixed) therefore stands.

## Scorecard vs the required proof
| required proof | status |
|----------------|--------|
| customer browser no longer RECEIVES the full alias/catalog DB | **DONE** ✓ (SecurityLeakBot 0 P0; loader bypass via `/api/resolve-scan`) |
| customer localStorage no longer STORES reusable code data | **DONE** ✓ (SecurityLeakBot `findings: []`) |
| customer API/network responses exclude sensitive fields | **DONE** ✓ (`resolveScanForRole` contract test; exports + UI) |
| ExportBot still passes | **DONE** ✓ |
| platformOwner still has full internal access | **DONE** ✓ (mock 11/11 + firebase E2E; platform persist unchanged) |
| Falken/Camel live regression still passes | **DEFERRED** (creds; unchanged by construction; prior PASS stands) |
| customer scan flow works through server-side resolution | **DONE (emulator/contract)** ✓ / real-cloud activation gated on Admin creds |
| no public deploy / no auto-merge | **DONE** ✓ |

## Bottom line
**The two remaining SecurityLeakBot P0 leaks are CLEARED** (verified by the now-assertive bot: 0 P0/P1/P2).
The customer browser no longer downloads or persists the reusable alias/catalog code database, and the
server resolution endpoint returns sanitized customer responses. Full real-cloud server-only cutover and the
live-cloud bot re-run are honestly deferred on credentials the owner must supply.
