# P0 Customer Data-Protection — Implementation Status (honest)

Branch `p0-platform-customer-security-audit`. This pass delivered the **central security layer + the
"data already in the browser is now sanitized/hidden" half** (Sec-1/2/3, complete + proven). The
**"stop the browser from receiving/persisting the DB" half** (Sec-4/5/6 — the architecture cutover)
is **NOT done** and is honestly scoped below. The full P0 is therefore **NOT yet closed.**

## DONE + PROVEN
- **Sec-1 platformOwner identity + central layer.** `roleAccess` (PLATFORM_OWNER_EMAILS/UIDS allowlist;
  verified UID `nDPz45…`; a business owner/admin can never be platformOwner), `sensitiveFields` denylist,
  `serializers` (sanitizeProduct/sanitizeScanResult/sanitizeForBusiness). 11 unit tests.
- **Sec-2 sanitized customer exports.** Customer CSVs (final counts / qty adjustments / unknowns) carry
  product-facing columns only; code-only exports (aliases/products/raw-log/pending) hidden from customers. 5 tests.
- **Sec-3 customer-safe UI + de-brand.** For non-platformOwner: Products hides barcode/GTIN/UPC/EAN/aliases/
  Codes/source; FinalCount/LiveScanFeed/NeedsReview hide raw/clean/code/provider/evidence/source; Settings
  hides AI/provider/catalog sections; Scan page hides the AI status block; review badges/Live-decode de-AI'd.

### Proof run
tsc clean · eslint 0 errors · vitest **389 passed / 30 skipped** · build OK · **mock Playwright 11/11**
(platformOwner view preserved via NEXT_PUBLIC_E2E_PLATFORM_OWNER) · `qa:bots:tire` PASS · `qa:bots:data`
PASS · `qa:bots:ux` PASS · `qa:bots:security` PASS (report-only) · **`qa:bots:live` PASS** (Santiago/
platformOwner intact, Falken/Camel still fixed). SecurityLeakBot: the **Products code-columns + AI/provider
UI findings are eliminated** for customers (P0 3→2, P1 12→8); ExportBot: customer exports carry no code fields.

## NOT DONE (the remaining P0 cutover — needs its own focused pass)
- **Sec-4 customer loader + localStorage.** `businessDataLoader` still loads the full `aliases` table +
  product code fields into the browser, and `scanStore` persist still writes `aliases`/`products` to
  localStorage. So a customer browser **still downloads + persists the reusable code DB** (2 P0 in the
  SecurityLeakBot report).
- **Sec-5 `/api/resolve-scan` server-side customer resolution.** Not built. Customer scanning still resolves
  client-side, which is *why* the alias DB must currently reach the browser. This is the largest, riskiest
  piece (must keep platformOwner local flow + offline-queue + no-double-count + tire/live regression intact).
- **Sec-6 Firestore rule hardening.** `firestore.rules` unchanged: `aliases` still member-readable and
  `catalogEntries` still any-signed-in-user readable (cross-business). Deferred per the rules-safety
  protocol (emulator tests + revert-on-failure) until Sec-4/5 land.

## Honest scorecard vs the required proof
| required proof | status |
|----------------|--------|
| customer exports exclude barcode/alias/UPC/EAN/GTIN/raw codes | **DONE** ✓ |
| customer UI hides AI/Gemini/OpenAI/Firecrawl/provider/codes | **DONE** ✓ |
| platformOwner still has full internal access | **DONE** ✓ (mock 11/11 + live bot) |
| Falken/Camel live regression still passes | **DONE** ✓ |
| no public deploy / no auto-merge | **DONE** ✓ |
| customer browser no longer RECEIVES the full alias/catalog DB | **NOT YET** (Sec-5/loader) |
| customer localStorage no longer STORES reusable code data | **NOT YET** (Sec-4) |
| customer API/network responses exclude sensitive fields | **PARTIAL** (exports+UI done; direct Firestore reads remain → Sec-5) |

## Recommended next pass (to close the P0)
Sec-5 first (build `/api/resolve-scan` using the existing pure resolver server-side via Admin SDK; customer
scanStore calls it; platformOwner keeps local). Then Sec-4 (customer loader returns product-facing only;
drop `aliases`/code fields from persist; wipe legacy sensitive localStorage on load). Then Sec-6 (Firestore
rules: `aliases`/`catalogEntries` server-only) with emulator tests + revert-on-failure. Re-run SecurityLeakBot
→ the 2 remaining localStorage/network P0 should then clear, closing the P0.
