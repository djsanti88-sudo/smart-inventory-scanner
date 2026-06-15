# Hotfix — Multi-code tire resolution (+ repair)

## Problem
A tire carries more than one scannable code (retail barcode/UPC/EAN/GTIN **and** a manufacturer part
number / SKU / QR). Scanning the barcode resolved; scanning the part number returned nothing. Requirement:
any code on a product must resolve to the SAME product, and separators (a dash like `2881-6861`) must not
cause a missed lookup.

## What was built
- **Smart normalization** (`src/services/codeNormalizer.ts`): raw value preserved; generates safe variants
  (no-separator, no-space, uppercase, digits-only) + an ordered `searchVariants` list.
- **Separator-insensitive matching** (verified): the deterministic matcher resolves `2881-6861` ⇄ `28816861`
  both ways; an ambiguous normalized match (same code → two products) routes to **conflict / Needs Review**
  (never an auto-pick).
- **Multi-code capture on create** (`scanStore.buildProductCodeAliases`): a created product registers an
  **approved alias for every code it carries** (barcode + part number/SKU + GTIN/UPC/EAN + vendor codes).
  Works for manual create AND AI auto-add (which already maps decode codes into the product).
- **AI part-number enrichment** (`src/services/ai/prompt.ts`): the lookup prompt now asks for the
  manufacturer part number (→ `primarySku`) and all alternate codes (→ `aliases`).
- **Repair** (`scanStore.unlinkAlias` / `moveAlias` + Products "Codes" panel): a wrong alias can be
  unlinked (soft delete; scan history kept) or moved to the correct product; both audited
  (`alias_moved_or_unlinked`, reason `human_mistake_repair`).

## Proof (automated)
- `src/services/codeNormalizer.test.ts` (6) — variant generation, raw preserved.
- `src/services/multiCodeResolution.test.ts` (6) — barcode ⇄ part number resolve both ways; ambiguous → conflict.
- `src/stores/multiCodeCapture.store.test.ts` (2) — any code (barcode/part number/GTIN + no-dash) resolves to
  the same product; scan-to-link makes both codes resolve on an existing product.
- `src/stores/aliasRepair.store.test.ts` (2) — unlink stops a tire code resolving to cigarettes; move re-points it.
- Full gates green: vitest 371 passed / 30 skipped, tsc clean, eslint 0 errors, next build OK,
  mock Playwright 11/11, test:firebase 30/30, Firebase E2E 1/1.

## How to verify in the app (owner / god account, cloud)
1. Scan a tire's barcode → if unknown, create the product and enter the part number in the SKU field (or let
   AI fill it when enabled). The product is saved with BOTH codes.
2. Scan the part-number QR (with or without its dash) → resolves to the SAME product. No double count.
3. To fix a past mistake: Products → click a product's **Codes** count → Unlink a wrong code or Move it to the
   correct product.

## Notes / limitations
- AI part-number extraction is best-effort and only runs when AI lookup is enabled (off by default); the
  physically-scanned second code (scan-to-link) is the reliable source of truth.
- Customer/role-based code hiding + server-side resolution are DEFERRED (see docs/HOTFIX_FOLLOWUPS.md).
