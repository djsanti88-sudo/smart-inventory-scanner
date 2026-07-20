# Phase 4: Universal Import and Smart Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Track every checkbox, run every failing test before implementation, and perform independent review before merging parallel tracks.

**Goal:** Let a Scanbin account upload CSV, TSV, XLSX, or a file carrying an `.xls` name, understand or manually map its columns, see one honest preview headed by `Matched 380 of 400 automatically`, and explicitly apply exact rows while every algorithmic fuzzy or ambiguous row stays in Needs Review until a human confirms it. The flow must feed the existing count snapshots, variance view, and Boss Report without any inventory, alias, count, review, localStorage, Turso, or Firestore write before the Apply click. ExcelJS 4.4.0 can read XLSX but not legacy BIFF, so true BIFF `.xls` remains a flagged acceptance gap until the owner approves a compatible parser.

**Architecture:** Build Stage A as an isolated universal-import pipeline around the existing pure seams. `sanitizeCell(raw: string): string` remains the single untrusted-cell boundary in `src/services/csvImport.ts`; `readUniversalFile(file: UploadFileLike): Promise<UniversalSheet>` sanitizes every CSV, TSV, and ExcelJS cell before inference. `inferColumnMapping(matrix: string[][]): ColumnInference` performs deterministic header normalization and conservative content inference, then `UniversalImportPanel` falls back to an explicit mapping screen. Preview calls the existing Node route `POST /api/reconcile/match`, which continues to run `matchExpectedRow(row, deps)` and gains exact retail-corpus enrichment through `lookupRetailBarcodeAsync(code)`. Preview state stays in React memory only. Mapping memory is a namespaced Turso KV record through `LadderStorage.get/set`, keyed by `businessId` and `sourceSignature`; its route writes only after Apply. Exact human-upload rows use the existing `resolveUnknown(reviewId, action, payload)` human origin path and remain `approved: true`. Fuzzy rows are staged as import-specific Needs Review records with their quantity and a stable import event id. The new `resolveImportReview(reviewId, action, payload)` variant confirms identity first, then applies one idempotent ledger event carrying the full imported quantity. Stage B starts only after the complete Stage A proof gate and adds new character-level edit distance plus the canonical token Jaccard from `src/services/catalog/identityMerge.ts`.

**Tech Stack:** Next.js 16.2.9 App Router and Route Handlers, React 19.2.4, TypeScript 5, Tailwind v4, Zustand 5.0.14, Vitest 4.1.8 unit and dom projects, Playwright 1.60.0, `csv-parse` 7.0.0, ExcelJS 4.4.0 lazy read, existing tire and retail SQLite/Turso corpus access, and existing Turso/file-backed `LadderStorage` KV.

## Global Constraints

- **Stage order (this plan = Stage A only):** Tasks 1 through 11 ARE this plan (Tasks 1-10 implementation, Task 11 the ship + proof gate). There are no Tasks 12-15. Stage A is independently shippable; Stage B is the separate P4b follow-up. No Stage B tuning may block a Stage A release.
- **Binding threshold T:** `0.75`, grounded in `src/services/reconcile/identityMatcher.ts:66` and the existing literal used by `findIdentityMerge` in `src/services/catalog/identityMerge.ts:167`. Task 7 exports `IDENTITY_JACCARD_THRESHOLD = 0.75` from the canonical identity-merge module and makes both existing consumers import it. Stage B imports it and does not create a third threshold literal.
- **Canonical Jaccard:** only `jaccard(a: string[], b: string[]): number`, `nameTokens(s: string | null | undefined): string[]`, and `plusGenerationDiff(a: string[], b: string[]): boolean` from `src/services/catalog/identityMerge.ts` are canonical for Phase 4. The independent `jaccard` functions in `src/services/ai/crossCheckEngine.ts` and `src/services/fetchV2/siblingGuard.ts` remain untouched. This is a landmine: `identityMerge.ts` returns `0` for empty/empty, while `siblingGuard.ts` returns `1`. Unifying them is out of scope.
- **Resolver trust invariant:** wrong identity is failure and ambiguity is acceptable. Every product-identity fuzzy match, including a score at or above `0.75`, is suggestion data only until a human confirms it. Every fuzzy score below `0.75`, every tie, every affix-core-only match, and every conflicting corroboration routes to Needs Review. No fuzzy row receives `approved: true` during Apply. Exact human-upload rows retain the current `approved: true`, `verified: true` behavior through `resolveUnknown` with `origin: "human"`.
- **Preview before apply:** file read, column inference, mapping UI, corpus lookup, and preview are read-only. They may update React component memory and perform GET/POST reads, but they must not call `useScanStore.setState`, `reopenNeedsReview`, `resolveUnknown`, `snapshotCount`, `LadderStorage.set`, or a Firestore write. The first permitted write is the explicit Apply click.
- **Demo beat:** the preview header is exactly `Matched X of Y automatically`; the scripted fixture proves `Matched 380 of 400 automatically` on one screen before Apply.
- **Sanitizer boundary:** every imported cell follows exactly `stripControlChars -> 500-character cap -> defuseFormulaInjection` through `sanitizeCell`. This applies to CSV, TSV, XLSX, OOXML-with-`.xls` filenames, header cells, mapped cells, sample rows, and `ExpectedInventoryRow.raw`. Task 2 closes the current Shop-Ware adapter gap.
- **ExcelJS read reality:** `package.json` contains `exceljs: ^4.4.0`, and `node_modules/exceljs/README.md` documents `workbook.xlsx.load(data)` for XLSX only. Task 4 introduces the first repository read path. A true legacy BIFF `.xls` file is not silently claimed as supported; it gets the exact error `Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.` Supporting genuine BIFF remains a flagged unknown requiring an owner-approved parser decision. An OOXML payload named `.xls` is accepted because content, not the suffix, is passed to `workbook.xlsx.load`.
- **Mapping memory decision:** choose Turso KV, wrapped by `src/server/importMappingMemory.ts`, using `LadderStorage.get/set` and key `import_mapping::<businessId>::<sourceSignature>`. Firestore is not chosen because the current default and demo backend is mock, while Firestore-only memory would disappear from that path. localStorage is not chosen because it is per browser rather than per account. The namespaced Turso/file seam works in mock and live modes, remains outside inventory truth, and preserves per-account keys. The API route still verifies membership in live mode. Reusing `ladder_kv` is an acknowledged semantic compromise; a dedicated table is deferred until mapping volume or retention warrants it.
- **Monolith containment:** Tasks 1 through 10 create isolated modules or touch narrow existing files. Task 11 is the only Stage A task that edits the approximately 5,700-line `src/stores/scanStore.ts`; it is ordered last among Stage A implementation tasks and adds only optional import review context, `resolveImportReview`, and one idempotent bulk-quantity ledger event.
- **Persist migration law:** the actual store is `name: "sis-scan-v1"`, `version: 8`, with `scanStoreMigrate(persisted, version)` at `src/stores/scanStore.ts:5685` and the version at `src/stores/scanStore.ts:5733`. Task 10 (the sole monolith edit) bumps to version 9 because `UnknownCodeReview.importQuantity` is persisted. Its migration preserves the v8 rule at `src/stores/scanStore.ts:5703`: transform only keys the blob already carries, never inject absent arrays or settings into a partial blob. `countSnapshots` remains the one documented unconditional exception at line 5721.
- **Performance:** parsing, mapping, matching supplied in-memory match results, and constructing a 5,000-row preview must complete in less than `10_000` ms locally. The performance test excludes Apply and external network latency, which are not import processing.
- **Limits already grounded in code:** `MAX_FIELD_LENGTH = 500`, `PREVIEW_LIMIT = 20`, and reconcile route `MAX_ROWS = 20000`. The mapping API body cap reuses the existing share-route value `32 * 1024` bytes.
- **No paid or live calls:** automated tests mock retail/Turso/Firebase access and never call paid providers. Phase 4 does not call `/api/ai-lookup`.
- **No em dash or en dash:** all new user-facing copy, source comments, tests, fixtures, and this plan use ASCII punctuation.
- **Out of scope:** unifying the three legacy Jaccard implementations, replacing the scan ledger, live production import, importing price/cost, adding AI-based column mapping, and claiming true BIFF `.xls` support without a compatible parser.
- **Cost worst case:** paid API cost is `$0`; this phase uses deterministic code and existing local/server corpora. Subscription token usage is reported at closeout rather than guessed in advance.

## Track and dependency map

This plan is exactly 11 tasks. There are NO Tasks 12-15 in this file.

| Track | Tasks | Dependency |
|---|---|---|
| Stage A foundation | 1, then 2, 3, and 5 in parallel | Task 1 first |
| Stage A ingestion | 4 after 2 and 3; 6 after 1 and 5 | Disjoint files |
| Stage A preview | 7 and 8 in parallel after 3 and 4 | Disjoint files (8 consumes Task 7's ExpectedInventoryRow.barcode type) |
| Stage A UI | 9 after 6, 7, and 8 | Creates UniversalImportPanel; no scanStore edit |
| Stage A inventory bridge | 10 after 9 | Sole monolith edit (scanStore + products page + container), ordered last among implementation |
| Stage A ship gate | 11 after 10 | Final proof + handoff for THIS plan |

Stage B (typo-tolerant fuzzy matching + combined handoff) is a SEPARATE follow-up plan (`2026-07-20-phase4b-fuzzy-matching.md`), authored and executed only after Task 11 passes. It reuses this plan's `ImportPreviewStatus "fuzzy"` slot, the canonical `jaccard`/`nameTokens` from `identityMerge.ts`, `IDENTITY_JACCARD_THRESHOLD` (Task 7), and `prefixBrandConflict` for non-tire brand safety, and adds net-new character-level edit distance - all behind the review-first guard (no fuzzy row ever auto-approves).

---

## Task 1: Define the universal import contract and source signature

**Stage:** A

**Files:**

- Create: `src/services/importSchema.ts`
- Test: `src/services/importSchema.test.ts`

**Interfaces:**

- Consumes: plain sanitized strings and `MatchResult`-compatible candidate data.
- Produces: `ImportField`, `ColumnMapping`, `MappingSource`, `UploadKind`, `UploadFileLike`, `UniversalSheet`, `MappedImportRow`, `ImportPreviewStatus`, `ImportPreviewRow`, `ImportPreview`, `UniversalImportApplySummary`, `ImportReviewContext`, `buildSourceSignature(headers: string[]): string`, and `emptyColumnMapping(): ColumnMapping`.

- [ ] **Step 1: Write the failing unit test**

```typescript
// src/services/importSchema.test.ts
import { describe, expect, it } from "vitest";
import {
  IMPORT_FIELD_ORDER,
  buildSourceSignature,
  emptyColumnMapping,
} from "@/services/importSchema";

describe("importSchema", () => {
  it("keeps the nine supported mapping fields in a stable order", () => {
    expect(IMPORT_FIELD_ORDER).toEqual([
      "partNumber",
      "brand",
      "model",
      "size",
      "quantity",
      "uom",
      "barcode",
      "name",
      "category",
    ]);
  });

  it("builds the same source signature for case and whitespace variants", () => {
    expect(buildSourceSignature([" PN ", "Make", "QOH"])).toBe(
      buildSourceSignature(["pn", " make ", "qoh"]),
    );
  });

  it("returns a fresh empty mapping", () => {
    const a = emptyColumnMapping();
    const b = emptyColumnMapping();
    expect(a).toEqual({});
    expect(b).toEqual({});
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npx vitest run src/services/importSchema.test.ts`

Expected: FAIL with `Cannot find module '@/services/importSchema'`.

- [ ] **Step 3: Create the complete contract module**

```typescript
// src/services/importSchema.ts
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

export const IMPORT_FIELD_ORDER = [
  "partNumber",
  "brand",
  "model",
  "size",
  "quantity",
  "uom",
  "barcode",
  "name",
  "category",
] as const;

export type ImportField = (typeof IMPORT_FIELD_ORDER)[number];
export type ColumnMapping = Partial<Record<ImportField, number>>;
export type MappingSource = "header" | "content" | "manual" | "remembered";
export type UploadKind = "csv" | "tsv" | "xlsx" | "xls";

export interface UploadFileLike {
  name: string;
  type?: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UniversalSheet {
  fileName: string;
  kind: UploadKind;
  headers: string[];
  rows: string[][];
  headerRowIndex: number;
  sourceSignature: string;
  seenRows: string[][];
}

export interface MappedImportRow {
  line: number;
  expected: ExpectedInventoryRow;
  partNumber: string;
  barcode: string;
  name: string;
  brand: string;
  model: string;
  size: string;
  category: string;
  quantity: number;
  uom: string;
}

export type ImportPreviewStatus = "exact" | "fuzzy" | "review" | "reject";

export interface RetailCatalogMatch {
  productName: string;
  brand: string;
  category: string;
  barcode: string;
}

export interface ImportPreviewRow {
  source: MappedImportRow | null;
  line: number;
  status: ImportPreviewStatus;
  reason: string;
  confidence: number | null;
  candidate?: CorpusCandidate;
  retailCatalogMatch?: RetailCatalogMatch;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  total: number;
  exact: number;
  fuzzy: number;
  review: number;
  reject: number;
  headline: string;
}

export interface UniversalImportApplySummary {
  applied: number;
  queuedForReview: number;
  rejected: number;
}

export interface ImportReviewContext {
  importQuantity: number;
  suggestion?: {
    name: string;
    brand: string;
    category: string;
    specsShort: string;
    primarySku: string;
    primaryBarcode: string;
  };
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildSourceSignature(headers: string[]): string {
  const content = headers.map(normalizedHeader).join("\u001f");
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0;
  }
  return `import-source-${(hash >>> 0).toString(36)}-${headers.length}`;
}

export function emptyColumnMapping(): ColumnMapping {
  return {};
}
```

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run src/services/importSchema.test.ts`

Expected: PASS, 3 tests.

---

## Task 2: Export the sanitizer, close the Shop-Ware gap, and remove the D9 four-name failure

**Stage:** A

**Files:**

- Modify: `src/services/csvImport.ts`
- Modify: `src/services/reconcile/shopwareCsvAdapter.ts`
- Test: `src/services/reconcile/shopwareCsvAdapter.test.ts`

**Interfaces:**

- Consumes: untrusted string cells from uploaded files.
- Produces: exported `MAX_FIELD_LENGTH = 500`, `stripControlChars(value: string): string`, `defuseFormulaInjection(value: string): string`, and `sanitizeCell(raw: string): string`; expanded `SHOPWARE_COLUMN_MAP.partNumber`; sanitized `parseShopwareCsv(fileText: string): AdapterResult` output.

- [ ] **Step 1: Append the complete regression tests**

```typescript
// Append inside describe("parseShopwareCsv", ...) in src/services/reconcile/shopwareCsvAdapter.test.ts
  it.each(["Part #", "PN", "Item No.", "Mfg Part Number"])(
    "accepts the D9 part-number header %s and reports the seen columns",
    (header) => {
      const result = parseShopwareCsv(`${header},Make,Model,Tire Size,QOH\nABC-1,Acme,Road,225/45R18,7\n`);
      expect(result.unparseable).toEqual([]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].externalId).toBe("ABC-1");
      expect(result.rows[0].brand).toBe("Acme");
      expect(result.rows[0].qty).toBe(7);
    },
  );

  it("shows every normalized header when the required identity column is absent", () => {
    const result = parseShopwareCsv("Alpha,Beta,Gamma\none,two,three\n");
    expect(result.unparseable).toEqual([
      {
        line: 1,
        reason: "Missing required column: part number. Seen: alpha, beta, gamma.",
      },
    ]);
  });

  it("sanitizes every surviving raw cell and every mapped field", () => {
    const long = "x".repeat(600);
    const result = parseShopwareCsv(
      `PN,Make,Model,QOH,Notes,Cost\nABC-1,=2+2,@model,3,${long},=99\n`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].brand).toBe("'=2+2");
    expect(result.rows[0].model).toBe("'@model");
    expect(result.rows[0].raw.notes).toHaveLength(500);
    expect(result.rows[0].raw.cost).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests and verify the D9 and sanitizer failures**

Run: `npx vitest run src/services/reconcile/shopwareCsvAdapter.test.ts`

Expected: FAIL because `PN`, `Part #`, `Item No.`, and `Mfg Part Number` are outside the current four-string list and because Shop-Ware raw cells are not sanitized.

- [ ] **Step 3: Apply the complete focused patch**

```diff
*** Begin Patch
*** Update File: src/services/csvImport.ts
@@
-const MAX_FIELD_LENGTH = 500;
+export const MAX_FIELD_LENGTH = 500;
@@
-function stripControlChars(value: string): string {
+export function stripControlChars(value: string): string {
@@
-function defuseFormulaInjection(value: string): string {
+export function defuseFormulaInjection(value: string): string {
@@
-function sanitizeCell(raw: string): string {
+export function sanitizeCell(raw: string): string {
*** Update File: src/services/reconcile/shopwareCsvAdapter.ts
@@
 import { parse as parseCsvSync } from "csv-parse/sync";
 import type { AdapterResult, ExpectedInventoryRow } from "@/services/reconcile/types";
+import { sanitizeCell } from "@/services/csvImport";
@@
-  partNumber: ["part_number", "part number", "part_no", "sku"],
+  partNumber: [
+    "part_number",
+    "part number",
+    "part_no",
+    "sku",
+    "part_#",
+    "part #",
+    "pn",
+    "item_no.",
+    "item no.",
+    "item_no",
+    "item no",
+    "mfg_part_number",
+    "mfg part number",
+  ],
@@
-  qtyOnHand: ["qty_on_hand", "quantity_on_hand", "qty on hand", "on_hand"],
+  qtyOnHand: ["qty_on_hand", "quantity_on_hand", "qty on hand", "on_hand", "qoh"],
@@
-        headers = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
+        headers = header.map((h) => sanitizeCell(h).toLowerCase().replace(/\s+/g, "_"));
@@
   if (!partNumberKey) {
-    unparseable.push({ line: 1, reason: "Missing required column: part number." });
+    unparseable.push({
+      line: 1,
+      reason: `Missing required column: part number. Seen: ${headers.join(", ") || "(none)"}.`,
+    });
     return { rows, uomReview, unparseable, assumptions };
   }
@@
   records.forEach((record, idx) => {
     const line = idx + 2; // header is line 1; first data record is line 2
+    const sanitizedRecord = Object.fromEntries(
+      Object.entries(record).map(([key, value]) => [key, sanitizeCell(String(value ?? ""))]),
+    );
 
-    const partNumber = (record[partNumberKey] ?? "").trim();
+    const partNumber = sanitizedRecord[partNumberKey] ?? "";
@@
-    const onHand = qtyOnHandKey ? parseQty(record[qtyOnHandKey]) : undefined;
-    const available = qtyAvailableKey ? parseQty(record[qtyAvailableKey]) : undefined;
+    const onHand = qtyOnHandKey ? parseQty(sanitizedRec…18611 tokens truncated….category || source.category,
+            specsShort: [source.model, source.size].filter(Boolean).join(" "),
+            primarySku: source.partNumber,
+            primaryBarcode: source.barcode,
+          };
+          const reviewId = get().reopenNeedsReview(code, preview.reason, {
+            importQuantity: source.quantity,
+            suggestion,
+          });
+          if (!reviewId) {
+            summary.rejected += 1;
+            continue;
+          }
+          if (preview.status !== "exact") {
+            summary.queuedForReview += 1;
+            continue;
+          }
+          get().resolveUnknown(reviewId, "create_new", {
+            origin: "human",
+            applyToCount: true,
+            newProduct: {
+              name: suggestion.name,
+              brand: suggestion.brand,
+              category: suggestion.category,
+              specsShort: suggestion.specsShort,
+              primarySku: suggestion.primarySku,
+              primaryBarcode: suggestion.primaryBarcode || code,
+            },
+          });
+          if (get().needsReviewQueue.find((review) => review.id === reviewId)?.status === "resolved") {
+            summary.applied += 1;
+          } else {
+            summary.queuedForReview += 1;
+          }
+        }
+        get().snapshotCount("After universal import");
+        return summary;
+      },
@@
-  // Non-destructive branch (v5..v7 -> v8): transform ONLY keys the persisted blob actually carries.
+  // Non-destructive branch (v5..v8 -> v9): transform ONLY keys the persisted blob actually carries.
@@
-    version: 8,
+    version: 9,
*** Update File: src/stores/scanStoreMigrate.test.ts
@@
   it("never injects empty keys into a PARTIAL blob (v7->v8 live regression: settings-only e2e seed lost every product)", () => {
@@
   });
+
+  it("keeps the v9 migration non-injective for a settings-only v8 blob", () => {
+    const migrated = scanStoreMigrate({ settings: { aiLookupEnabled: false } }, 8) as Record<string, unknown>;
+    expect("products" in migrated).toBe(false);
+    expect("scanFeed" in migrated).toBe(false);
+    expect("needsReviewQueue" in migrated).toBe(false);
+    expect(migrated.countSnapshots).toEqual([]);
+  });
*** End Patch
```

The interface currently contains one `reopenNeedsReview` declaration. Replace that declaration with the three-argument signature; do not leave both declarations after applying the patch. The duplicated diff context above is an explicit replacement target, not a request to add a second member.

- [ ] **Step 4: Make import review confirmations explicitly human**

```diff
*** Begin Patch
*** Update File: src/components/NeedsReviewTable.tsx
@@
   const myConflicts = (aliasConflicts ?? []).filter((c) => c.reviewId === review.id);
+  const importHumanOrigin = review.importQuantity !== undefined ? { origin: "human" as const } : {};
@@
-                onClick={() => resolveUnknown(review.id, "link_existing", { productId: warn.productId, applyToCount, confirmedMismatch: true })}
+                onClick={() => resolveUnknown(review.id, "link_existing", { productId: warn.productId, applyToCount, confirmedMismatch: true, ...importHumanOrigin })}
@@
                   resolveUnknown(review.id, "create_new", {
+                    ...importHumanOrigin,
                     newProduct: { name: np.name || review.cleanCode, brand: np.brand, category: np.category },
@@
                   resolveUnknown(review.id, "create_new", {
+                    ...importHumanOrigin,
                     applyToCount,
@@
-              onClick={() => resolveUnknown(review.id, "link_existing", { productId: linkId, applyToCount, selectedAliasCodes: selectedCodes })}
+              onClick={() => resolveUnknown(review.id, "link_existing", { productId: linkId, applyToCount, selectedAliasCodes: selectedCodes, ...importHumanOrigin })}
*** End Patch
```

- [ ] **Step 5: Create the complete container and replace the old products-page panel**

```tsx
// src/components/UniversalImportPanelContainer.tsx
"use client";

import { getSession } from "@/lib/auth";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import { isLiveAuth } from "@/services/auth/authMode";
import type { ColumnMapping, MappedImportRow } from "@/services/importSchema";
import type { PreviewMatchResult } from "@/services/universalImportPreview";
import { useScanStore } from "@/stores/scanStore";

async function token(): Promise<string | undefined> {
  if (!isLiveAuth()) return undefined;
  const user = await getSession();
  if (!user) throw new Error("Sign in required.");
  return user.getIdToken();
}

export function UniversalImportPanelContainer() {
  const businessId = useScanStore((state) => state.businessId);
  const applyUniversalImport = useScanStore((state) => state.applyUniversalImport);

  async function loadMapping(sourceSignature: string): Promise<ColumnMapping | null> {
    const idToken = await token();
    const query = new URLSearchParams({ businessId, sourceSignature, ...(idToken ? { idToken } : {}) });
    const response = await fetch(`/api/import-mapping?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json() as { mapping: ColumnMapping | null }).mapping;
  }

  async function saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void> {
    const idToken = await token();
    const response = await fetch("/api/import-mapping", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, sourceSignature, mapping, ...(idToken ? { idToken } : {}) }),
    });
    if (!response.ok) throw new Error("Import applied, but the column mapping could not be remembered.");
  }

  async function matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]> {
    const response = await fetch("/api/reconcile/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: rows.map((row) => row.expected) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "Could not match the uploaded rows.");
    return body.matches as PreviewMatchResult[];
  }

  return (
    <UniversalImportPanel
      loadMapping={loadMapping}
      saveMapping={saveMapping}
      matchRows={matchRows}
      onApply={async (rows) => applyUniversalImport(rows)}
    />
  );
}
```

```diff
*** Begin Patch
*** Update File: src/app/(app)/products/page.tsx
@@
-import { CsvImportPanel } from "@/components/CsvImportPanel";
+import { UniversalImportPanelContainer } from "@/components/UniversalImportPanelContainer";
@@
-      <CsvImportPanel />
+      <UniversalImportPanelContainer />
*** End Patch
```

- [ ] **Step 6: Run focused store, migration, persistence, and component tests**

Run: `npx vitest run src/stores/universalImport.store.test.ts src/stores/scanStoreMigrate.test.ts src/stores/scanPersist.test.ts src/components/NeedsReviewTable.test.tsx src/components/UniversalImportPanel.test.tsx`

Expected: PASS. Exact quantity 3 becomes count 3; fuzzy quantity 4 creates no alias/count before human confirm, then becomes count 4 after confirm; the v8 partial blob gains no absent keys.

---


## Task 11: Stage A ship gate - fixture battery, end-to-end demo proof, full sweep

**Stage:** A (final task of this plan; makes Stage A independently shippable and provable)

**Depends on:** Tasks 1 through 10 all complete. This task adds no production behavior; it proves the Stage A contract and satisfies master-plan acceptance criteria 1, 3, 4, and the Stage-A portion of 5. Acceptance criterion 2 (0 auto-applied fuzzy merges below threshold on adversarial near-duplicate fixtures) and the fuzzy portion of criterion 5 belong to the P4b Stage B follow-up and are explicitly NOT asserted here.

**Files:**

- Create: `src/services/import/__fixtures__/shopware.csv`
- Create: `src/services/import/__fixtures__/generic.xlsx.base64.txt` (an OOXML workbook payload, base64-encoded so it lives in the repo as text; the test decodes it to bytes for `readUniversalFile`)
- Create: `src/services/import/__fixtures__/reordered-renamed.tsv`
- Create: `src/services/import/__fixtures__/nonsense-headers.csv`
- Create: `src/services/import/importFixtureBattery.test.ts`
- Create: `src/services/import/importPerf.test.ts`
- Create: `e2e/phase4-universal-import.spec.ts`
- Modify: `PROGRESS.md`

**Interfaces:**

- Consumes only already-shipped Stage A exports: `readUniversalFile`, `buildSourceSignature`, `inferColumnMapping`, `validateManualMapping`, `sanitizeCell` (`@/services/importSchema`); the Stage A preview classifier and its `/api/reconcile/match` integration (Task 7); the retail enrichment (Task 8); `UniversalImportPanel` + `UniversalImportPanelContainer` and their testids `universal-import-panel` / `universal-import-file` / `column-mapping` / `import-preview` / `import-headline` / `import-summary` / `import-error` (Task 9); and `applyUniversalImport` (Task 10).
- Produces: no new source symbols. Produces proof artifacts and a phase checkpoint.

- [ ] **Step 1: Author the deterministic fixture battery**

Create the four fixtures. Keep every value ASCII (no em or en dash). `shopware.csv` uses real Shop-Ware-style headers; `reordered-renamed.tsv` uses `PN / Make / Model / Tire Size / QOH` in a shuffled order with an extra junk column and a blank leading row; `nonsense-headers.csv` uses headers that no synonym can map (`aaa,bbb,ccc,ddd`) so it forces the manual-mapping path; `generic.xlsx.base64.txt` is a small OOXML workbook. Each delimited fixture has a matching product already in the seed corpus for at least one row so the preview can report a nonzero exact match.

```
# src/services/import/__fixtures__/nonsense-headers.csv
aaa,bbb,ccc,ddd
Michelin,Defender T+H,225/65R17,8
```

- [ ] **Step 2: Write the fixture-battery test (RED first)**

```typescript
// src/services/import/importFixtureBattery.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSourceSignature } from "@/services/importSchema";
import { readUniversalFile } from "@/services/universalFileReader";
import { inferColumnMapping, validateManualMapping } from "@/services/columnIntelligence";

const dir = join(__dirname, "__fixtures__");
function file(name: string, type = "text/csv") {
  return { name, type, arrayBuffer: async () => readFileSync(join(dir, name)) } as unknown as Parameters<typeof readUniversalFile>[0];
}

describe("Stage A fixture battery (AC1, AC3)", () => {
  it("Shop-Ware headers import without the old four-name failure", async () => {
    const sheet = await readUniversalFile(file("shopware.csv"));
    const inference = inferColumnMapping(sheet.rows);
    expect(inference.mapping.name).toBeGreaterThanOrEqual(0);
    expect(inference.mapping.quantity).toBeGreaterThanOrEqual(0);
  });

  it("reordered/renamed/extra/blank-leading-row TSV maps by synonym, not position", async () => {
    const sheet = await readUniversalFile(file("reordered-renamed.tsv", "text/tab-separated-values"));
    const inference = inferColumnMapping(sheet.rows);
    expect(inference.mapping.partNumber).toBeGreaterThanOrEqual(0);
    expect(inference.mapping.tireSize).toBeGreaterThanOrEqual(0);
  });

  it("nonsense-header file yields low confidence and requires manual mapping (AC3)", async () => {
    const sheet = await readUniversalFile(file("nonsense-headers.csv"));
    const inference = inferColumnMapping(sheet.rows);
    expect(inference.confidence).toBe("low");
    const manual = validateManualMapping({ name: 0, tireSize: 2, quantity: 3 }, sheet.rows[0].length);
    expect(manual.ok).toBe(true);
  });

  it("the same file yields a stable source signature for mapping memory (AC3 remembered)", async () => {
    const sheet = await readUniversalFile(file("nonsense-headers.csv"));
    const a = buildSourceSignature(sheet.rows[0]);
    const b = buildSourceSignature(sheet.rows[0]);
    expect(a).toBe(b);
  });

  it("every imported cell passes through the sanitizer (no raw formula injection survives)", async () => {
    const sheet = await readUniversalFile(file("shopware.csv"));
    for (const row of sheet.rows) for (const cell of row) {
      expect(cell.startsWith("=") || cell.startsWith("+") || cell.startsWith("@")).toBe(false);
    }
  });
});
```

Run: `npx vitest run src/services/import/importFixtureBattery.test.ts` - expect FAIL until the fixtures exist, then PASS once the Step 1 fixtures are in place. Adjust the exact expected column indices to the fixtures you authored; do not weaken an assertion to pass.

- [ ] **Step 3: Write the performance test (AC4)**

```typescript
// src/services/import/importPerf.test.ts
import { describe, it, expect } from "vitest";
import { inferColumnMapping } from "@/services/columnIntelligence";

describe("Stage A performance (AC4)", () => {
  it("infers and shapes a 5000-row matrix in well under 10s", () => {
    const header = ["Part Number", "Make", "Model", "Tire Size", "QOH"];
    const matrix = [header, ...Array.from({ length: 5000 }, (_, i) => [`PN${i}`, "Michelin", "Defender", "225/65R17", "4"])];
    const start = Date.now();
    const inference = inferColumnMapping(matrix);
    expect(inference.mapping.partNumber).toBeGreaterThanOrEqual(0);
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
```

Run: `npx vitest run src/services/import/importPerf.test.ts` - expect PASS. (The full parse+match+preview 10s budget is exercised end to end by the Playwright spec; this unit guard pins the pure inference cost.)

- [ ] **Step 4: Write the end-to-end demo proof (AC5 Stage A portion, both viewports)**

```typescript
// e2e/phase4-universal-import.spec.ts
import { test, expect } from "./fixtures";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test.describe(`P4 universal import (${vp.name})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("upload to preview to apply to variance to Boss Report", async ({ page }) => {
      await page.route("**/api/ai-lookup", (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ json: { liveEnabled: false, mode: "off", missingKeys: ["GEMINI_API_KEY", "OPENAI_API_KEY"], e2e: true } })
          : route.fulfill({ json: {} }),
      );
      await page.goto("/products");
      await expect(page.getByTestId("universal-import-panel")).toBeVisible();
      await page.getByTestId("universal-import-file").setInputFiles("src/services/import/__fixtures__/reordered-renamed.tsv");
      await expect(page.getByTestId("import-preview")).toBeVisible();
      await expect(page.getByTestId("import-headline")).toContainText(/Matched \d+ of \d+ automatically/);
      await page.screenshot({ path: `e2e/proof/p4-preview-${vp.name}.png` });
      await page.getByTestId("import-apply").click();
      await expect(page.getByTestId("import-summary")).toBeVisible();
      await page.screenshot({ path: `e2e/proof/p4-applied-${vp.name}.png` });
    });
  });
}
```

Run: `npm run test:e2e -- phase4-universal-import` - expect PASS on both viewports; screenshots land in `e2e/proof/`. If the panel is not yet mounted on `/products` in mock mode, that is a real Task 9/10 gap - report it, do not stub around it. If the apply button testid differs from `import-apply`, use the real one from Task 9 and note it.

- [ ] **Step 5: Full Stage A gate sweep**

Run each and confirm the expected result; fix the root cause of any regression (never weaken a test):

- `npm run test` - all vitest projects PASS, including every new Task 1-11 file.
- `npm run test:ledger` - PASS (Task 10 touches the count path via `applyUniversalImport` to `processScan`/`resolveUnknown`).
- `npm run test:golden` - PASS, unchanged (Stage A does not touch decode identity).
- `npm run test:firebase` - PASS (import-mapping route membership rules ride existing tenant isolation).
- `npx tsc --noEmit` - clean (catches any `ImportField`/`ColumnMapping`/`importQuantity` drift across the 11 tasks).
- `npm run lint` - no new errors over the pre-existing baseline.
- `npm run build` - PASS (exercises the new `/api/import-mapping` route and the `/products` panel at build time).

Note: run `test:firebase` / `test:ledger` through Bash or cmd, not PowerShell, on this machine (the `npm.ps1` execution-policy block).

- [ ] **Step 6: Checkpoint PROGRESS.md**

Append a Phase 4 (Stage A) completion section to `PROGRESS.md`: branch name, the Task 1-11 commit range (`git log --oneline`), the acceptance-criteria table (AC1/AC3/AC4 satisfied here; AC2 and the fuzzy portion of AC5 deferred to the P4b Stage B plan with that reason stated), the demo-beat proof screenshots, and the surviving known limitations (legacy BIFF `.xls` rejected with actionable copy pending an owner-approved parser; `ladder_kv` reused for mapping memory pending a dedicated table). Then commit `PROGRESS.md`.

- [ ] **Step 7: Commit**

```bash
git add src/services/import/__fixtures__ src/services/import/importFixtureBattery.test.ts src/services/import/importPerf.test.ts e2e/phase4-universal-import.spec.ts PROGRESS.md
git commit -m "test(phase4): Stage A ship gate - fixture battery, 5000-row perf, end-to-end demo proof, checkpoint"
```

---

## Self-Review (author pass)

- **Spec coverage (this plan = Stage A).** AC1 (any-format import, four-name list gone): Tasks 2, 3, 4 + Task 11 fixtures. AC3 (column-mapping UI + remembered mapping): Tasks 3, 5, 6, 9 + Task 11 nonsense-header fixture. AC4 (5000-row < 10s): Task 11 perf test + the Playwright budget. AC5 Stage A portion (import to preview to apply to variance to Boss Report, both viewports): Tasks 7, 9, 10 + Task 11 e2e. AC2 (0 auto-applied fuzzy merges below threshold on adversarial fixtures) and the fuzzy half of AC5 are correctly DEFERRED to the P4b Stage B follow-up plan, because Stage B is gated strictly behind Task 11 and the master plan stages it separately so its tuning cannot delay Stage A. Gap check: none within Stage A scope.
- **Landmines honored.** Canonical `jaccard` from `identityMerge.ts` only; `JACCARD_THRESHOLD` single export (Task 7); every imported cell through `sanitizeCell` including the previously-uncovered Shop-Ware path (Task 2); fuzzy never auto-approves (enforced now by there being no fuzzy path in Stage A, and carried into P4b); Turso KV mapping memory works in mock and live; persist bumped to v9 with the v8 no-inject-absent-keys migrate rule preserved (Task 10); OOXML-named-`.xls` accepted by content, true BIFF `.xls` rejected with exact actionable copy (Task 4). No em or en dash. No new paid or AI call.
- **Type consistency.** `ImportField` / `ColumnMapping` / `MappingSource` (Task 1) flow unchanged through Tasks 3, 6, 9; `ImportPreview` / `ImportPreviewRow` / `ImportPreviewStatus` (Task 1) produced by Task 7, consumed by Tasks 9 and 10; `applyUniversalImport(rows: ImportPreviewRow[]): UniversalImportApplySummary` and `UnknownCodeReview.importQuantity` (Task 10) consumed by the Task 11 e2e. `readUniversalFile` / `buildSourceSignature` / `sanitizeCell` (Tasks 2, 4) consumed by the Task 11 battery.
- **Execution note (orchestrator).** Codex authored Tasks 6-10; Opus authored Task 11, reordered the file to sequential 1-11, and reconciled the Global Constraints and dependency map to a Stage-A-only scope. A full Codex adversarial review of the whole plan runs before execution.

## Task 10: Unify all three import paths and pin Stage A performance

**Stage:** A

**Parallel boundary:** Run after Tasks 1 through 4, in parallel with Tasks 5, 6, 8, and 9. This task alone owns the legacy adapter edits and import service fixtures.

**Design ruling encoded:** Delete the D9 four-string part-number list and make all three existing import paths consume the shared header vocabulary. Measure the 5,000-row, 10-second target across file read, inference, row mapping, matcher-result shaping, and preview construction.

**Files:**

- Modify: src/services/columnIntelligence.ts
- Modify: src/services/csvImport.ts
- Modify: src/services/reconcile/shopwareCsvAdapter.ts
- Test: src/services/csvImport.test.ts
- Test: src/services/reconcile/shopwareCsvAdapter.test.ts
- Create: src/services/fixtures/import/shopware.csv
- Create: src/services/fixtures/import/reordered-renamed.tsv
- Create: src/services/fixtures/import/nonsense-headers.csv
- Create: src/services/universalImport.stageA.test.ts
- Create: src/services/universalImport.performance.test.ts

**Interfaces:**

- Consumes: HEADER_SYNONYMS, normalizeImportHeader(value: string): string, sanitizeCell(raw: string): string, readUniversalFile(file: UploadFileLike): Promise<UniversalSheet>, inferColumnMapping(matrix: string[][]): ColumnInference, mapUniversalRows(sheet: UniversalSheet, mapping: ColumnMapping): MappingResult, and buildImportPreview(mapped: MappingResult, matches: PreviewMatchResult[], mappingSource: MappingSource): ImportPreview.
- Produces: importFieldForHeader(value: string): ImportField | undefined, pickImportedField(row: Record<string, string>, field: ImportField): string, a Shop-Ware adapter with no SHOPWARE_COLUMN_MAP.partNumber list, and the complete performance guard.

- [ ] **Step 1: Create the complete text fixtures**

~~~csv
# src/services/fixtures/import/shopware.csv
PN,Make,Model,Tire Size,QOH,UOM,Cost
ABC-1,Acme,Road,225/45R18,7,each,99
ABC-2,Acme,Road Plus,225/45R18,2,each,105
ABC-3,=Formula Brand,@Formula Model,225/45R18,1,each,88
~~~

~~~text
# src/services/fixtures/import/reordered-renamed.tsv
Ignore Me	QOH	Tire Size	Model	Make	Item No.
junk	4	225/45R18	Road	Acme	ABC-1
junk	3	245/40R18	Road Sport	Acme	ABC-4
~~~

~~~csv
# src/services/fixtures/import/nonsense-headers.csv
aaa,bbb,ccc,ddd
ABC-9,Acme,Road,6
~~~

- [ ] **Step 2: Write the complete fixture and performance tests**

~~~typescript
// src/services/universalImport.stageA.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferColumnMapping, validateManualMapping } from "@/services/columnIntelligence";
import { readUniversalFile } from "@/services/universalFileReader";

const root = join(process.cwd(), "src", "services", "fixtures", "import");

function fixture(name: string, type: string) {
  const bytes = readFileSync(join(root, name));
  return {
    name,
    type,
    text: async () => bytes.toString("utf8"),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe("Stage A fixture battery", () => {
  it("maps Shop-Ware core fields without format-specific code", async () => {
    const sheet = await readUniversalFile(fixture("shopware.csv", "text/csv"));
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    expect(inferred.mapping).toMatchObject({
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
      uom: 5,
    });
    expect(sheet.rows[2][1]).toBe("'=Formula Brand");
    expect(sheet.rows[2][2]).toBe("'@Formula Model");
  });

  it("maps reordered TSV columns and ignores the extra column", async () => {
    const sheet = await readUniversalFile(fixture("reordered-renamed.tsv", "text/tab-separated-values"));
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    expect(inferred.mapping).toMatchObject({
      quantity: 1,
      size: 2,
      model: 3,
      brand: 4,
      partNumber: 5,
    });
    expect(Object.values(inferred.mapping)).not.toContain(0);
  });

  it("forces a valid manual map for nonsense headers", async () => {
    const sheet = await readUniversalFile(fixture("nonsense-headers.csv", "text/csv"));
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    expect(inferred.confidence).toBe("low");
    expect(validateManualMapping(sheet.headers, {
      partNumber: 0,
      brand: 1,
      model: 2,
      quantity: 3,
    })).toEqual({ ok: true });
  });
});
~~~

~~~typescript
// src/services/universalImport.performance.test.ts
import { describe, expect, it } from "vitest";
import { inferColumnMapping } from "@/services/columnIntelligence";
import type { PreviewMatchResult } from "@/services/universalImportPreview";
import { buildImportPreview, mapUniversalRows } from "@/services/universalImportPreview";
import { readUniversalFile } from "@/services/universalFileReader";

describe("universal import performance", () => {
  it("processes 5,000 rows to preview in less than 10 seconds", async () => {
    const header = "PN,Make,Model,Tire Size,QOH";
    const rows = Array.from({ length: 5_000 }, (_, index) =>
      ["PN-" + index, "Acme", "Road " + index, "225/45R18", "4"].join(","),
    );
    const csv = [header, ...rows].join("\n");
    const file = {
      name: "five-thousand.csv",
      type: "text/csv",
      text: async () => csv,
      arrayBuffer: async () => new TextEncoder().encode(csv).buffer,
    };
    const startedAt = performance.now();
    const sheet = await readUniversalFile(file);
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    const mapped = mapUniversalRows(sheet, inferred.mapping);
    const matches: PreviewMatchResult[] = mapped.rows.map((row) => ({
      row: row.expected,
      status: "matched",
      reason: "Part number hit for exact candidate.",
      confidence: 1,
      matchBasis: "part_number_exact",
      candidate: { uid: "candidate-" + row.line, brand: row.brand, name: row.model },
    }));
    const preview = buildImportPreview(mapped, matches, inferred.source);
    const elapsedMs = performance.now() - startedAt;
    expect(preview.total).toBe(5_000);
    expect(preview.exact).toBe(5_000);
    expect(preview.headline).toBe("Matched 5000 of 5000 automatically");
    expect(elapsedMs).toBeLessThan(10_000);
  }, 12_000);
});
~~~

- [ ] **Step 3: Run the tests and verify the expected failures**

Run: npx vitest run src/services/universalImport.stageA.test.ts src/services/universalImport.performance.test.ts

Expected: FAIL because importFieldForHeader is private and the legacy adapters do not share it.

- [ ] **Step 4: Apply the complete shared-header patch**

~~~diff
*** Begin Patch
*** Update File: src/services/columnIntelligence.ts
@@
-function fieldForHeader(value: string): ImportField | undefined {
+export function importFieldForHeader(value: string): ImportField | undefined {
   const normalized = normalizeImportHeader(value);
   return (Object.keys(HEADER_SYNONYMS) as ImportField[]).find((field) =>
     HEADER_SYNONYMS[field].includes(normalized),
   );
 }
+
+export function pickImportedField(row: Record<string, string>, field: ImportField): string {
+  for (const [header, value] of Object.entries(row)) {
+    if (importFieldForHeader(header) === field && value.trim() !== "") return value;
+  }
+  return "";
+}
@@
-  return row.filter((cell) => fieldForHeader(cell)).length;
+  return row.filter((cell) => importFieldForHeader(cell)).length;
@@
-    const field = fieldForHeader(header);
+    const field = importFieldForHeader(header);
*** Update File: src/services/csvImport.ts
@@
 import { isGtinShaped } from "@/services/catalog/barcodeGrade";
+import { pickImportedField } from "@/services/columnIntelligence";
@@
-    const name = pick(row, ["name", "product_name"]);
-    const brand = pick(row, ["brand"]);
-    const category = pick(row, ["category"]);
+    const name = pickImportedField(row, "name");
+    const brand = pickImportedField(row, "brand");
+    const category = pickImportedField(row, "category");
@@
-    const primarySku = pick(row, ["sku", "primary_sku"]);
-    const primaryBarcode = pick(row, ["barcode", "primary_barcode"]);
+    const primarySku = pickImportedField(row, "partNumber");
+    const primaryBarcode = pickImportedField(row, "barcode");
*** Update File: src/services/reconcile/shopwareCsvAdapter.ts
@@
 import { sanitizeCell } from "@/services/csvImport";
+import { importFieldForHeader } from "@/services/columnIntelligence";
@@
-  partNumber: [
-    "part_number",
-    "part number",
-    "part_no",
-    "sku",
-    "part_#",
-    "part #",
-    "pn",
-    "item_no.",
-    "item no.",
-    "item_no",
-    "item no",
-    "mfg_part_number",
-    "mfg part number",
-  ],
@@
 function findHeaderKey(headers: string[], candidates: readonly string[]): string | undefined {
@@
 }
+
+function findUniversalHeader(
+  headers: string[],
+  field: "partNumber" | "brand" | "model" | "size" | "quantity" | "uom",
+): string | undefined {
+  return headers.find((header) => importFieldForHeader(header) === field);
+}
@@
-  const partNumberKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.partNumber);
+  const partNumberKey = findUniversalHeader(headers, "partNumber");
@@
-  const brandKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.brand);
-  const modelKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.model);
-  const sizeKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.size);
+  const brandKey = findUniversalHeader(headers, "brand");
+  const modelKey = findUniversalHeader(headers, "model");
+  const sizeKey = findUniversalHeader(headers, "size");
@@
-  const qtyOnHandKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.qtyOnHand);
+  const qtyOnHandKey = findUniversalHeader(headers, "quantity");
@@
-  const unitKey = findHeaderKey(headers, SHOPWARE_COLUMN_MAP.unit);
+  const unitKey = findUniversalHeader(headers, "uom");
*** End Patch
~~~

Shop-Ware-only alias part numbers, available quantity fallback, specs, location, and cost filtering stay in SHOPWARE_COLUMN_MAP. Only shared identity, QOH, and UOM fields move to the universal vocabulary.

- [ ] **Step 5: Run focused and adjacent tests**

Run: npx vitest run src/services/universalImport.stageA.test.ts src/services/universalImport.performance.test.ts src/services/csvImport.test.ts src/services/csvImport.trustGate.test.ts src/services/reconcile/shopwareCsvAdapter.test.ts

Expected: PASS. The four-name list is gone, all three paths accept the same core headers, and the full 5,000-row preview takes less than 10,000 ms.

---

## Task 11: Add the quantity-aware import resolution variant and wire Apply

**Stage:** A

**Depends on:** Tasks 1 through 10.

**Monolith warning:** This is the only Stage A edit to src/stores/scanStore.ts. It runs after pure and server work. No unrelated monolith cleanup is allowed.

**Design rulings encoded:** Preview state cannot call this action. Exact human-upload rows retain approved: true. Fuzzy and ambiguous rows create Needs Review only. resolveImportReview is separate from reconcile confirm-link because import rows carry quantity. New persisted fields follow scanStoreMigrate(persisted: unknown, version: number): unknown at src/stores/scanStore.ts:5685 and its v8 no-inject-absent-keys rule at line 5703; current persist version 8 is at line 5733.

**Files:**

- Modify: src/services/importSchema.ts
- Modify: src/types.ts
- Modify: src/services/security/sensitiveFields.ts
- Modify: src/stores/scanStore.ts
- Modify: src/stores/scanStoreMigrate.test.ts
- Create: src/stores/universalImport.store.test.ts
- Modify: src/components/NeedsReviewTable.tsx
- Create: src/components/UniversalImportPanelContainer.tsx
- Modify: src/app/(app)/products/page.tsx

**Interfaces:**

- Consumes: ImportPreviewRow[], reopenNeedsReview(cleanCode: string, reason: string): string | null, resolveUnknown(reviewId: string, action: ResolveUnknownAction, payload: ResolveUnknownPayload): void, processScan(rawCode: string): void, and snapshotCount(label: string): CountSnapshot.
- Produces: UnknownCodeReview.importQuantity?: number, UnknownCodeReview.importEventId?: string, ImportReviewContext.importEventId: string, reopenNeedsReview(cleanCode: string, reason: string, importContext?: ImportReviewContext): string | null, resolveImportReview(reviewId: string, action: "create_new" | "link_existing", payload: ResolveUnknownPayload): void, and applyUniversalImport(rows: ImportPreviewRow[]): UniversalImportApplySummary.

- [ ] **Step 1: Write the complete store regression test**

~~~typescript
// src/stores/universalImport.store.test.ts
import { describe, expect, it } from "vitest";
import type { ImportPreviewRow } from "@/services/importSchema";
import { createTestScanStore } from "@/stores/scanStore";

function row(status: "exact" | "fuzzy" | "review", code: string, quantity: number): ImportPreviewRow {
  return {
    line: 2,
    status,
    reason: status === "exact" ? "Exact uploaded identity." : "Candidate needs review.",
    confidence: status === "exact" ? 1 : 0.8,
    candidate: { uid: "candidate-" + code, brand: "Acme", name: "Road", partNumber: code },
    source: {
      line: 2,
      expected: {
        externalId: code,
        partNumbers: [code],
        brand: "Acme",
        model: "Road",
        sizeText: "225/45R18",
        qty: quantity,
        raw: {},
      },
      partNumber: code,
      barcode: "",
      name: "",
      brand: "Acme",
      model: "Road",
      size: "225/45R18",
      category: "Tires",
      quantity,
      uom: "each",
    },
  };
}

describe("universal import store bridge", () => {
  it("does not mutate state while preview data merely exists", () => {
    const store = createTestScanStore();
    expect([row("exact", "PN-1", 3)]).toHaveLength(1);
    expect(store.getState().aliases).toEqual([]);
    expect(store.getState().finalCounts).toEqual([]);
    expect(store.getState().needsReviewQueue).toEqual([]);
    expect(store.getState().countSnapshots).toEqual([]);
  });

  it("applies an exact human row with approved alias and full quantity", () => {
    const store = createTestScanStore();
    expect(store.getState().applyUniversalImport([row("exact", "PN-1", 3)])).toEqual({
      applied: 1,
      queuedForReview: 0,
      rejected: 0,
    });
    expect(store.getState().aliases).toContainEqual(expect.objectContaining({
      cleanCode: "PN-1",
      approved: true,
    }));
    expect(store.getState().finalCounts.reduce((sum, item) => sum + item.quantity, 0)).toBe(3);
    expect(store.getState().countSnapshots.map((item) => item.label)).toEqual([
      "Before universal import",
      "After universal import",
    ]);
  });

  it("stages fuzzy quantity with no alias or count", () => {
    const store = createTestScanStore();
    expect(store.getState().applyUniversalImport([row("fuzzy", "PN-2", 4)])).toEqual({
      applied: 0,
      queuedForReview: 1,
      rejected: 0,
    });
    expect(store.getState().needsReviewQueue).toContainEqual(expect.objectContaining({
      cleanCode: "PN-2",
      importQuantity: 4,
      importEventId: expect.any(String),
      status: "open",
    }));
    expect(store.getState().aliases).toEqual([]);
    expect(store.getState().finalCounts).toEqual([]);
  });

  it("applies stored quantity only through resolveImportReview", () => {
    const store = createTestScanStore();
    store.getState().applyUniversalImport([row("review", "PN-3", 5)]);
    const review = store.getState().needsReviewQueue.find((item) => item.cleanCode === "PN-3");
    store.getState().resolveImportReview(review!.id, "create_new", {
      origin: "human",
      applyToCount: false,
      newProduct: {
        name: "Acme Road",
        brand: "Acme",
        category: "Tires",
        specsShort: "225/45R18",
        primarySku: "PN-3",
        primaryBarcode: "PN-3",
      },
    });
    expect(store.getState().aliases).toContainEqual(expect.objectContaining({
      cleanCode: "PN-3",
      approved: true,
    }));
    expect(store.getState().finalCounts.reduce((sum, item) => sum + item.quantity, 0)).toBe(5);
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/stores/universalImport.store.test.ts

Expected: FAIL because the import-specific persisted fields and actions do not exist.

- [ ] **Step 3: Apply the complete contract and monolith patch**

~~~diff
*** Begin Patch
*** Update File: src/services/importSchema.ts
@@
 export interface ImportReviewContext {
   importQuantity: number;
+  importEventId: string;
   suggestion?: {
*** Update File: src/types.ts
@@
 export interface UnknownCodeReview {
@@
   provisionalProductId?: string | null;
+  importQuantity?: number;
+  importEventId?: string;
 }
*** Update File: src/services/security/sensitiveFields.ts
@@
   "provisionalProductId",
+  "importQuantity",
+  "importEventId",
 ] as const;
*** Update File: src/stores/scanStore.ts
@@
 import type { AiStatus } from "@/types";
+import type { ImportPreviewRow, ImportReviewContext, UniversalImportApplySummary } from "@/services/importSchema";
+import { buildSourceSignature } from "@/services/importSchema";
@@
-  reopenNeedsReview: (cleanCode: string, reason: string) => string | null;
+  reopenNeedsReview: (cleanCode: string, reason: string, importContext?: ImportReviewContext) => string | null;
+  resolveImportReview: (
+    reviewId: string,
+    action: "create_new" | "link_existing",
+    payload: ResolveUnknownPayload,
+  ) => void;
+  applyUniversalImport: (rows: ImportPreviewRow[]) => UniversalImportApplySummary;
@@
-      reopenNeedsReview: (cleanCode, reason) => {
+      reopenNeedsReview: (cleanCode, reason, importContext) => {
@@
                     reopenedFromWrong: true,
+                    importQuantity: importContext?.importQuantity,
+                    importEventId: importContext?.importEventId,
                   }
@@
           idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, id, "SAVE_UNKNOWN_SCAN"),
+          importQuantity: importContext?.importQuantity,
+          importEventId: importContext?.importEventId,
         };
@@
       resolveUnknown: (reviewId, action, payload) => {
@@
       },
+
+      resolveImportReview: (reviewId, action, payload) => {
+        const review = get().needsReviewQueue.find((item) => item.id === reviewId);
+        if (
+          !review ||
+          review.status !== "open" ||
+          review.importQuantity === undefined ||
+          !Number.isSafeInteger(review.importQuantity) ||
+          review.importQuantity < 0 ||
+          !review.importEventId
+        ) return;
+        get().resolveUnknown(reviewId, action, {
+          ...payload,
+          origin: "human",
+          applyToCount: false,
+        });
+        if (get().needsReviewQueue.find((item) => item.id === reviewId)?.status !== "resolved") return;
+        for (let index = 0; index < review.importQuantity; index += 1) {
+          get().processScan(review.rawCode || review.cleanCode);
+        }
+      },
+
+      applyUniversalImport: (rows) => {
+        get().ensureAutoSession();
+        if (!get().currentSession || get().currentSession?.status !== "active") {
+          throw new Error("Start or unlock an active session before applying this import.");
+        }
+        const summary: UniversalImportApplySummary = { applied: 0, queuedForReview: 0, rejected: 0 };
+        get().snapshotCount("Before universal import");
+        for (const preview of rows) {
+          if (preview.status === "reject" || !preview.source) {
+            summary.rejected += 1;
+            continue;
+          }
+          const source = preview.source;
+          const code = source.barcode || source.partNumber || source.name;
+          const suggestion = {
+            name: preview.retailCatalogMatch?.productName || preview.candidate?.name || source.expected.name || code,
+            brand: preview.retailCatalogMatch?.brand || preview.candidate?.brand || source.brand,
+            category: preview.retailCatalogMatch?.category || source.category,
+            specsShort: [source.model, source.size].filter(Boolean).join(" "),
+            primarySku: source.partNumber,
+            primaryBarcode: source.barcode,
+          };
+          const importEventId = buildSourceSignature([
+            code,
+            String(source.line),
+            String(source.quantity),
+            source.brand,
+            source.model,
+            source.size,
+          ]);
+          const reviewId = get().reopenNeedsReview(code, preview.reason, {
+            importQuantity: source.quantity,
+            importEventId,
+            suggestion,
+          });
+          if (!reviewId) {
+            summary.rejected += 1;
+            continue;
+          }
+          if (preview.status !== "exact") {
+            summary.queuedForReview += 1;
+            continue;
+          }
+          get().resolveImportReview(reviewId, "create_new", {
+            origin: "human",
+            applyToCount: false,
+            newProduct: {
+              name: suggestion.name,
+              brand: suggestion.brand,
+              category: suggestion.category,
+              specsShort: suggestion.specsShort,
+              primarySku: suggestion.primarySku,
+              primaryBarcode: suggestion.primaryBarcode || code,
+            },
+          });
+          if (get().needsReviewQueue.find((item) => item.id === reviewId)?.status === "resolved") {
+            summary.applied += 1;
+          } else {
+            summary.queuedForReview += 1;
+          }
+        }
+        get().snapshotCount("After universal import");
+        return summary;
+      },
@@
-  // Non-destructive branch (v5..v7 -> v8): transform ONLY keys the persisted blob actually carries.
+  // Non-destructive branch (v5..v8 -> v9): transform ONLY keys the persisted blob actually carries.
@@
-    version: 8,
+    version: 9,
*** Update File: src/stores/scanStoreMigrate.test.ts
@@
   it("never injects empty keys into a PARTIAL blob (v7->v8 live regression: settings-only e2e seed lost every product)", () => {
@@
   });
+
+  it("does not inject import keys into a settings-only v8 blob", () => {
+    const migrated = scanStoreMigrate(
+      { settings: { aiLookupEnabled: false } },
+      8,
+    ) as Record<string, unknown>;
+    expect("products" in migrated).toBe(false);
+    expect("scanFeed" in migrated).toBe(false);
+    expect("needsReviewQueue" in migrated).toBe(false);
+    expect(migrated.countSnapshots).toEqual([]);
+  });
*** End Patch
~~~

The quantity loop exists only in resolveImportReview. The existing resolveUnknown and ReconcilePanel confirm-link path remain unchanged and keep applyToCount: false.

- [ ] **Step 4: Route import rows through the distinct confirm action**

~~~diff
*** Begin Patch
*** Update File: src/components/NeedsReviewTable.tsx
@@
   const resolveUnknown = useScanStore((state) => state.resolveUnknown);
+  const resolveImportReview = useScanStore((state) => state.resolveImportReview);
@@
+  const resolveReview = (
+    action: "create_new" | "link_existing",
+    payload: Parameters<typeof resolveUnknown>[2],
+  ) => {
+    if (review.importQuantity !== undefined) {
+      resolveImportReview(review.id, action, { ...payload, origin: "human", applyToCount: false });
+      return;
+    }
+    resolveUnknown(review.id, action, payload);
+  };
@@
-                onClick={() => resolveUnknown(review.id, "link_existing", { productId: warn.productId, applyToCount, confirmedMismatch: true })}
+                onClick={() => resolveReview("link_existing", { productId: warn.productId, applyToCount, confirmedMismatch: true })}
@@
-                  resolveUnknown(review.id, "create_new", {
+                  resolveReview("create_new", {
@@
-                  resolveUnknown(review.id, "create_new", {
+                  resolveReview("create_new", {
@@
-              onClick={() => resolveUnknown(review.id, "link_existing", { productId: linkId, applyToCount, selectedAliasCodes: selectedCodes })}
+              onClick={() => resolveReview("link_existing", { productId: linkId, applyToCount, selectedAliasCodes: selectedCodes })}
*** End Patch
~~~

- [ ] **Step 5: Create the complete client container and mount it**

~~~tsx
// src/components/UniversalImportPanelContainer.tsx
"use client";

import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import { getSession } from "@/lib/auth";
import type { ColumnMapping, MappedImportRow } from "@/services/importSchema";
import { isLiveAuth } from "@/services/auth/authMode";
import type { PreviewMatchResult } from "@/services/universalImportPreview";
import { useScanStore } from "@/stores/scanStore";

async function idToken(): Promise<string | undefined> {
  if (!isLiveAuth()) return undefined;
  const user = await getSession();
  if (!user) throw new Error("Sign in required.");
  return user.getIdToken();
}

export function UniversalImportPanelContainer() {
  const businessId = useScanStore((state) => state.businessId);
  const applyUniversalImport = useScanStore((state) => state.applyUniversalImport);

  async function loadMapping(sourceSignature: string): Promise<ColumnMapping | null> {
    const token = await idToken();
    const query = new URLSearchParams({ businessId, sourceSignature });
    const response = await fetch("/api/import-mapping?" + query.toString(), {
      cache: "no-store",
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    if (!response.ok) return null;
    return ((await response.json()) as { mapping: ColumnMapping | null }).mapping;
  }

  async function saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void> {
    const token = await idToken();
    const response = await fetch("/api/import-mapping", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify({ businessId, sourceSignature, mapping }),
    });
    if (!response.ok) throw new Error("Import applied, but the column mapping was not remembered.");
  }

  async function matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]> {
    const response = await fetch("/api/reconcile/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: rows.map((row) => row.expected) }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      matches?: PreviewMatchResult[];
    };
    if (!response.ok || !body.matches) throw new Error(body.error || "Could not match imported rows.");
    return body.matches;
  }

  return (
    <UniversalImportPanel
      loadMapping={loadMapping}
      saveMapping={saveMapping}
      matchRows={matchRows}
      onApply={async (rows) => applyUniversalImport(rows)}
    />
  );
}
~~~

~~~diff
*** Begin Patch
*** Update File: src/app/(app)/products/page.tsx
@@
-import { CsvImportPanel } from "@/components/CsvImportPanel";
+import { UniversalImportPanelContainer } from "@/components/UniversalImportPanelContainer";
@@
-      <CsvImportPanel />
+      <UniversalImportPanelContainer />
*** End Patch
~~~

- [ ] **Step 6: Run store, migration, and bridge tests**

Run: npx vitest run src/stores/universalImport.store.test.ts src/stores/scanStoreMigrate.test.ts src/stores/scanPersist.test.ts src/components/NeedsReviewTable.test.tsx src/components/UniversalImportPanel.test.tsx

Expected: PASS. Preview-only data makes zero writes. Exact Apply produces an approved alias and full quantity. Fuzzy Apply makes an open review with zero alias and count. Human resolveImportReview applies the stored quantity. Partial v8 state gains no absent product, review, or feed keys.

---

## Task 12: Prove Stage A ships independently at both viewports

**Stage:** A ship gate

**Depends on:** Tasks 1 through 11. Task 13 cannot start until this task is green.

**Design ruling encoded:** Prove the one-screen Matched 380 of 400 automatically beat, preview-before-apply, delayed mapping write, quantity application, variance, Boss Report, and both viewports without Stage B.

**Files:**

- Create: e2e/phase4-universal-import.spec.ts
- Create: e2e/phase4-universal-import.visual.spec.ts

**Interfaces:**

- Consumes: UniversalImportPanelContainer, POST /api/reconcile/match, GET and PUT /api/import-mapping, applyUniversalImport(rows: ImportPreviewRow[]): UniversalImportApplySummary, the /scan variance UI, and /report Boss Report UI.
- Produces: no production symbol; produces functional and visual proof at 1280 by 800 and 390 by 844.

- [ ] **Step 1: Write the complete functional proof**

~~~typescript
// e2e/phase4-universal-import.spec.ts
import { expect, test } from "./fixtures";

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

function uploadCsv(): string {
  const header = "PN,Make,Model,Tire Size,QOH";
  const rows = Array.from({ length: 400 }, (_, index) =>
    ["PN-" + index, "Acme", "Road " + index, "225/45R18", "1"].join(","),
  );
  return [header, ...rows].join("\n");
}

for (const viewport of viewports) {
  test.describe("Phase 4 Stage A " + viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("upload, preview, apply, variance, and Boss Report", async ({ page }) => {
      let mappingWrites = 0;
      await page.route("**/api/import-mapping**", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({ json: { mapping: null } });
          return;
        }
        mappingWrites += 1;
        await route.fulfill({ json: { ok: true } });
      });
      await page.route("**/api/reconcile/match", async (route) => {
        const body = route.request().postDataJSON() as { rows: Array<Record<string, unknown>> };
        await route.fulfill({
          json: {
            matches: body.rows.map((row, index) => index < 380
              ? {
                  row,
                  status: "matched",
                  reason: "Part number hit for exact candidate.",
                  confidence: 1,
                  matchBasis: "part_number_exact",
                  candidate: { uid: "candidate-" + index, brand: "Acme", name: "Road " + index },
                }
              : {
                  row,
                  status: "ambiguous",
                  reason: "Two candidates require review.",
                  confidence: 0.8,
                  candidates: [
                    { uid: "a-" + index, brand: "Acme", name: "Road " + index },
                    { uid: "b-" + index, brand: "Acme", name: "Road " + index },
                  ],
                }),
          },
        });
      });

      await page.goto("/products");
      await page.getByTestId("universal-import-file").setInputFiles({
        name: "demo.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(uploadCsv()),
      });
      await expect(page.getByTestId("import-headline")).toHaveText("Matched 380 of 400 automatically");
      await expect(page.getByTestId("import-preview")).toBeVisible();
      expect(mappingWrites).toBe(0);

      const beforeApply = await page.evaluate(() => {
        const state = window.__scanStore?.getState();
        return {
          aliases: state?.aliases.length,
          counts: state?.finalCounts.length,
          reviews: state?.needsReviewQueue.length,
          snapshots: state?.countSnapshots.length,
        };
      });
      expect(beforeApply).toEqual({ aliases: 0, counts: 0, reviews: 0, snapshots: 0 });

      await page.getByTestId("import-apply").click();
      await expect(page.getByTestId("import-summary")).toContainText(
        "Applied 380. Needs Review 20. Rejected 0.",
      );
      expect(mappingWrites).toBe(1);

      await page.goto("/scan");
      await expect(page.getByText("Before universal import")).toBeVisible();
      await expect(page.getByText("After universal import")).toBeVisible();

      await page.goto("/report");
      await expect(page.getByText("Top variances")).toBeVisible();
    });
  });
}
~~~

- [ ] **Step 2: Write the complete responsive visual proof**

~~~typescript
// e2e/phase4-universal-import.visual.spec.ts
import { expect, test } from "./fixtures";

const cases = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

for (const item of cases) {
  test("Phase 4 import surface is readable at " + item.name, async ({ page }) => {
    await page.setViewportSize({ width: item.width, height: item.height });
    await page.goto("/products");
    await expect(page.getByTestId("universal-import-panel")).toBeVisible();
    await expect(page).toHaveScreenshot("phase4-universal-import-" + item.name + ".png", {
      fullPage: true,
      animations: "disabled",
    });
  });
}
~~~

- [ ] **Step 3: Run the focused Stage A proof**

Run: npm run test:e2e -- phase4-universal-import.spec.ts phase4-universal-import.visual.spec.ts

Expected: PASS at desktop and phone. The functional test observes zero writes before Apply, the exact 380 of 400 headline, one mapping write after Apply, 380 applied rows, 20 Needs Review rows, both snapshots, variance, and Boss Report. Review visual baselines intentionally.

- [ ] **Step 4: Run the full Stage A gate**

Run: npm run test

Expected: PASS for all Vitest projects, including Tasks 1 through 11.

Run: npm run test:ledger

Expected: PASS because Task 11 changes quantity application.

Run: npm run test:golden

Expected: PASS with decode identity unchanged.

Run: npm run test:firebase

Expected: PASS with mapping-route tenant checks.

Run: npx tsc --noEmit

Expected: no TypeScript errors.

Run: npm run lint

Expected: no new lint errors.

Run: npm run build

Expected: PASS with the new route and Products panel.

Run: npm run qa:revision

Expected: PASS after intentional desktop and phone screenshot review.

---

## Task 13: Implement the net-new character-level edit-distance primitive

**Stage:** B

**Hard ordering:** Start only after Task 12 passes. This task cannot delay Stage A.

**Files:**

- Create: src/services/reconcile/normalizedEditDistance.ts
- Test: src/services/reconcile/normalizedEditDistance.test.ts

**Interfaces:**

- Consumes: two untrusted strings.
- Produces: normalizedEditSimilarity(left: string, right: string): number, always a finite value from 0 through 1.

- [ ] **Step 1: Write the complete failing test**

~~~typescript
// src/services/reconcile/normalizedEditDistance.test.ts
import { describe, expect, it } from "vitest";
import { normalizedEditSimilarity } from "@/services/reconcile/normalizedEditDistance";

describe("normalizedEditSimilarity", () => {
  it("handles exact, empty, and unrelated strings", () => {
    expect(normalizedEditSimilarity("Michelin", "michelin")).toBe(1);
    expect(normalizedEditSimilarity("", "")).toBe(1);
    expect(normalizedEditSimilarity("", "road")).toBe(0);
    expect(normalizedEditSimilarity("abc", "xyz")).toBe(0);
  });

  it("scores a one-character brand typo at or above 0.75", () => {
    expect(normalizedEditSimilarity("Michelin", "Micheln")).toBeGreaterThanOrEqual(0.75);
  });

  it("is symmetric", () => {
    expect(normalizedEditSimilarity("Defender", "Defendr")).toBe(
      normalizedEditSimilarity("Defendr", "Defender"),
    );
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/services/reconcile/normalizedEditDistance.test.ts

Expected: FAIL with Cannot find module '@/services/reconcile/normalizedEditDistance'.

- [ ] **Step 3: Create the complete primitive**

~~~typescript
// src/services/reconcile/normalizedEditDistance.ts
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizedEditSimilarity(left: string, right: string): number {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        substitution,
      );
    }
    previous = current;
  }

  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
~~~

- [ ] **Step 4: Run the focused test**

Run: npx vitest run src/services/reconcile/normalizedEditDistance.test.ts

Expected: PASS, 3 tests.

---

## Task 14: Build the conservative Stage B fuzzy matcher

**Stage:** B

**Depends on:** Task 13.

**Design rulings encoded:** IDENTITY_JACCARD_THRESHOLD = 0.75 plus nameTokens and jaccard from src/services/catalog/identityMerge.ts are canonical. The implementations in crossCheckEngine.ts and siblingGuard.ts remain divergent and untouched because their empty-set behavior differs. Every fuzzy result is review-only, even at or above 0.75. Every below-threshold result is review. Multiple qualifying candidates are ambiguous. prefixBrandConflict(code: string | undefined, brand: string | undefined): boolean is a negative non-tire veto, never positive proof.

**Files:**

- Create: src/services/reconcile/importFuzzyMatcher.ts
- Test: src/services/reconcile/importFuzzyMatcher.test.ts

**Interfaces:**

- Consumes: ExpectedInventoryRow, CorpusCandidate[], IDENTITY_JACCARD_THRESHOLD, nameTokens(value: string): string[], jaccard(a: string[], b: string[]): number, plusGenerationDiff(a: string[], b: string[]): boolean, normalizedEditSimilarity(left: string, right: string): number, tireSizeToken(r: IdentityText | null | undefined): string, sameBrandFamily(a: string, b: string): boolean, and prefixBrandConflict(code: string | undefined, brand: string | undefined): boolean.
- Produces: FuzzyCandidateScore, FuzzyImportDecision, scoreImportCandidate(row: ExpectedInventoryRow, candidate: CorpusCandidate): FuzzyCandidateScore | null, and matchImportFuzzy(row: ExpectedInventoryRow, candidates: CorpusCandidate[]): FuzzyImportDecision.

- [ ] **Step 1: Write the complete failing adversarial test**

~~~typescript
// src/services/reconcile/importFuzzyMatcher.test.ts
import { describe, expect, it } from "vitest";
import { matchImportFuzzy } from "@/services/reconcile/importFuzzyMatcher";
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

function row(overrides: Partial<ExpectedInventoryRow> = {}): ExpectedInventoryRow {
  return {
    externalId: "row-1",
    partNumbers: [],
    brand: "Micheln",
    model: "Defendr T H",
    sizeText: "225-65-17",
    qty: 4,
    raw: {},
    ...overrides,
  };
}

function candidate(overrides: Partial<CorpusCandidate> = {}): CorpusCandidate {
  return {
    uid: "candidate-1",
    brand: "Michelin",
    name: "Defender T H",
    sizeToken: "225/65R17",
    ...overrides,
  };
}

describe("matchImportFuzzy", () => {
  it("finds a unique typo candidate but never auto-approves it", () => {
    const result = matchImportFuzzy(row(), [candidate()]);
    expect(result.status).toBe("fuzzy");
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.candidate?.uid).toBe("candidate-1");
    expect(result.autoApprove).toBe(false);
  });

  it("normalizes tire notation and rejects a real size mismatch", () => {
    expect(matchImportFuzzy(row(), [candidate()]).status).toBe("fuzzy");
    expect(matchImportFuzzy(row(), [candidate({ sizeToken: "235/65R17" })]).status).toBe("review");
  });

  it("routes below-threshold results to review", () => {
    const result = matchImportFuzzy(
      row({ brand: "Unknown", model: "Completely Different" }),
      [candidate()],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });

  it("returns ambiguous when two candidates qualify", () => {
    const result = matchImportFuzzy(row(), [
      candidate({ uid: "candidate-1" }),
      candidate({ uid: "candidate-2", name: "Defender TH" }),
    ]);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.autoApprove).toBe(false);
  });

  it("vetoes plus-generation drift", () => {
    const result = matchImportFuzzy(
      row({ brand: "Acme", model: "Road Plus" }),
      [candidate({ brand: "Acme", name: "Road" })],
    );
    expect(result.status).toBe("review");
  });

  it("uses a non-tire brand prefix conflict as a veto", () => {
    const result = matchImportFuzzy(
      row({
        brand: "Denso",
        model: "Spark Plug",
        sizeText: undefined,
        category: "Parts",
        barcode: "00872951323308",
      }),
      [candidate({ brand: "Denso", name: "Spark Plug", sizeToken: undefined })],
    );
    expect(result.status).toBe("review");
    expect(result.reason).toContain("brand prefix conflict");
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/services/reconcile/importFuzzyMatcher.test.ts

Expected: FAIL with Cannot find module '@/services/reconcile/importFuzzyMatcher'.

- [ ] **Step 3: Create the complete fuzzy matcher**

~~~typescript
// src/services/reconcile/importFuzzyMatcher.ts
import { tireSizeToken } from "@/services/ai/tireSpecs";
import {
  IDENTITY_JACCARD_THRESHOLD,
  jaccard,
  nameTokens,
  plusGenerationDiff,
} from "@/services/catalog/identityMerge";
import { sameBrandFamily } from "@/services/catalog/brandFamilies";
import { prefixBrandConflict } from "@/services/catalog/brandPrefixGeneral";
import { normalizedEditSimilarity } from "@/services/reconcile/normalizedEditDistance";
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

export interface FuzzyCandidateScore {
  candidate: CorpusCandidate;
  confidence: number;
  brandScore: number;
  nameScore: number;
}

export interface FuzzyImportDecision {
  status: "fuzzy" | "ambiguous" | "review";
  reason: string;
  confidence: number | null;
  candidate?: CorpusCandidate;
  candidates?: CorpusCandidate[];
  autoApprove: false;
}

function rowName(row: ExpectedInventoryRow): string {
  return row.model || row.name || row.specs || "";
}

function sizeOf(value: string, brand?: string): string {
  return tireSizeToken({ productName: value, brand });
}

function tireRow(row: ExpectedInventoryRow): boolean {
  return Boolean(sizeOf([row.sizeText, row.model, row.specs].filter(Boolean).join(" "), row.brand));
}

export function scoreImportCandidate(
  row: ExpectedInventoryRow,
  candidate: CorpusCandidate,
): FuzzyCandidateScore | null {
  const expectedName = rowName(row);
  const candidateName = candidate.name || "";
  if (!expectedName || !candidateName) return null;

  const expectedTokens = nameTokens(expectedName);
  const candidateTokens = nameTokens(candidateName);
  if (plusGenerationDiff(expectedTokens, candidateTokens)) return null;

  const expectedSize = sizeOf([row.sizeText, row.model, row.specs].filter(Boolean).join(" "), row.brand);
  const candidateSize = sizeOf([candidate.sizeToken, candidate.name].filter(Boolean).join(" "), candidate.brand);
  if (expectedSize && expectedSize !== candidateSize) return null;

  const code = row.barcode || row.partNumbers[0] || "";
  if (!tireRow(row) && prefixBrandConflict(code, row.brand)) return null;

  const brandScore = row.brand && candidate.brand
    ? (sameBrandFamily(row.brand, candidate.brand)
        ? 1
        : normalizedEditSimilarity(row.brand, candidate.brand))
    : 0;
  const tokenScore = jaccard(expectedTokens, candidateTokens);
  const characterScore = normalizedEditSimilarity(expectedName, candidateName);
  const nameScore = Math.max(tokenScore, characterScore);

  return {
    candidate,
    brandScore,
    nameScore,
    confidence: Math.min(brandScore, nameScore),
  };
}

export function matchImportFuzzy(
  row: ExpectedInventoryRow,
  candidates: CorpusCandidate[],
): FuzzyImportDecision {
  const code = row.barcode || row.partNumbers[0] || "";
  if (!tireRow(row) && prefixBrandConflict(code, row.brand)) {
    return {
      status: "review",
      reason: "Non-tire brand prefix conflict requires review.",
      confidence: null,
      autoApprove: false,
    };
  }

  const scored = candidates
    .map((candidate) => scoreImportCandidate(row, candidate))
    .filter((entry): entry is FuzzyCandidateScore => entry !== null)
    .sort((left, right) => right.confidence - left.confidence);
  const qualifying = scored.filter((entry) => entry.confidence >= IDENTITY_JACCARD_THRESHOLD);

  if (qualifying.length === 1) {
    return {
      status: "fuzzy",
      reason: "Unique typo-tolerant candidate requires human confirmation.",
      confidence: qualifying[0].confidence,
      candidate: qualifying[0].candidate,
      autoApprove: false,
    };
  }

  if (qualifying.length > 1) {
    return {
      status: "ambiguous",
      reason: "Multiple typo-tolerant candidates require human selection.",
      confidence: qualifying[0].confidence,
      candidates: qualifying.map((entry) => entry.candidate),
      autoApprove: false,
    };
  }

  return {
    status: "review",
    reason: "No candidate met the 0.75 fuzzy threshold.",
    confidence: scored[0]?.confidence ?? null,
    candidates: scored.slice(0, 3).map((entry) => entry.candidate),
    autoApprove: false,
  };
}
~~~

- [ ] **Step 4: Run the adversarial test**

Run: npx vitest run src/services/reconcile/importFuzzyMatcher.test.ts

Expected: PASS, 6 tests. Unique typo matches remain autoApprove: false. Below-threshold, size mismatch, plus-generation, prefix-conflict, and ambiguity cases never merge.

---

## Task 15: Integrate Stage B and run the final fixture and E2E gates

**Stage:** B final gate

**Depends on:** Task 14.

**Files:**

- Modify: src/services/reconcile/identityMatcher.ts
- Test: src/services/reconcile/identityMatcher.test.ts
- Modify: src/app/api/reconcile/match/route.ts
- Test: src/app/api/reconcile/match/route.test.ts
- Test: src/services/universalImportPreview.test.ts
- Create: src/services/fixtures/import/typo-brands-models.csv
- Create: src/services/fixtures/import/near-duplicate-brands.csv
- Create: src/services/fixtures/import/size-notation.csv
- Create: src/services/universalImport.stageB.test.ts
- Create: e2e/phase4-fuzzy-reconcile.spec.ts

**Interfaces:**

- Consumes: matchImportFuzzy(row: ExpectedInventoryRow, candidates: CorpusCandidate[]): FuzzyImportDecision, candidatesBySizeToken(sizeToken: string): Promise<TireKnowledgeRow[]>, the route sizeCache, buildImportPreview, applyUniversalImport, resolveImportReview, Needs Review, variance, and Boss Report.
- Produces: MatcherDeps.candidatesForFuzzy?(sizeToken: string): CorpusCandidate[], MatchResult.matchBasis extended with "identity_fuzzy", and proof that fuzzy suggestions never receive approved: true or quantity before confirmation.

- [ ] **Step 1: Create the complete Stage B fixtures**

~~~csv
# src/services/fixtures/import/typo-brands-models.csv
PN,Make,Model,Tire Size,QOH
MISS-1,Micheln,Defendr T H,225-65-17,4
~~~

~~~csv
# src/services/fixtures/import/near-duplicate-brands.csv
PN,Make,Model,Tire Size,QOH
MISS-2,Acme,Road Sport,225/45R18,3
~~~

~~~csv
# src/services/fixtures/import/size-notation.csv
PN,Make,Model,Tire Size,QOH
MISS-3,Michelin,Defender T H,225 65 17,2
~~~

- [ ] **Step 2: Write the complete fixture classification test**

~~~typescript
// src/services/universalImport.stageB.test.ts
import { describe, expect, it } from "vitest";
import { matchImportFuzzy } from "@/services/reconcile/importFuzzyMatcher";
import type { CorpusCandidate } from "@/services/reconcile/identityMatcher";
import type { ExpectedInventoryRow } from "@/services/reconcile/types";

const candidates: CorpusCandidate[] = [
  { uid: "one", brand: "Michelin", name: "Defender T H", sizeToken: "225/65R17" },
  { uid: "two", brand: "Acme", name: "Road Sport", sizeToken: "225/45R18" },
  { uid: "three", brand: "Acme", name: "Road Sports", sizeToken: "225/45R18" },
];

function imported(overrides: Partial<ExpectedInventoryRow>): ExpectedInventoryRow {
  return {
    externalId: "row",
    partNumbers: [],
    qty: 1,
    raw: {},
    ...overrides,
  };
}

describe("Stage B fixture outcomes", () => {
  it.each([
    {
      name: "typo brand and model",
      row: imported({ brand: "Micheln", model: "Defendr T H", sizeText: "225-65-17" }),
      expected: "fuzzy",
    },
    {
      name: "equivalent size notation",
      row: imported({ brand: "Michelin", model: "Defender T H", sizeText: "225 65 17" }),
      expected: "fuzzy",
    },
    {
      name: "near duplicate candidates",
      row: imported({ brand: "Acme", model: "Road Sport", sizeText: "225/45R18" }),
      expected: "ambiguous",
    },
    {
      name: "nonsense identity",
      row: imported({ brand: "Unknown", model: "Nothing Similar", sizeText: "225/45R18" }),
      expected: "review",
    },
  ])("classifies $name conservatively", ({ row, expected }) => {
    const result = matchImportFuzzy(row, candidates);
    expect(result.status).toBe(expected);
    expect(result.autoApprove).toBe(false);
  });
});
~~~

- [ ] **Step 3: Apply the complete matcher and route integration patch**

~~~diff
*** Begin Patch
*** Update File: src/services/reconcile/identityMatcher.ts
@@
 import { basePartNumberKey, tirePartNumberCore } from "@/services/catalog/tirePartNumber";
+import { matchImportFuzzy } from "@/services/reconcile/importFuzzyMatcher";
@@
-  matchBasis?: "part_number_exact" | "part_number_affix_core" | "identity_jaccard";
+  matchBasis?: "part_number_exact" | "part_number_affix_core" | "identity_jaccard" | "identity_fuzzy";
@@
 export interface MatcherDeps {
@@
   candidatesByBrandSize(brand: string | undefined, sizeToken: string): CorpusCandidate[];
+  candidatesForFuzzy?(sizeToken: string): CorpusCandidate[];
@@
   if (rowSize) {
@@
   }
+
+  if (rowSize && deps.candidatesForFuzzy) {
+    const fuzzy = matchImportFuzzy(row, deps.candidatesForFuzzy(rowSize));
+    if (fuzzy.status === "fuzzy") {
+      return {
+        row,
+        status: "matched",
+        reason: fuzzy.reason,
+        confidence: fuzzy.confidence ?? undefined,
+        matchBasis: "identity_fuzzy",
+        candidate: fuzzy.candidate,
+      };
+    }
+    if (fuzzy.status === "ambiguous" || fuzzy.status === "review") {
+      return {
+        row,
+        status: "ambiguous",
+        reason: fuzzy.reason,
+        confidence: fuzzy.confidence ?? undefined,
+        candidates: fuzzy.candidates,
+      };
+    }
+  }
 
   // --- Step 3 / 4: non_tire vs unmatched
*** Update File: src/app/api/reconcile/match/route.ts
@@
     const deps: MatcherDeps = {
       lookupByPartNumber: (normalizedPn) => pnCache.get(normalizedPn) ?? [],
       candidatesByBrandSize: (_brand, token) => sizeCache.get(token) ?? [],
+      candidatesForFuzzy: (token) => sizeCache.get(token) ?? [],
     };
*** Update File: src/services/reconcile/identityMatcher.test.ts
@@
+  it("exposes a typo candidate as identity_fuzzy data only", () => {
+    const result = matchExpectedRow(row({
+      partNumbers: [],
+      brand: "Micheln",
+      model: "Defendr T H",
+      sizeText: "225-65-17",
+    }), {
+      lookupByPartNumber: () => [],
+      candidatesByBrandSize: () => [],
+      candidatesForFuzzy: () => [
+        { uid: "one", brand: "Michelin", name: "Defender T H", sizeToken: "225/65R17" },
+      ],
+    });
+    expect(result.status).toBe("matched");
+    expect(result.matchBasis).toBe("identity_fuzzy");
+    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
+  });
*** Update File: src/services/universalImportPreview.test.ts
@@
+  it("never promotes identity_fuzzy matcher data to exact", () => {
+    const mapped = mapUniversalRows({ ...sheet, rows: [sheet.rows[0]] }, {
+      partNumber: 0,
+      brand: 1,
+      model: 2,
+      size: 3,
+      quantity: 4,
+    });
+    const preview = buildImportPreview(mapped, [{
+      row: mapped.rows[0].expected,
+      status: "matched",
+      reason: "Unique typo-tolerant candidate requires human confirmation.",
+      confidence: 0.8,
+      matchBasis: "identity_fuzzy",
+      candidate: { uid: "one", brand: "Acme", name: "Road" },
+    }], "header");
+    expect(preview.rows[0].status).toBe("fuzzy");
+    expect(preview.exact).toBe(0);
+  });
*** End Patch
~~~

- [ ] **Step 4: Write the complete review-before-quantity E2E proof**

~~~typescript
// e2e/phase4-fuzzy-reconcile.spec.ts
import { expect, test } from "./fixtures";

test("fuzzy import stays in Needs Review until human confirmation", async ({ page }) => {
  await page.route("**/api/import-mapping**", async (route) => {
    await route.fulfill({
      json: route.request().method() === "GET" ? { mapping: null } : { ok: true },
    });
  });
  await page.route("**/api/reconcile/match", async (route) => {
    const body = route.request().postDataJSON() as { rows: Array<Record<string, unknown>> };
    await route.fulfill({
      json: {
        matches: body.rows.map((row) => ({
          row,
          status: "matched",
          reason: "Unique typo-tolerant candidate requires human confirmation.",
          confidence: 0.8,
          matchBasis: "identity_fuzzy",
          candidate: { uid: "one", brand: "Michelin", name: "Defender T H" },
        })),
      },
    });
  });

  await page.goto("/products");
  await page.getByTestId("universal-import-file").setInputFiles({
    name: "typo.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "PN,Make,Model,Tire Size,QOH\nMISS-1,Micheln,Defendr T H,225-65-17,4\n",
    ),
  });
  await expect(page.getByTestId("import-headline")).toHaveText("Matched 0 of 1 automatically");
  await page.getByTestId("import-apply").click();
  await expect(page.getByTestId("import-summary")).toContainText(
    "Applied 0. Needs Review 1. Rejected 0.",
  );

  const beforeConfirm = await page.evaluate(() => {
    const state = window.__scanStore?.getState();
    return {
      approved: state?.aliases.some((item) => item.cleanCode === "MISS-1" && item.approved),
      quantity: state?.finalCounts.reduce((sum, item) => sum + item.quantity, 0),
    };
  });
  expect(beforeConfirm).toEqual({ approved: false, quantity: 0 });

  await page.goto("/review");
  await page.getByRole("button", { name: "Create new product" }).click();

  const afterConfirm = await page.evaluate(() => {
    const state = window.__scanStore?.getState();
    return {
      approved: state?.aliases.some((item) => item.cleanCode === "MISS-1" && item.approved),
      quantity: state?.finalCounts.reduce((sum, item) => sum + item.quantity, 0),
    };
  });
  expect(afterConfirm).toEqual({ approved: true, quantity: 4 });
});
~~~

- [ ] **Step 5: Run focused Stage B and adversarial tests**

Run: npx vitest run src/services/reconcile/normalizedEditDistance.test.ts src/services/reconcile/importFuzzyMatcher.test.ts src/services/reconcile/identityMatcher.test.ts src/app/api/reconcile/match/route.test.ts src/services/universalImportPreview.test.ts src/services/universalImport.stageB.test.ts src/stores/universalImport.store.test.ts

Expected: PASS. Outcomes are unique fuzzy, normalized-size fuzzy, ambiguous, and below-threshold review. No fuzzy test observes automatic alias or quantity.

Run: npm run test:e2e -- phase4-fuzzy-reconcile.spec.ts phase4-universal-import.spec.ts phase4-universal-import.visual.spec.ts

Expected: PASS. Stage A remains green at both viewports. Fuzzy quantity is zero before confirm and four after confirm.

- [ ] **Step 6: Run the final Phase 4 gate**

Run: npm run test

Expected: PASS.

Run: npm run test:ledger

Expected: PASS.

Run: npm run test:golden

Expected: PASS.

Run: npm run test:firebase

Expected: PASS.

Run: npx tsc --noEmit

Expected: no TypeScript errors.

Run: npm run lint

Expected: no new lint errors.

Run: npm run build

Expected: PASS.

Run: npm run qa:revision

Expected: PASS after desktop and phone screenshot review. Hand off Phase 4 only when every command is green.

---

## Self-Review Pass

### Acceptance criteria coverage

- [ ] AC1, any supported upload format without per-format code: Tasks 2, 3, 4, 7, 9, 10, and 12. Task 10 deletes SHOPWARE_COLUMN_MAP.partNumber. CSV, TSV, and OOXML XLSX are covered. An .xls filename is accepted only when its bytes are OOXML; true BIFF is the flagged unknown below.
- [ ] AC2, per-fixture counts and zero low-confidence auto-merges: Tasks 7, 11, 13, 14, and 15. The threshold is exactly 0.75. Jaccard, affix-core, character-fuzzy, below-threshold, and ambiguous rows are review-only.
- [ ] AC3, nonsense-header manual mapping remembered: Tasks 3, 5, 6, 9, 10, and 12. Mapping memory writes only after Apply.
- [ ] AC4, 5,000 rows in less than 10 seconds: Task 10 times read, inference, map, matcher-result shaping, and preview together.
- [ ] AC5, import through preview, Apply, variance, and Boss Report at both viewports with polish: Tasks 9, 11, 12, and 15.

### Parallel and file-boundary audit

- [ ] Tasks 1 through 4 form the sequential import foundation.
- [ ] After Task 4, Tasks 5 and 6 own mapping persistence, Task 8 owns the reconcile route, Task 9 owns the panel, and Task 10 owns legacy adapters and performance fixtures. Their production boundaries are disjoint.
- [ ] Task 7 precedes Tasks 8 and 9 because it publishes their types.
- [ ] Task 11 is the only Stage A scanStore task and runs after all parallel Stage A tracks.
- [ ] Task 12 blocks Stage B and makes Stage A independently shippable.
- [ ] Tasks 13, 14, and 15 are sequential after Task 12, so fuzzy tuning cannot delay Stage A.
- [ ] Task 15 reopens Task 7 files only after Stage A is complete; no parallel worker shares them.

### Binding design-ruling audit

- [ ] Resolver trust invariant 3: Task 7 classifies non-exact data as fuzzy or review. Tasks 11 and 15 prove no fuzzy alias or quantity before human confirmation. Exact human-upload rows retain origin: "human" and approved: true.
- [ ] Preview-before-apply: Tasks 9, 11, and 12 keep preview in React memory and assert zero store, DB, mapping, and localStorage writes before Apply.
- [ ] Sanitizer: Tasks 2 and 4 apply stripControlChars, cap at 500, then defuseFormulaInjection to every cell. Task 2 closes the current Shop-Ware gap.
- [ ] ExcelJS read: Task 4 adds the first workbook.xlsx.load path; existing repo usage is write-only.
- [ ] Monolith: Task 11 is the only Stage A scanStore edit and runs last among production Stage A work.
- [ ] Migration: Task 11 cites scanStoreMigrate and changes version 8 to 9 without injecting absent keys.
- [ ] Canonical Jaccard: Tasks 7 and 14 use identityMerge.ts nameTokens and jaccard at 0.75. crossCheckEngine.ts and siblingGuard.ts are the divergent landmine and are not unified.
- [ ] Mapping seam: Tasks 5 and 6 choose businessId-namespaced Turso LadderStorage KV. It is the lowest-effort seam that works in mock and live. localStorage is device-only. Firestore would split this feature across the second database and lacks the scout's mock seam. The per-account key matches the tenancy direction, and the interface permits a dedicated table later.
- [ ] Quantity review: Task 11 adds resolveImportReview and leaves reconcile confirm-link applyToCount: false unchanged.
- [ ] Non-tire corroboration: Task 14 uses prefixBrandConflict only as a negative veto; Task 8 retains exact retail barcode lookup as positive evidence.
- [ ] Performance: Task 10 enforces the complete 5,000-row target under 10 seconds.
- [ ] Stage ordering: character edit distance exists only in Tasks 13 through 15 after the Stage A gate.
- [ ] Typography and action safety: this plan contains no em dash or en dash and requests no paid script.

### Flagged unknowns carried into execution

- [ ] ExcelJS 4.4.0 has OOXML XLSX read APIs but no legacy BIFF .xls reader. The plan accepts OOXML bytes with an .xls filename and rejects true BIFF with actionable copy. Literal BIFF support needs an owner-approved parser and is not grounded in installed code.
- [ ] The scout evidence contains no real customer Boss Report export. Fixtures use the binding PN, Make, Model, Tire Size, and QOH vocabulary. Validate the first real export without reintroducing per-format code.

