# Data-Flow Audit — where customer browsers receive sensitive data

Read-only audit. No code changed. Goal: prove exactly how raw codes / aliases / global catalog reach a
customer browser today, and what must change. **Today there is NO platformOwner concept and NO role-based
gating** — roles are `owner | admin | counter | viewer` business memberships, and every member gets the
same data. So "customer" below = every non-Santiago user.

## 1. Sensitive fields that currently reach the customer browser
From `businessDataLoader.loadBusinessData` (client Firebase SDK) → the Zustand store:
- **Products** (`toStoreProduct`): `primaryBarcode, gtin, upc, ean, aliases[], vendorCodes[]` (+ safe name/brand/category/specs).
- **Aliases** (`toStoreAlias`): the **entire alias table** — `cleanCode, normalizedCode, rawCodeExample, productId, aliasType, idempotencyKey`.
- **Counts/sessions**: `aliasesSeen[]`, `scanEventIds[]` (count lines).
- Plus, via `repositories.ts`, a client query against the **global `catalogEntries`** collection
  (`normalizedBarcode`, product identity, source/evidence-ish fields) — cross-business.

## 2. Sensitive localStorage (key `sis-scan-v1`, Zustand persist `partialize`)
Persisted fields include: **`products`** (with all code fields), **`aliases`** (full alias table),
`scanFeed` (each event has `rawCode`/`cleanCode`/`normalizedCandidates`), `needsReviewQueue` (raw/clean
codes + suggestions), `finalCounts`, `pendingSyncQueue`. → **The reusable barcode/alias database sits in
the customer's browser localStorage and survives refresh.** (clearLocalCache wipes it locally, but a
re-login re-downloads it.)

## 3. Sensitive network / API responses
- Direct Firestore client reads (no API layer): `getDocs(businesses/{bid}/aliases)` and `.../products`
  return raw documents to the browser. There is no server serializer between Firestore and the client.
- `repositories.ts` client-queries global `catalogEntries`.
- `/api/ai-lookup` (decode) returns provider/evidence/source fields used by the decode UI.

## 4. Sensitive exports (no role gating — `src/services/csvExport.ts`)
All exported client-side from store state, available to every role via `ExportButtons`:
- `exportProducts` → `primary_barcode, gtin, upc, ean, aliases`. `exportAliases` → the **entire alias
  map** (`raw_code_example, clean_code, normalized_code`). `exportFinalCounts`/`exportQuantityAdjustments`
  → barcode/gtin/upc/ean/aliases. `exportRawScanLog`/`exportUnknowns` → `raw_code, clean_code,
  normalized_candidates`. **No `role`/`platformOwner`/sanitize logic exists in csvExport.**

## 5. Sensitive UI screens
- **Products page**: columns Primary SKU / Primary barcode / GTIN-UPC-EAN / Codes panel (aliases + unlink/move).
- **LiveScanFeed**: Raw code / Clean code columns.
- **FinalCountTable**: Primary SKU / Primary barcode / Aliases.
- **NeedsReviewTable**: Raw code / Clean code (+ suggested fields, provider, evidence-strength).
- **Settings**: "AI lookup", provider names (Gemini/OpenAI), decode budget, catalog internals.

## 6. Firestore reads that are too broad (`firestore.rules`)
- `businesses/{bid}/aliases/{id}` → `allow read: if isMember(bid)` — **counter/viewer can read the whole alias table.**
- `businesses/{bid}/products/{id}` → `isMember` — products carry code fields (see §8).
- `businesses/{bid}/scanEvents`, `inventoryCounts`, `unknownCodeReviews`, `shopOverrides`, `settings` → `isMember` (carry raw codes).
- **`catalogEntries/{id}` → `allow read: if isSignedIn()`** — a **GLOBAL, cross-business** collection any
  signed-in user can read, and `repositories.ts` reads it client-side. This is the broadest leak of the moat.
- (auditLog is correctly gated to owner/admin.)

## 7. Documents that MIX customer-facing + internal fields
- **`products/{id}`**: customer-safe (`name, brand, category, specsShort, location, imageUrl`) **mixed with**
  internal (`primaryBarcode, gtin, upc, ean, aliases[], vendorCodes[]`) in one doc.
- **`scanEvents/{id}`, `unknownCodeReviews/{id}`**: contain `rawCode/cleanCode/normalizedCandidates` mixed with display data.

## 8. Why Firestore field-level hiding is NOT enough
Firestore rules allow/deny **whole documents**, not fields. A customer who can read `products/{id}` gets
its barcode/gtin/aliases too. So patching UI columns is cosmetic — the data still arrives over the wire and
into localStorage. Real fixes require one of: (a) **split** customer-facing product data from internal
code/alias data into separate docs/subcollections; (b) **stop** customer direct-reads of products/aliases
and serve **sanitized** data via a server endpoint; (c) keep `aliases`/`catalogEntries` server-only and
resolve scans server-side.

## 9. Recommended serializer boundaries
`sanitizeProductForRole(product, role)`, `sanitizeScanResultForRole(result, role)`,
`sanitizeExportRowsForRole(rows, kind, role)`, driven by a single `sensitiveFields` denylist. platformOwner
→ full; customer → product-facing only. Applied **server-side and in export builders** (UI hiding secondary).

## 10. Recommended endpoint boundaries
`POST /api/resolve-scan` (auth + role → resolve internally → return sanitized result for customers, full for
platformOwner). A customer product/list loader that returns only product-facing fields. Aliases + global
catalog become **server-only** (no customer client read).

## 11. Exact files to change (when approved)
- New: `src/services/security/{roleAccess,serializers,sanitizeProduct,sanitizeScanResult,sanitizeExport,sensitiveFields}.ts`.
- New: `src/app/api/resolve-scan/route.ts` (+ a customer product loader).
- Change: `src/services/db/firebase/businessDataLoader.ts` (split platformOwner vs customer loaders).
- Change: `src/stores/scanStore.ts` persist `partialize` (don't persist `aliases`/full `products` for customers).
- Change: `src/services/csvExport.ts` + `src/components/ExportButtons.tsx` (role-aware/sanitized exports).
- Change: `firestore.rules` (restrict `aliases`, `catalogEntries`, scanEvents/reviews reads; **carefully**, with emulator tests + revert-on-failure).
- Change: UI surfaces (`products/page.tsx`, `LiveScanFeed`, `FinalCountTable`, `NeedsReviewTable`, `settings/page.tsx`) for role hiding + de-branding.
- New: a `platformOwner` identity check (see master report) used by all of the above.

## 12. Risk level per leak
| leak | severity |
|------|----------|
| `catalogEntries` global read by any signed-in user (+ client reads it) | **P0 (cross-business moat)** |
| Full `aliases` table downloaded to every member's browser + localStorage | **P0** |
| Product docs mix codes with display fields (customer reads codes) | **P0** |
| Exports include full alias/code maps for all roles | **P0** |
| scanEvents/reviews raw codes readable by counter/viewer | P1 |
| Customer UI exposes "AI"/provider wording | P1 (moat + trust) |

## 13. Recommended implementation phases (for approval)
P2 serializers → P4 customer loader/localStorage split → P3 `/api/resolve-scan` → P6 sanitized exports →
P5 Firestore hardening (carefully) → P7 de-branding → P8 bot proof. (Numbers match the task's phase tags.)

## 14. Tests/bots to prove each fix
SecurityLeakBot (no sensitive fields in customer UI/localStorage/network), ExportBot (sanitized customer
CSVs), RoleBot (platformOwner vs each customer role), DataIntegrity + tire + live bots (no regression),
emulator rules tests (counter/viewer cannot read aliases/catalogEntries), serializer unit tests.

---
**STOP — awaiting Santiago's "Approved" before any implementation (Phases 2–9).**
