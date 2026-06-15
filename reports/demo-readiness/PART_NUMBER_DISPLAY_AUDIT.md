# Part Number Display Audit (Window 2)

**Branch:** `demo-readiness-vercel-partnumber`
**Base commit:** `7090873` (on `p0-platform-customer-security-audit`; foundation = `a11d265` "P0 customer data protection foundation")
**Audited in:** isolated git worktree `C:\tmp\inventory-demo` (does NOT disturb Window 1's `C:\Users\djsan\inventory` checkout)
**Author:** Window 2 (demo-readiness)

---

## 1. Goal & security rule

Customer (non-platformOwner / `business`) roles can no longer see barcode/raw-code fields after Window 1's
P0 work. They must therefore clearly see the **part number** to identify a product.

- **Customer-facing (must be visible):** part number.
- **Must stay hidden from customers:** barcode, UPC, EAN, GTIN, rawScannedCode, cleanCode, normalizedCode,
  aliases, alias maps, provider/source/evidence/debug fields.

---

## 2. Data-model finding (important): what "part number" actually is

There is **no `partNumber` and no `manufacturerPartNumber` field** in the data model.

- `Product.primarySku` ([src/types.ts:92](../../src/types.ts#L92)) **is** the manufacturer part number / SKU.
  It is product-facing and customer-safe.
- `primarySku` is **NOT** in the sensitive denylist
  ([src/services/security/sensitiveFields.ts:4-21](../../src/services/security/sensitiveFields.ts#L4-L21)),
  so it is legitimately allowed to customers.
- The hidden code fields are separate: `primaryBarcode`, `gtin`, `upc`, `ean`, `vendorCodes`, `aliases`
  ([src/types.ts:93-98](../../src/types.ts#L93-L98)) — all denylisted.

**Answer to "does manufacturerPartNumber exist separately from partNumber?"** → Neither name exists.
The single canonical field is `primarySku`. The customer serializers expose it under the friendly key
`partNumber` (scan result) and the UI labels it **"Part number"**.

---

## 3. Surface-by-surface audit (before this window's fix)

| # | Surface | File | Part number shown to **customer**? | Codes hidden from customer? | Verdict |
|---|---------|------|-----------------------------------|-----------------------------|---------|
| 1 | Scan result confirmation (the "scan result" line under the input) | [ScannerInput.tsx:107](../../src/components/ScannerInput.tsx#L107) | ❌ showed `cleanCode` + `matchType`, not part number | ❌ **LEAK** — showed denylisted `cleanCode` to customers | **P1/P2 GAP → fixed by this window** (see §5b) |
| 2 | Live scan feed | [LiveScanFeed.tsx](../../src/components/LiveScanFeed.tsx) | ❌ **MISSING** (name only) | ✅ raw/clean code gated `isPlatform` | **GAP → fixed by this window** |
| 3 | Final count table | [FinalCountTable.tsx:35,61](../../src/components/FinalCountTable.tsx#L35) | ✅ "Part number" col = `primarySku` | ✅ barcode/aliases gated `isPlatform` | OK |
| 4 | Products table | [products/page.tsx:30,68](../../src/app/(app)/products/page.tsx#L30) | ✅ "Part number" col = `primarySku` | ✅ barcode/GTIN/UPC/EAN/codes/source gated `isPlatform` | OK |
| 5 | Needs Review | [NeedsReviewTable.tsx](../../src/components/NeedsReviewTable.tsx) | ⚠️ none (suggested name/brand only) | ✅ raw/clean/provider/sources gated `isPlatform` | Acceptable — item is an **unconfirmed** suggestion, not a verified product yet |
| 6 | Customer export — final counts | [csvExport.ts:249-257](../../src/services/csvExport.ts#L249-L257) | ✅ `part_number` col = `primarySku` | ✅ no barcode/gtin/upc/ean/aliases | OK |
| 6 | Customer export — qty adjustments | [csvExport.ts:259-267](../../src/services/csvExport.ts#L259-L267) | ✅ `part_number` col = `primarySku` | ✅ | OK |
| 6 | Customer export — unknowns | [csvExport.ts:269-274](../../src/services/csvExport.ts#L269-L274) | ⚠️ none (suggested name/brand/category/status) | ✅ no codes | Acceptable — unconfirmed |
| 7 | Customer-safe product serializer | [serializers.ts:8-28](../../src/services/security/serializers.ts#L8-L28) | carries `primarySku` via allowlist `CUSTOMER_SAFE_PRODUCT_FIELDS` | ✅ allowlist build | OK (see note 7a) |
| 8 | Server `/api/resolve-scan` response | [route.ts](../../src/app/api/resolve-scan/route.ts) + [resolveScanServer.ts](../../src/services/security/resolveScanServer.ts) | ✅ `result.partNumber` = `primarySku` ([serializers.ts:39,60](../../src/services/security/serializers.ts#L60)) | ✅ no raw/clean/normalized/aliases/provider | OK |
| 9 | Product detail view | *(none)* | — | — | No dedicated detail route exists (`/products` table only) |
| 10 | Mobile-width scan flow | same components, responsive (`overflow-auto`) | inherits feed/table fixes | ✅ same role gates | OK after feed fix |

### Note 7a — serializer key naming (informational, no action needed)
- `sanitizeScanResult` (the **scan/resolve** customer shape) exposes the part number under the explicit
  key **`partNumber`** ([serializers.ts:34-66](../../src/services/security/serializers.ts#L34-L66)).
- `sanitizeProduct` (the **product** customer shape) carries it under **`primarySku`** via the allowlist
  ([serializers.ts:8-28](../../src/services/security/serializers.ts#L8-L28)).
- Both resolve to the same source value. This is a naming inconsistency only; **both are customer-safe and
  both include the part number.** Not a leak, not a blocker. Left unchanged (those files are Window 1
  security-owned; see §6).

---

## 4. Required findings (explicit answers)

1. **Where part number currently appears:** Final count table, Products table, customer final-counts &
   qty-adjustment exports, and the server `/api/resolve-scan` customer response (`partNumber`).
2. **Where it was missing:** **Live Scan Feed** (the de-facto "scan result" surface) showed product name
   only. Minor/acceptable absence: Needs Review (suggestions are unconfirmed) and the unknowns export.
3. **manufacturerPartNumber vs partNumber:** neither exists; the field is `Product.primarySku`.
4. **Does `/api/resolve-scan` include partNumber safely?** Yes — `result.partNumber` (from `primarySku`)
   for customers, with no codes/aliases/provider/evidence. platformOwner gets the full internal result.
5. **Do customer exports include partNumber?** Yes — `part_number` column in the customer final-counts and
   quantity-adjustment exports.
6. **Exact files to change:** [src/components/LiveScanFeed.tsx](../../src/components/LiveScanFeed.tsx)
   (add Part number column) and [src/components/ScannerInput.tsx](../../src/components/ScannerInput.tsx)
   (role-aware confirmation — see §5b). Plus the new proof spec
   `e2e/human-bots/scenarios/partnumber-display.spec.ts` and the `qa:weekly-report` package script.
7. **Conflict with Window 1 security files?** **No.** Neither `LiveScanFeed.tsx` nor `ScannerInput.tsx` is
   in the `do_not_touch_without_approval` list, and both are **byte-identical between `cfb23e3`, `a11d265`,
   and `7090873`** (verified via `git diff`). Window 1's changes were confined to the resolver/persistence/
   role-identity files. Zero overlap.
8. **Safest implementation plan:** add one read-only "Part number" column to the feed rendering
   `product.primarySku`, shown to **all** roles (it is customer-safe), with a `"Part number missing"`
   fallback (never a barcode). No serializer, denylist, resolver, or persistence change.

---

## 5. Fix implemented by this window ✅

**File:** [src/components/LiveScanFeed.tsx](../../src/components/LiveScanFeed.tsx)

- Added a **"Part number"** column header (after "Product").
- Added a cell rendering `product.primarySku || "Part number missing"` (never a code), `"-"` when no
  product is matched yet. `data-testid="feed-part-number-<id>"` for QA.
- Updated the empty-state `colSpan` (`isPlatform ? 9 : 7` → `10 : 8`) to keep the table aligned.

**Why safe:**
- Uses only `primarySku` (allowlisted, customer-safe). Exposes **no** barcode/UPC/EAN/GTIN/alias/raw code.
- Shown to all roles; nothing new is revealed to customers beyond the part number, which they are meant to see.
- Touches **no** Window 1 security file; no serializer/denylist/resolver/persistence change.
- The SecurityLeakBot forbidden terms (`provider`, `gtin`, `upc`, `ean`, `aliases`, `cleanCode`, …) do not
  include `primarySku` or "part number"; the products-page leak regex only runs for `/products`, not the feed.
- Feed E2E specs assert row **content/count**, never column count — adding a column does not break them.

## 5b. Second fix — scan confirmation leak (found by adversarial proof) ✅

**File:** [src/components/ScannerInput.tsx](../../src/components/ScannerInput.tsx)

**The finding:** the scan confirmation line rendered
`Counted: ${lastResult.cleanCode} (${lastResult.matchType}). New quantity N.` to **all** roles — exposing
the **denylisted `cleanCode`** (and internal `matchType`) to customers after every scan. This is the literal
"scan result" surface (Task 3 area #1) and it visibly contradicts the demo claim that customers don't see
raw codes.

**Why SecurityLeakBot did not catch it:** the bot sweeps **static pages** and the store; it never performs
a scan, so the transient post-scan confirmation never appears in its sweep. This window's adversarial proof
spec (`partnumber-display.spec.ts`) **does** perform a customer scan and asserted the barcode is absent —
that is what surfaced it.

**The fix (role-aware, customer-safe):**
- platformOwner: unchanged (still sees `cleanCode (matchType)` — full technical detail).
- customer (`business`): now shows **`Counted: <product name> (part no. <primarySku>). New quantity N.`** —
  no raw/clean code, no match type. Conflict/unknown messages for customers are now code-free too
  (`"Conflict: this code matches more than one product…"`, `"Unknown code. Sent to Needs Review."`).
  If a product has no SKU, it shows the name without a part-number suffix (never a code).
- Implemented with `useIsPlatformOwner()` + the store's `getProduct` (both pure store selectors; no new
  deps, no prop changes, single usage in `scan/page.tsx`). Touches **no** Window 1 security file.

**Proof:** see screenshot `e2e/proof/demo-readiness/01-customer-scan-part-number.png` — confirmation reads
*"Counted: Nokian Outpost APT (part no. T432119). New quantity 1."* with the barcode `6419440485331` absent
from the entire customer page. SecurityLeakBot re-run after the fix: **findings: [] (P0:0/P1:0/P2:0)**.

> **Recommendation for Window 1:** consider extending SecurityLeakBot with a *post-scan* sweep (scan a known
> + an unknown code, then re-check the page for denylisted values) so this class of transient leak is caught
> automatically in future. Flagged, not implemented here (the bot belongs to Window 1's security scope).

**Deliberately NOT changed (scope/safety):**
- Needs Review & unknowns export: items there are unconfirmed AI/mock **suggestions**; showing a
  "part number" could imply trust the doctrine says we must not. Left as suggestion-only.
- Serializer key naming (`partNumber` vs `primarySku`): cosmetic only and lives in Window 1 security files.

---

## 6. Window 1 security-file boundary

No `do_not_touch_without_approval` file was edited. The one code change is an additive UI column in a
non-security component. SecurityLeakBot was re-run as part of verification (see WINDOW2_FINAL_REPORT.md);
expected to remain **P0:0 / P1:0 / P2:0**.
