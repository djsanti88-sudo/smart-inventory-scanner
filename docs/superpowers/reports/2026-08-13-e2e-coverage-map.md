# E2E Coverage Map (2026-08-13)

Scope: `e2e/*.spec.ts` (mock suite, port 3100), `e2e/human-bots/scenarios/*.spec.ts` (customer/bot
suite, port 3300), `e2e/firebase-phase2/firebase-flow.spec.ts` (real Firebase emulator, port 3200),
`e2e/boss-barcode-corpus/local-corpus-ui.spec.ts` and `e2e/boss-barcode-preview/boss-preview.spec.mts`
(private-corpus-gated, skip unless `BOSS_RECONCILIATION_PATH`/preview env vars are set).

`playwright.config.ts` `testIgnore`: `**/firebase-phase2/**`, `**/human-bots/**`,
`**/household-decode-test.spec.ts`, `**/seed.spec.ts` — none of those four run in the default mock
suite. `household-decode-test.spec.ts` hardcodes a live external Vercel URL (real AI decode, not
mocked) — it is a manual live-probe script, never part of CI. `seed.spec.ts` is a Playwright
scaffold stub with **zero assertions** (`// generate code here.`) — dead weight, not coverage.
`playwright.bots.config.ts` also excludes `**/cloud/**` (live-cloud bots run separately).

## 1. Spec inventory (one line each)

### `e2e/` root (mock suite, port 3100)

| Spec | Journey actually asserted |
|---|---|
| `a11y.spec.ts` | axe-core scan of `/` fails on critical/serious WCAG violations only |
| `auto-count-tire.spec.ts` | corroborated tire auto-counts on scan; poisoned go-upc source stays provisional + routes to Needs Review with category-conflict reason |
| `auto-decode.spec.ts` | aggressive auto-decode: verified auto-adds, weak "suggested" still counts, conflict shows "Suggested" label + stays in review; re-scan is deterministic (no new AI call) |
| `auto-verify.spec.ts` | strong evidence auto-verifies + counts with one decode call; re-scan makes zero new calls; weak/no-evidence goes to Needs Review |
| `batch-approve.spec.ts` | 6 suggested unknowns batch-selected and approved once, all 6 counts land exactly once; a retried `batchApprove` call is a no-op (idempotent) |
| `camera-scan.spec.ts` | camera overlay opens via fake media stream, shows video, closes, refocuses scanner input |
| `cleanup.spec.ts` | decode-budget setting persists across reload; junk-name cleanup review/backup/remove/Undo round-trip |
| `count-always.spec.ts` | 6 unknown codes with AI off: feed rows == final-count rows == 6 (scan N = count N) |
| `cross-identifier.spec.ts` | decoded tire surfaces a "discovered" extra part number; one-click approve; scanning the part number then counts the SAME product (qty 1→2, no duplicate row) |
| `decode.spec.ts` | four mocked decode statuses (verified/suggested/conflict/vendor-label) render correct trust badges in Needs Review; human approves verified → alias created; re-scan deterministic, zero new AI calls |
| `decode-diagnostics-open-web-fallback.spec.ts` | fast-path found (1 POST), open-web-fallback found product counts, rate-limit shows honest "rate-limited" reason, truly-unlisted shows "no product matched" only after search |
| `delete-product.spec.ts` | delete a product row (confirm dialog) → row gone + Undo banner → Undo restores it exactly |
| `export-menu.spec.ts` | unified Export menu produces real CSV/XLSX/PDF/interactive-HTML downloads with non-trivial size; HTML file renders standalone with working search |
| `fetchv2-count-contract.spec.ts` | count-first contract: unknown×5, URL×3, known×5, canary×1 = 14 rows, all counted, zero AI calls |
| `firewall.spec.ts` | poisoned non-tire evidence in Tire context still counts provisionally but never auto-verifies; stays open in Needs Review with category-conflict reason |
| `goupc-ladder.spec.ts` | 4 sub-tests: Go-UPC exact hit auto-counts as "Suggested (DB)"; inferred hit → Needs Review; cap-reached shows honest usage-limit reason (never leaks vendor name); all-providers-500 still counts provisionally and survives reload |
| `gpt-ladder-burst.spec.ts` | 20 rapid unknown scans: all 20 feed rows appear instantly (count-first), decode queue caps at 2-in-flight, a mid-burst 500 doesn't wedge the queue, all 20 eventually settle "Suggested (AI)" |
| `history.spec.ts` | two scans → History nav → session row shows units/products count → click opens session detail page with a search input + table |
| `household-decode-test.spec.ts` | **excluded from mock runs** — live external target (`smart-inventory-test.vercel.app`), real AI decode timing, DB-vs-AI-decode barcode lists |
| `identifier-backfill.spec.ts` | platform-only tool fills a barcode field parsed from a legacy product's name; reversible via Undo |
| `ledger-markwrong.spec.ts` | markWrong on a verified-known product AND on a bare provisional both keep total counted quantity invariant (desktop + 390px phone); DOM shows the transfer to a fresh "Unidentified" row, never a deleted count |
| `p2-accounts.spec.ts` | login page shows email/Google/reset controls; sign-out clears in-memory state AND deletes the per-uid localStorage key (persists past one coalesce tick); default owner-PIN policy is confirm-only |
| `persist-indexeddb.spec.ts` | scans persist to IndexedDB (not localStorage) and survive reload; a legacy localStorage blob copy-then-clear migrates into IDB on load |
| `phase1-benchmark.spec.ts` | representative decode-benchmark UI proof: fast path, open-web fallback, catalog-cache re-scan (zero new POST), honest rate-limit reason, honest not-found reason |
| `phase3-location-moat.spec.ts` | scan-page auto-starts a session; typed location becomes a "recent" + shows a moat line; renders without horizontal overflow at 390px |
| `phase4-fuzzy-reconcile.spec.ts` | fuzzy CSV import match stays unconfirmed (0 aliases approved, 0 counted) until a human clicks "approve suggestion"; then alias approved + quantity counted |
| `phase4-universal-import.spec.ts` | TSV upload → preview headline "Matched 1 of 2" → apply → imported quantity reaches the Boss Report total (desktop + phone) |
| `polish-filter.spec.ts` | 3 tire scans auto-count with structured Brand/Model/Size columns; the polish-filter input narrows to an exact-size match (1 row) and a shared size-prefix (2 rows); clearing restores all 3 |
| `product-purge.spec.ts` | a poisoned v4 localStorage cache auto-purges to clean seed data on load via the persist-version migration (no Manstel rows anywhere) |
| `reconcile.spec.ts` | Shop-Ware CSV reconcile against the real local tire corpus: scanned+matched row lands in "agreement", matched-but-unscanned row lands in "expected_not_counted" (never variance); CSV export works |
| `resolver.spec.ts` | 3 formerly-poisoned codes never resolve to a wrong product with AI fully off; each counts as "Unidentified item" and sits in Needs Review; human link-to-product approval makes the code deterministic (no AI ever called) |
| `scan.spec.ts` | full serial flow: login → 9-code sequence groups into 3 known products + 2 raw unknowns, zero AI calls; CSV export; simulated sync failure shows "pending", retry drains queue without doubling; unknown code resolved via link-existing teaches an alias, re-scan is deterministic |
| `scan-category.spec.ts` | the category selector/warning banner are confirmed hidden (feature flag off); a known non-tire alias still counts normally regardless |
| `scanner-focus.spec.ts` | no Clear-Cache control on Scan page (so scanner Enter can't trigger a dialog); input stays focused through 3 scans and 2 Enters, zero dialogs; first-run banner shows pre-scan, never steals focus, disappears after first scan |
| `seed.spec.ts` | **excluded from mock runs** — empty Playwright-agents scaffold stub, no assertions |
| `suggested-decode.spec.ts` | confidence-0.92 suggestion auto-applies + tags "unconfirmed" and auto-closes the review (no open badge); low-confidence (0.3) suggestion shows inline approve/decline controls (pointer-only, tabindex -1) — approve clears tag + keeps focus + rescan is deterministic; decline renames to a safe prefix-floor placeholder and ONLY THEN opens a review |
| `tire-fields.spec.ts` | decoded tire fills Size/Brand/Part-number into separate structured columns with a cleaned name (not a raw blob); a tire with no SKU shows "-" (never a fabricated part number) |
| `trust-gate-law.spec.ts` | TOP-LEVEL LAW proof: a random undecodable code, a bad-check-digit GTIN, and 10× the same unknown code each appear on the feed AND count (10 scans → 1 row, qty 10) |
| `variance-report.spec.ts` | save two count snapshots ("Before"/"After") after changing counts, compare shows +1/-1 deltas correctly; CSV export works |
| `verified-decode-not-unknown.spec.ts` | single-provider Tier-3 (barcode-DB) verified decode shows the real product name and counts (regression guard vs. the old "Verified AI Decode + Product '-' + Unknown" bug); exact-evidence-but-no-name case routes to Needs Review with an explicit "no usable product identity" reason |

### `e2e/human-bots/scenarios/` (customer/bot suite, port 3300, `testIgnore: **/cloud/**`)

| Spec | Journey actually asserted |
|---|---|
| `customer-clean-names.spec.ts` | Counts view shows a clean "Brand Model Size" name for a customer, never the raw stored name with UPC prefix / "Fits:" fitment clause |
| `customer-readable-controls.spec.ts` | every Needs-Review and Counts-table action control is >= 44px tall (touch-target minimum) |
| `customer-review-persistence.spec.ts` | 3 unknown scans land in Needs Review; a FULL page reload preserves all 3 rows + the badge count; approve-after-reload still counts the item |
| `customer-settings-plain.spec.ts` | customer Settings body contains none of a denylist of engineer jargon ("idempotent", "Debounce", "Business ID", provider names, etc.) |
| `data-integrity.spec.ts` | two scans of one code → qty exactly 2 (no accidental double); count survives refresh; an unknown scan never merges into an existing named product's count |
| `export-leak.spec.ts` | report-only: captures the CSV header row of every export button and flags which contain raw/internal code fields (writes a markdown report, does not gate on it) |
| `manager-workflow.spec.ts` | report-only: checks which manager-expected UI pieces are present vs. absent (live feed, final count, sessions, exports, review queue, products) and lists known-missing features |
| `partnumber-display.spec.ts` | customer sees SKU + the just-scanned barcode in the Live Scan Feed, but the Products page catalog view never shows the raw barcode; holds at 390px mobile too |
| `performance-smoke.spec.ts` | report-only smoke: page-load ms, scan-to-feed-row ms, localStorage payload bytes against soft budgets (WARN, not FAIL, on breach) |
| `platformOwner-tire-resolution.spec.ts` | a Falken part number in every separator shape (dashed/no-dash/space/slash) must never resolve to an unrelated "Camel" product; hard assertion + JSON proof artifact |
| `role-security-leak.spec.ts` | customer browser's localStorage holds zero reusable `aliases`/`catalog` entries; sweeps `/products`,`/review`,`/settings` for leaked provider/internal terms and raw code columns (hard P0 assertions + report) |
| `ux-no-training.spec.ts` | report-only usability scorecard: discoverability of scan input, feedback, counts, session start/finish, export, Needs Review, at desktop and 390px |

### `e2e/firebase-phase2/` (Firebase emulator suite, port 3200 — excluded from mock config)

| Spec | Journey actually asserted |
|---|---|
| `firebase-flow.spec.ts` | real Auth-emulator sign-in through the login UI → start session → known scan + alias scan groups to one product (qty 2) → unknown scan → approve as new product → rescan deterministic → **full page reload rehydrates from Firestore** (counts not doubled, learned product persists, scan feed rebuilt, scanner refocuses) → History/session-detail timeline survives reload → finish session → CSV export; asserts via Admin SDK directly against emulator collections (counts, aliases, products, sessions, audit log) that persistence is genuine, not just UI-shaped; asserts no live/paid provider ever reported `status: "ok"` |

### `e2e/boss-barcode-corpus/` and `e2e/boss-barcode-preview/` (private-corpus-gated, `test.skip` unless env vars set)

| Spec | Journey actually asserted |
|---|---|
| `local-corpus-ui.spec.ts` | trusted-exact barcode burst against a real (non-committed) corpus: settlement latency gates, no transient wrong-status flash, Firestore settlement via Admin SDK, external-egress blocking |
| `boss-preview.spec.mts` | multi-lane exhaustive trusted-exact certification against a real Preview deployment: latency gates, cross-tenant/unauthenticated 401/403 probes, Firestore persistence, no forbidden UI states |

## 2. A-H coverage verdict

| # | Scenario | Verdict | Detail |
|---|---|---|---|
| A1 | Approved-alias hit | **COVERED** | `scan.spec.ts` (repeated codes group to seeded products), `resolver.spec.ts` (re-scan after approval is deterministic, qty increments, zero AI) |
| A2 | Verified-product identifier hit (barcode/sku/gtin/upc/ean) | **COVERED** | `scan.spec.ts` multi-code grouping; `cross-identifier.spec.ts` approved part-number counts same product as the UPC |
| A3 | Corpus/catalog hit | **COVERED** | `verified-decode-not-unknown.spec.ts` (Tier-3 barcode-DB, single-provider, app-confirmed exact evidence → shows product + counts, catalog remembers it); `phase1-benchmark.spec.ts` (client-catalog cache re-scan, zero new POST); `reconcile.spec.ts` (real local tire corpus match) |
| A4 | AI "suggested" (review-first, not auto-counted) | **PARTIAL / label has moved** | The *original* review-first suggested tier no longer exists as designed — Plan C (2026-07-14/20 owner rulings) collapsed it: `auto-decode.spec.ts` and `suggested-decode.spec.ts` prove a weak/low-confidence suggestion **still auto-counts provisionally** and only *high*-confidence (>=0.8) suggestions auto-apply + auto-close the review; genuinely low-confidence ones get inline approve/decline, not a blocking Needs-Review wall. No spec proves a suggestion tier that blocks counting until human review — because that tier is intentionally gone. Flag this to the writer: don't write a test asserting the old "suggested = blocked pending review" behavior; it would fail by design. |
| A5 | AI verified auto-count | **COVERED** | `auto-decode.spec.ts`, `auto-verify.spec.ts`, `auto-count-tire.spec.ts`, `cross-identifier.spec.ts`, `verified-decode-not-unknown.spec.ts` |
| A6 | Conflict (one code → multiple products) routed to Needs Review | **COVERED (label collapsed)** | `auto-decode.spec.ts` and `decode.spec.ts` both scan a 2-provider-conflict code; it stays open in Needs Review, but the UI label is the same neutral "Suggested" as every other non-verified state (Plan C Task 1) — no spec independently distinguishes "conflict" reasoning from "suggested" reasoning at the UI level beyond the review-row text |
| A7 | vendor_label / X00 / FNSKU routed to Needs Review | **COVERED** | `decode.spec.ts` (X004DY7YUT Amazon FBA label), `resolver.spec.ts` (same code, explains itself as "label") |
| A8 | Totally unknown code | **COVERED** | `count-always.spec.ts`, `trust-gate-law.spec.ts`, `fetchv2-count-contract.spec.ts` |
| B | TOP-LEVEL LAW: scan dozens of MIXED tiers, feed=N and total=N | **PARTIAL** | Closest specs: `fetchv2-count-contract.spec.ts` (14 scans: unknown×5 + URL×3 + known×5 + canary×1, all counted, AI off) and `gpt-ladder-burst.spec.ts` (20 unknowns, AI on, burst timing). Neither mixes in a genuinely gate-rejected code (bad-check-digit GTIN), a vendor-label/X00 code, AND an AI-verified code AND an AI-conflict code all in the SAME run with an assertion of `feed rows == N == session total`. `trust-gate-law.spec.ts` proves gate-rejected codes count but only 2 codes, not "dozens." **No single spec proves the full mixed-tier law at scale.** |
| C1 | Session persistence: scanFeed/finalCounts/needsReviewQueue/pendingSyncQueue/synced-ids survive reload | **COVERED for the visible pieces** | `persist-indexeddb.spec.ts` (scanFeed via IDB), `customer-review-persistence.spec.ts` (needsReviewQueue + badge), `data-integrity.spec.ts` (finalCounts), `scan.spec.ts` pending-sync toggle (no direct reload+pendingSyncQueue-survives assertion though) |
| C2 | IndexedDB migration path (localStorage → IDB, copy-then-clear) | **COVERED** | `persist-indexeddb.spec.ts` second test explicitly seeds a legacy localStorage blob, wipes IDB, reloads, asserts state came from the legacy blob, copied into IDB, and the legacy key cleared AFTER the copy |
| C3 | Recovery from a corrupted/partial IndexedDB | **NOT COVERED** | No spec writes malformed/partial IDB content and asserts graceful fallback or recovery. `product-purge.spec.ts` covers a corrupted-shape *localStorage* v4 cache being purged via persist-version migration, but never touches IDB corruption |
| D | Needs Review resolution: approve teaches a permanent alias, row leaves queue instantly, count MOVES not duplicates | **COVERED** | `scan.spec.ts`, `resolver.spec.ts`, `firebase-flow.spec.ts` all show link-existing/create-new removing the row immediately and a re-scan resolving deterministically with the count incrementing (never duplicating) |
| E | Mark Wrong: quantity TRANSFERS to a fresh provisional, never deleted, totals unchanged | **COVERED, thoroughly** | `ledger-markwrong.spec.ts` covers both a verified-known product and a bare provisional, at desktop AND 390px, with both store-level and DOM-level invariant assertions — this is the strongest-covered scenario in the whole suite |
| F1 | Offline → reconnect → retry, no double count, no lost scan | **PARTIAL** | `scan.spec.ts` toggles a mock "sync failure" flag (not real `page.context().setOffline(true)`/navigator.onLine), scans while "failing," sees pending-warning, then retries and confirms the queue drains and qty is not doubled. No spec uses genuine network-offline simulation |
| F2 | Repeated retries of the SAME scan never increment | **PARTIAL** | Implied by the retry-sync UI test in `scan.spec.ts` (qty stays 4 across retries) and by `batch-approve.spec.ts`'s explicit re-approve-is-a-no-op assertion at the store level, but no spec directly re-submits the identical idempotencyKey multiple times via the sync layer and asserts zero growth each time |
| G1 | Final counts screen matches the ledger | **PARTIAL** | Every export spec proves a *file downloads* with the right name/size, but only `phase4-universal-import.spec.ts` (report total > 0) and `firebase-flow.spec.ts` (Admin SDK count assertions) actually cross-check counted quantity against a second source of truth. No spec parses an exported CSV's row values and diffs them against `finalCounts` in the store |
| G2 | CSV export contents correct and free of private fields | **PARTIAL** | `export-leak.spec.ts` (human-bots) inspects export **headers only** for code-bearing fields and is **report-only** (writes markdown, does not fail the run on a leak) — not a hard gate. `role-security-leak.spec.ts` hard-asserts localStorage/UI leaks but not export *file* contents. No spec parses full CSV row contents (not just headers) for price/cost/PII |
| H | Duplicate scans increment quantity, never duplicate rows | **COVERED** | `scan.spec.ts`, `trust-gate-law.spec.ts` (scan10=count10), `fetchv2-count-contract.spec.ts` (5x known), `cross-identifier.spec.ts`, `ledger-markwrong.spec.ts` |

## 3. Ranked list of missing scenarios worth writing

1. **Full mixed-tier TOP-LEVEL LAW at scale (dozens of codes, every tier in one run).**
   Assertions: scan ~30-40 codes covering every tier in the same session — approved alias, verified
   catalog hit, AI-verified auto-count, AI-suggested (low-confidence), conflict, vendor-label/X00,
   bad-check-digit GTIN (gate-rejected), and totally-unknown gibberish — then assert
   `scan-feed-body tr count === N` AND `sum of all final-count-body qty cells === N` in one shot, plus
   spot-check that each tier landed with its correct label/route. Best template: `fetchv2-count-contract.spec.ts`
   (already builds a multi-tier code list and sums counts) combined with `decode.spec.ts`'s per-code mocked
   decode-response map and `trust-gate-law.spec.ts`'s gate-rejected codes.

2. **Corrupted/partial IndexedDB recovery.**
   Assertions: seed a malformed value under the `sis-persist`/`kv`/`sis-scan-v1` key (truncated JSON,
   wrong schema version, or a value that throws on `JSON.parse`), reload, and assert the app does not
   crash/white-screen — it either falls back to a clean seed state (like the localStorage v4-purge
   case) or surfaces a recoverable error, and the scanner input is still usable afterward. Template:
   `persist-indexeddb.spec.ts` for the raw-IDB read/write helpers + `product-purge.spec.ts` for the
   "corrupted cache auto-purges to clean seed" assertion pattern (same idea, IDB instead of localStorage).

3. **Real offline/reconnect using Playwright's actual network-offline API.**
   Assertions: `await page.context().setOffline(true)`, scan several codes, assert they still appear
   in the feed and count locally (never blocked on network), assert "pending"/"saved locally, not
   synced yet" messaging, then `setOffline(false)` and assert the queue auto-drains on reconnect (not
   just via a manual Retry click) with no double-count. Template: `scan.spec.ts`'s existing pending-sync
   section (steps 6-7), swapping the mock `toggle-sync-failure` checkbox for genuine `setOffline`.

4. **Idempotency: repeated retry of the identical scan event/idempotencyKey never grows the count.**
   Assertions: capture a scan's `idempotencyKey` via `window.__scanStore`, manually re-drive the same
   sync operation 3-5 times (simulating a flaky-network retry storm), and assert `finalCounts` quantity
   and `scanEventIds`/`appliedIdempotencyKeys` length are unchanged after the first successful apply.
   Template: `batch-approve.spec.ts`'s store-handle re-invocation pattern (`page.evaluate` calling a
   store method twice and diffing snapshots) plus `ledger-markwrong.spec.ts`'s `totalCounted()` helper.

5. **Export CSV row-content correctness against the store (not just headers/filenames).**
   Assertions: seed known quantities, export final-counts CSV, read the downloaded file's actual rows
   (not just the header), and diff parsed quantities/product names 1:1 against
   `window.__scanStore.getState().finalCounts` — plus assert no price/cost/customer-PII column ever
   appears. Template: `export-menu.spec.ts` (already downloads+opens files) combined with
   `export-leak.spec.ts`'s header-scan idea, but turned into a hard-failing assertion instead of a
   report-only bot, and extended from headers to parsed row values.

6. **Conflict vs. generic-suggested distinguished at the data layer, not just the collapsed UI label.**
   Assertions: since the UI intentionally shows one neutral "Suggested" label for both conflict and
   weak-suggestion cases (Plan C), add a spec-level check (via `window.__scanStore` or the review row's
   reason text/testid) that a genuine multi-provider conflict still carries a distinguishable reason
   string internally, so a future accidental merge of the two code paths would be caught even though the
   badge text is deliberately the same. Template: `decode.spec.ts`'s existing conflict fixture + reading
   `review.reason` the way `goupc-ladder.spec.ts` scenario 3 reads the honest cap-reason text.

7. **Vendor-label / X00 / FNSKU as part of the mixed-tier burst (currently only tested in isolation).**
   Folds into item 1 above but call out separately if item 1 is judged too large: a burst spec that
   scans several distinct vendor-label-shaped codes (not just one) alongside normal codes and confirms
   each still counts as its own row and none gets merged into an unrelated named product's count
   (echoes `data-integrity.spec.ts`'s "never merges into an existing named product" check, at vendor-label
   scale). Template: `data-integrity.spec.ts` + `decode.spec.ts`'s `X004DY7YUT` fixture.
