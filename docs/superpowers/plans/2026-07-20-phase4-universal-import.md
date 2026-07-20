# Phase 4: Universal Import and Smart Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Track every checkbox, run every failing test before implementation, and perform independent review before merging parallel tracks.

**Goal:** Let a Scanbin account upload CSV, TSV, XLSX, or an OOXML workbook carrying an `.xls` filename, understand or manually map its columns, see one honest preview headed by `Matched 380 of 400 automatically`, and explicitly apply exact rows while every algorithmic fuzzy or ambiguous row stays in Needs Review until a human confirms it. The flow must feed the existing count snapshots, variance view, and Boss Report without any inventory, alias, count, review, localStorage, Turso, or Firestore write before the Apply click.

**Architecture:** Build Stage A as an isolated universal-import pipeline around the existing pure seams. `sanitizeCell(raw: string): string` remains the single untrusted-cell boundary in `src/services/csvImport.ts`; `readUniversalFile(file: UploadFileLike): Promise<UniversalSheet>` sanitizes every CSV, TSV, and ExcelJS cell before inference. `inferColumnMapping(matrix: string[][]): ColumnInference` performs deterministic header normalization and conservative content inference, then `UniversalImportPanel` falls back to an explicit mapping screen. Preview calls the existing Node route `POST /api/reconcile/match`, which continues to run `matchExpectedRow(row, deps)` and gains exact retail-corpus enrichment through `lookupRetailBarcodeAsync(code)`. Preview state stays in React memory only. Mapping memory is a namespaced Turso KV record through `LadderStorage.get/set`, keyed by `businessId` and `sourceSignature`; the PUT occurs only after Apply. Exact human-upload rows use the existing `resolveUnknown(..., "create_new", { origin: "human" })` trust path and remain `approved: true`. Fuzzy rows are staged as import-specific Needs Review records with their quantity, and the existing human confirmation surface resolves them later. Stage B starts only after the complete Stage A proof gate and adds new character-level edit distance plus the canonical token Jaccard from `src/services/catalog/identityMerge.ts`.

**Tech Stack:** Next.js 16.2.9 App Router and Route Handlers, React 19.2.4, TypeScript 5, Tailwind v4, Zustand 5.0.14, Vitest 4.1.8 unit and dom projects, Playwright 1.60.0, `csv-parse` 7.0.0, ExcelJS 4.4.0 lazy read, existing tire and retail SQLite/Turso corpus access, and existing Turso/file-backed `LadderStorage` KV.

## Global Constraints

- **Stage order (this plan = Stage A only):** Tasks 1 through 11 ARE this plan. Tasks 1 through 10 are Stage A implementation; Task 11 is the Stage A ship + proof gate. Stage A is independently shippable and fixes D9 and delivers the demo beat on its own. Stage B (typo-tolerant fuzzy matching) and the combined handoff are a SEPARATE follow-up plan authored as `2026-07-20-phase4b-fuzzy-matching.md` AFTER Stage A ships and passes Task 11 - this matches the master plan's staging so a Stage B tuning rabbit hole can never block a Stage A release. Any reference below to "Stage B" or "Tasks 12-15" points to that follow-up plan, not this one.
- **Binding threshold T:** `0.75`, grounded in `src/services/reconcile/identityMatcher.ts` and the existing literal used by `findIdentityMerge` in `src/services/catalog/identityMerge.ts`. Task 7 exports `JACCARD_THRESHOLD = 0.75` from `identityMatcher.ts`; the Stage A matcher and the P4b Stage B follow-up both consume that single export and never create a third threshold literal.
- **Canonical Jaccard:** only `jaccard(a: string[], b: string[]): number`, `nameTokens(s: string | null | undefined): string[]`, and `plusGenerationDiff(a: string[], b: string[]): boolean` from `src/services/catalog/identityMerge.ts` are canonical for Phase 4. The independent `jaccard` functions in `src/services/ai/crossCheckEngine.ts` and `src/services/fetchV2/siblingGuard.ts` remain untouched. This is a landmine: `identityMerge.ts` returns `0` for empty/empty, while `siblingGuard.ts` returns `1`. Unifying them is out of scope.
- **Resolver trust invariant:** wrong identity is failure and ambiguity is acceptable. Every product-identity fuzzy match, including a score at or above `0.75`, is suggestion data only until a human confirms it. Every fuzzy score below `0.75`, every tie, every affix-core-only match, and every conflicting corroboration routes to Needs Review. No fuzzy row receives `approved: true` during Apply. Exact human-upload rows retain the current `approved: true`, `verified: true` behavior through `resolveUnknown` with `origin: "human"`.
- **Preview before apply:** file read, column inference, mapping UI, corpus lookup, and preview are read-only. They may update React component memory and perform GET/POST reads, but they must not call `useScanStore.setState`, `reopenNeedsReview`, `resolveUnknown`, `snapshotCount`, `LadderStorage.set`, or a Firestore write. The first permitted write is the explicit Apply click.
- **Demo beat:** the preview header is exactly `Matched X of Y automatically`; the scripted fixture proves `Matched 380 of 400 automatically` on one screen before Apply.
- **Sanitizer boundary:** every imported cell follows exactly `stripControlChars -> 500-character cap -> defuseFormulaInjection` through `sanitizeCell`. This applies to CSV, TSV, XLSX, OOXML-with-`.xls` filenames, header cells, mapped cells, sample rows, and `ExpectedInventoryRow.raw`. Task 2 closes the current Shop-Ware adapter gap.
- **ExcelJS read reality:** `package.json` contains `exceljs: ^4.4.0`, and `node_modules/exceljs/README.md` documents `workbook.xlsx.load(data)` for XLSX only. Task 4 introduces the first repository read path. A true legacy BIFF `.xls` file is not silently claimed as supported; it gets the exact error `Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.` Supporting genuine BIFF remains a flagged unknown requiring an owner-approved parser decision. An OOXML payload named `.xls` is accepted because content, not the suffix, is passed to `workbook.xlsx.load`.
- **Mapping memory decision:** choose Turso KV, wrapped by `src/server/importMappingMemory.ts`, using `LadderStorage.get/set` and key `import_mapping::<businessId>::<sourceSignature>`. Firestore is not chosen because the current default and demo backend is mock, while Firestore-only memory would disappear from that path. localStorage is not chosen because it is per browser rather than per account. The namespaced Turso/file seam works in mock and live modes, remains outside inventory truth, and preserves per-account keys. The API route still verifies membership in live mode. Reusing `ladder_kv` is an acknowledged semantic compromise; a dedicated table is deferred until mapping volume or retention warrants it.
- **Monolith containment:** Tasks 1 through 9 create isolated modules or touch narrow existing files. Task 10 is the only Stage A task that edits the approximately 5,700-line `src/stores/scanStore.ts`; it is ordered last among Stage A implementation tasks and adds only one action, one optional review context, and import-quantity handling.
- **Persist migration law:** the actual store is `name: "sis-scan-v1"`, `version: 8`, with `scanStoreMigrate(persisted, version)` at `src/stores/scanStore.ts:5687` and the version at `src/stores/scanStore.ts:5735`. Task 10 bumps to version 9 because `UnknownCodeReview.importQuantity` is persisted. Its migration preserves the v8 rule at lines 5704 through 5711: transform only keys the blob already carries, never inject absent arrays or settings into a partial blob.
- **Performance:** parsing, mapping, matching supplied in-memory match results, and constructing a 5,000-row preview must complete in less than `10_000` ms locally. The performance test excludes Apply and external network latency, which are not import processing.
- **Limits already grounded in code:** `MAX_FIELD_LENGTH = 500`, `PREVIEW_LIMIT = 20`, and reconcile route `MAX_ROWS = 20000`. The mapping API body cap reuses the existing share-route value `32 * 1024` bytes.
- **No paid or live calls:** automated tests mock retail/Turso/Firebase access and never call paid providers. Phase 4 does not call `/api/ai-lookup`.
- **No em dash or en dash:** all new user-facing copy, source comments, tests, fixtures, and this plan use ASCII punctuation.
- **Out of scope:** unifying the three legacy Jaccard implementations, replacing the scan ledger, live production import, importing price/cost, adding AI-based column mapping, and claiming true BIFF `.xls` support without a compatible parser.
- **Cost worst case:** paid API cost is `$0`; this phase uses deterministic code and existing local/server corpora. Subscription token usage is reported at closeout rather than guessed in advance.

## Track and dependency map

| Track | Tasks | Dependency |
|---|---|---|
| Stage A foundation | 1, then 2, 3, and 5 in parallel | Task 1 first |
| Stage A ingestion | 4 after 2 and 3; 6 after 1 and 5 | Disjoint files |
| Stage A preview | 7 and 8 in parallel after 3 and 4 | Disjoint files |
| Stage A UI | 9 after 6, 7, and 8 | No scanStore edit |
| Stage A inventory bridge | 10 after 9 | Sole monolith edit |
| Stage A ship gate | 11 after 10 | Final proof + handoff for this plan |

Stage B (typo-tolerant fuzzy matching + combined handoff) is a SEPARATE follow-up plan (`2026-07-20-phase4b-fuzzy-matching.md`), authored and executed only after Task 11 passes. It reuses this plan's `ImportPreviewStatus "fuzzy"` slot, the canonical `jaccard`/`nameTokens` from `identityMerge.ts`, `JACCARD_THRESHOLD` (Task 7), and `brandPrefixGeneral` corroboration, and adds net-new character-level edit distance - all behind the review-first guard (no fuzzy row ever auto-approves).

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
+    const onHand = qtyOnHandKey ? parseQty(sanitizedRecord[qtyOnHandKey]) : undefined;
+    const available = qtyAvailableKey ? parseQty(sanitizedRecord[qtyAvailableKey]) : undefined;
@@
-    const aliasRaw = aliasKey ? (record[aliasKey] ?? "").trim() : "";
+    const aliasRaw = aliasKey ? sanitizedRecord[aliasKey] ?? "" : "";
@@
-    const unitValue = unitKey ? (record[unitKey] ?? "").trim() : "";
+    const unitValue = unitKey ? sanitizedRecord[unitKey] ?? "" : "";
@@
-    for (const [key, value] of Object.entries(record)) {
+    for (const [key, value] of Object.entries(sanitizedRecord)) {
@@
-      brand: brandKey ? (record[brandKey] || undefined) : undefined,
-      model: modelKey ? (record[modelKey] || undefined) : undefined,
-      sizeText: sizeKey ? (record[sizeKey] || undefined) : undefined,
-      specs: specsKey ? (record[specsKey] || undefined) : undefined,
+      brand: brandKey ? sanitizedRecord[brandKey] || undefined : undefined,
+      model: modelKey ? sanitizedRecord[modelKey] || undefined : undefined,
+      sizeText: sizeKey ? sanitizedRecord[sizeKey] || undefined : undefined,
+      specs: specsKey ? sanitizedRecord[specsKey] || undefined : undefined,
*** End Patch
```

- [ ] **Step 4: Run focused and adjacent sanitizer tests**

Run: `npx vitest run src/services/reconcile/shopwareCsvAdapter.test.ts src/services/csvImport.test.ts src/services/csvImport.trustGate.test.ts`

Expected: PASS, including all four D9 header examples, seen-header error copy, 500-character cap, and formula defusal.

---

## Task 3: Build deterministic column intelligence and manual mapping validation

**Stage:** A

**Files:**

- Create: `src/services/columnIntelligence.ts`
- Test: `src/services/columnIntelligence.test.ts`

**Interfaces:**

- Consumes: sanitized `string[][]` matrices.
- Produces: `ColumnInference`, `HEADER_SYNONYMS`, `normalizeImportHeader(value: string): string`, `inferColumnMapping(matrix: string[][]): ColumnInference`, and `validateManualMapping(headers: string[], mapping: ColumnMapping): { ok: true } | { ok: false; errors: string[] }`.

- [ ] **Step 1: Write the complete failing test**

```typescript
// src/services/columnIntelligence.test.ts
import { describe, expect, it } from "vitest";
import {
  inferColumnMapping,
  normalizeImportHeader,
  validateManualMapping,
} from "@/services/columnIntelligence";

describe("columnIntelligence", () => {
  it("normalizes the boss-export header examples without fuzzy product matching", () => {
    expect(normalizeImportHeader("Part #")).toBe("part number");
    expect(normalizeImportHeader(" PN ")).toBe("pn");
    expect(normalizeImportHeader("Item No.")).toBe("item no");
    expect(normalizeImportHeader("Mfg Part Number")).toBe("mfg part number");
  });

  it("finds a header after blank and title rows and maps PN / Make / Model / Tire Size / QOH", () => {
    const result = inferColumnMapping([
      ["", "", "", "", ""],
      ["Inventory export", "", "", "", ""],
      ["PN", "Make", "Model", "Tire Size", "QOH"],
      ["ABC-1", "Acme", "Road", "225/45R18", "7"],
    ]);
    expect(result.headerRowIndex).toBe(2);
    expect(result.mapping).toEqual({
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("header");
  });

  it("uses conservative content inference but keeps nonsense headers low confidence", () => {
    const result = inferColumnMapping([
      ["Alpha", "Beta", "Gamma"],
      ["012345678905", "225/45R18", "7"],
      ["036000291452", "235/45R18", "8"],
    ]);
    expect(result.mapping).toMatchObject({ barcode: 0, size: 1, quantity: 2 });
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("content");
  });

  it("rejects duplicate manual assignments and requires identity plus quantity", () => {
    expect(validateManualMapping(["A", "B"], { partNumber: 0, quantity: 0 })).toEqual({
      ok: false,
      errors: ["One source column cannot be assigned to more than one field."],
    });
    expect(validateManualMapping(["A", "B"], { brand: 0, quantity: 1 })).toEqual({
      ok: false,
      errors: ["Map at least one identity field: part number, barcode, or name."],
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npx vitest run src/services/columnIntelligence.test.ts`

Expected: FAIL with `Cannot find module '@/services/columnIntelligence'`.

- [ ] **Step 3: Create the complete implementation**

```typescript
// src/services/columnIntelligence.ts
import { tireSizeToken } from "@/services/ai/tireSpecs";
import { sanitizeCell } from "@/services/csvImport";
import type { ColumnMapping, ImportField, MappingSource } from "@/services/importSchema";
import { isGtinShaped } from "@/services/upc/gtin";

export const HEADER_SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  partNumber: [
    "part number",
    "part no",
    "part",
    "pn",
    "item no",
    "item number",
    "mfg part number",
    "manufacturer part number",
    "sku",
    "primary sku",
  ],
  brand: ["brand", "make", "manufacturer", "mfr"],
  model: ["model", "product", "description", "item description", "product name"],
  size: ["size", "tire size", "tyre size"],
  quantity: ["qty", "quantity", "count", "qoh", "quantity on hand", "qty on hand", "on hand"],
  uom: ["unit", "uom", "unit of measure"],
  barcode: ["barcode", "primary barcode", "upc", "ean", "gtin"],
  name: ["name", "product name", "item name"],
  category: ["category", "department", "product category"],
};

export interface ColumnInference {
  headerRowIndex: number;
  headers: string[];
  mapping: ColumnMapping;
  confidence: "high" | "low";
  source: MappingSource;
  seenHeaders: string[];
  reasons: string[];
}

export function normalizeImportHeader(value: string): string {
  return sanitizeCell(value)
    .toLowerCase()
    .replace(/#/g, " number ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function fieldForHeader(value: string): ImportField | undefined {
  const normalized = normalizeImportHeader(value);
  return (Object.keys(HEADER_SYNONYMS) as ImportField[]).find((field) =>
    HEADER_SYNONYMS[field].includes(normalized),
  );
}

function nonBlank(row: string[]): boolean {
  return row.some((cell) => cell.trim() !== "");
}

function headerScore(row: string[]): number {
  return new Set(row.map(fieldForHeader).filter((field): field is ImportField => Boolean(field))).size;
}

function valuesForColumn(rows: string[][], index: number): string[] {
  return rows.map((row) => row[index] ?? "").map((value) => value.trim()).filter(Boolean);
}

function allQuantities(values: string[]): boolean {
  return values.length > 0 && values.every((value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0;
  });
}

function allSizes(values: string[]): boolean {
  return values.length > 0 && values.every((value) => tireSizeToken({ productName: value }) !== "");
}

function allBarcodes(values: string[]): boolean {
  return values.length > 0 && values.every((value) => isGtinShaped(value));
}

export function inferColumnMapping(matrix: string[][]): ColumnInference {
  const candidateRows = matrix
    .map((row, index) => ({ row, index, score: headerScore(row) }))
    .filter(({ row }) => nonBlank(row));
  const first = candidateRows[0] ?? { row: [], index: 0, score: 0 };
  const header = candidateRows.reduce((best, current) => current.score > best.score ? current : best, first);
  const headers = header.row.map(sanitizeCell);
  const mapping: ColumnMapping = {};
  const reasons: string[] = [];

  headers.forEach((value, index) => {
    const field = fieldForHeader(value);
    if (field !== undefined && mapping[field] === undefined) mapping[field] = index;
  });

  const dataRows = matrix.slice(header.index + 1).filter(nonBlank);
  const used = new Set(Object.values(mapping).filter((value): value is number => value !== undefined));
  const inferred: Array<[ImportField, (values: string[]) => boolean]> = [
    ["quantity", allQuantities],
    ["size", allSizes],
    ["barcode", allBarcodes],
  ];

  for (const [field, predicate] of inferred) {
    if (mapping[field] !== undefined) continue;
    const matches = headers
      .map((_, index) => index)
      .filter((index) => !used.has(index) && predicate(valuesForColumn(dataRows, index)));
    if (matches.length === 1) {
      mapping[field] = matches[0];
      used.add(matches[0]);
      reasons.push(`${field} inferred from cell content.`);
    }
  }

  const hasIdentity = mapping.partNumber !== undefined || mapping.barcode !== undefined || mapping.name !== undefined;
  const hasQuantity = mapping.quantity !== undefined;
  const source: MappingSource = header.score > 0 ? "header" : "content";
  const confidence = source === "header" && hasIdentity && hasQuantity ? "high" : "low";
  if (!hasIdentity) reasons.push("No identity column was recognized.");
  if (!hasQuantity) reasons.push("No quantity column was recognized.");
  if (confidence === "low") reasons.push(`Seen headers: ${headers.join(", ") || "(none)"}.`);

  return {
    headerRowIndex: header.index,
    headers,
    mapping,
    confidence,
    source,
    seenHeaders: headers,
    reasons,
  };
}

export function validateManualMapping(
  headers: string[],
  mapping: ColumnMapping,
): { ok: true } | { ok: false; errors: string[] } {
  const assigned = Object.values(mapping).filter((value): value is number => value !== undefined);
  if (new Set(assigned).size !== assigned.length) {
    return { ok: false, errors: ["One source column cannot be assigned to more than one field."] };
  }
  if (assigned.some((index) => index < 0 || index >= headers.length)) {
    return { ok: false, errors: ["A mapped column is outside the uploaded file."] };
  }
  if (mapping.partNumber === undefined && mapping.barcode === undefined && mapping.name === undefined) {
    return { ok: false, errors: ["Map at least one identity field: part number, barcode, or name."] };
  }
  if (mapping.quantity === undefined) {
    return { ok: false, errors: ["Map the quantity field before previewing."] };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run src/services/columnIntelligence.test.ts`

Expected: PASS, 4 tests. The nonsense-header case remains low confidence and therefore must render the mapping UI.

---

## Task 4: Add the net-new lazy ExcelJS read path and universal file reader

**Stage:** A

**Files:**

- Create: `src/services/universalFileReader.ts`
- Test: `src/services/universalFileReader.test.ts`

**Interfaces:**

- Consumes: `UploadFileLike`, `sanitizeCell(raw)`, `inferColumnMapping(matrix)`, and `buildSourceSignature(headers)`.
- Produces: `readUniversalFile(file: UploadFileLike): Promise<UniversalSheet>` and `detectDelimitedSeparator(text: string): "," | "\t" | ";" | "|"`.

- [ ] **Step 1: Write the complete failing tests**

```typescript
// src/services/universalFileReader.test.ts
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { readUniversalFile } from "@/services/universalFileReader";
import type { UploadFileLike } from "@/services/importSchema";

function textFile(name: string, content: string): UploadFileLike {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    type: "text/plain",
    text: async () => content,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe("readUniversalFile", () => {
  it("reads BOM CSV with blank and title rows plus a semicolon delimiter", async () => {
    const sheet = await readUniversalFile(textFile(
      "inventory.csv",
      "\uFEFF;;;;\nInventory export;;;;\nPN;Make;Model;Tire Size;QOH\nABC-1;Acme;Road;225/45R18;7\n",
    ));
    expect(sheet.kind).toBe("csv");
    expect(sheet.headerRowIndex).toBe(2);
    expect(sheet.headers).toEqual(["PN", "Make", "Model", "Tire Size", "QOH"]);
    expect(sheet.rows).toEqual([["ABC-1", "Acme", "Road", "225/45R18", "7"]]);
  });

  it("reads TSV and sanitizes every cell", async () => {
    const sheet = await readUniversalFile(textFile(
      "inventory.tsv",
      "PN\tMake\tQOH\nABC-1\t=2+2\t3\n",
    ));
    expect(sheet.kind).toBe("tsv");
    expect(sheet.rows[0][1]).toBe("'=2+2");
  });

  it("lazy-loads an XLSX workbook and sanitizes formula results", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "Make", "QOH"]);
    worksheet.addRow(["ABC-1", { formula: "2+2", result: "=4" }, 3]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const file: UploadFileLike = {
      name: "inventory.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    const sheet = await readUniversalFile(file);
    expect(sheet.kind).toBe("xlsx");
    expect(sheet.rows[0]).toEqual(["ABC-1", "'=4", "3"]);
  });

  it("accepts OOXML bytes with an .xls filename but rejects genuine legacy BIFF honestly", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Inventory").addRow(["PN", "QOH"]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer);
    const renamed: UploadFileLike = {
      name: "inventory.xls",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    await expect(readUniversalFile(renamed)).resolves.toMatchObject({ kind: "xls" });

    const biff = textFile("legacy.xls", "not-an-ooxml-zip");
    await expect(readUniversalFile(biff)).rejects.toThrow(
      "Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.",
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npx vitest run src/services/universalFileReader.test.ts`

Expected: FAIL with `Cannot find module '@/services/universalFileReader'`.

- [ ] **Step 3: Create the complete reader**

```typescript
// src/services/universalFileReader.ts
import { parse as parseCsvSync } from "csv-parse/sync";
import { inferColumnMapping } from "@/services/columnIntelligence";
import { sanitizeCell } from "@/services/csvImport";
import {
  buildSourceSignature,
  type UniversalSheet,
  type UploadFileLike,
  type UploadKind,
} from "@/services/importSchema";

const DELIMITERS = [",", "\t", ";", "|"] as const;

export function detectDelimitedSeparator(text: string): (typeof DELIMITERS)[number] {
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/).find((value) => value.trim() !== "") ?? "";
  let quoted = false;
  const counts = new Map<(typeof DELIMITERS)[number], number>(DELIMITERS.map((value) => [value, 0]));
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (!quoted && DELIMITERS.includes(char as (typeof DELIMITERS)[number])) {
      const delimiter = char as (typeof DELIMITERS)[number];
      counts.set(delimiter, (counts.get(delimiter) ?? 0) + 1);
    }
  }
  return DELIMITERS.reduce((best, current) =>
    (counts.get(current) ?? 0) > (counts.get(best) ?? 0) ? current : best,
  ",");
}

function extension(name: string): UploadKind {
  const suffix = name.trim().toLowerCase().split(".").pop();
  if (suffix === "csv" || suffix === "tsv" || suffix === "xlsx" || suffix === "xls") return suffix;
  throw new Error("Choose a .csv, .tsv, .xlsx, or .xls file.");
}

function hasData(row: string[]): boolean {
  return row.some((cell) => cell.trim() !== "");
}

function delimitedMatrix(text: string, kind: UploadKind): string[][] {
  const delimiter = kind === "tsv" ? "\t" : detectDelimitedSeparator(text);
  const records = parseCsvSync(text, {
    delimiter,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  }) as unknown[][];
  return records.map((row) => row.map((cell) => sanitizeCell(String(cell ?? ""))));
}

function excelCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  if (record.result !== undefined) return String(record.result ?? "");
  if (Array.isArray(record.richText)) {
    return record.richText
      .map((part) => typeof part === "object" && part !== null ? String((part as { text?: unknown }).text ?? "") : "")
      .join("");
  }
  if (record.text !== undefined) return String(record.text ?? "");
  if (record.hyperlink !== undefined) return String(record.text ?? record.hyperlink ?? "");
  return String(value);
}

async function workbookMatrix(file: UploadFileLike, kind: UploadKind): Promise<string[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await workbook.xlsx.load(bytes as unknown as Buffer);
  } catch (error) {
    if (kind === "xls") {
      throw new Error(
        "Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.",
      );
    }
    throw new Error(`Could not read this XLSX workbook: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const worksheet = workbook.worksheets.find((candidate) => candidate.rowCount > 0);
  if (!worksheet) return [];
  const matrix: string[][] = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row: string[] = [];
    for (let columnNumber = 1; columnNumber <= worksheet.columnCount; columnNumber += 1) {
      row.push(sanitizeCell(excelCellText(worksheet.getRow(rowNumber).getCell(columnNumber).value)));
    }
    matrix.push(row);
  }
  return matrix;
}

export async function readUniversalFile(file: UploadFileLike): Promise<UniversalSheet> {
  const kind = extension(file.name);
  const matrix = kind === "csv" || kind === "tsv"
    ? delimitedMatrix(await file.text(), kind)
    : await workbookMatrix(file, kind);
  if (!matrix.some(hasData)) throw new Error("The uploaded file is empty.");
  const inference = inferColumnMapping(matrix);
  const rows = matrix.slice(inference.headerRowIndex + 1).filter(hasData);
  return {
    fileName: file.name,
    kind,
    headers: inference.headers,
    rows,
    headerRowIndex: inference.headerRowIndex,
    sourceSignature: buildSourceSignature(inference.headers),
    seenRows: matrix.slice(0, inference.headerRowIndex + 4),
  };
}
```

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run src/services/universalFileReader.test.ts src/services/columnIntelligence.test.ts`

Expected: PASS, including CSV, TSV, XLSX, renamed OOXML `.xls`, sanitizer, leading-row, and honest BIFF rejection cases.

---

## Task 5: Implement per-account mapping memory on the Turso KV seam

**Stage:** A

**Files:**

- Create: `src/server/importMappingMemory.ts`
- Test: `src/server/importMappingMemory.test.ts`

**Interfaces:**

- Consumes: `LadderStorage.get(key): Promise<string | null>`, `LadderStorage.set(key, value): Promise<void>`, `businessId`, `sourceSignature`, and `ColumnMapping`.
- Produces: `ImportMappingMemoryRecord`, `mappingMemoryKey(businessId: string, sourceSignature: string): string`, `getImportMappingMemory(businessId: string, sourceSignature: string, storage?: MappingKv): Promise<ImportMappingMemoryRecord | null>`, and `putImportMappingMemory(record: ImportMappingMemoryRecord, storage?: MappingKv): Promise<void>`.

- [ ] **Step 1: Write the complete failing test**

```typescript
// src/server/importMappingMemory.test.ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  getImportMappingMemory,
  mappingMemoryKey,
  putImportMappingMemory,
  type MappingKv,
} from "@/server/importMappingMemory";

vi.mock("server-only", () => ({}));

function memoryKv(): MappingKv {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
  };
}

describe("importMappingMemory", () => {
  it("scopes the key by business and source signature", () => {
    expect(mappingMemoryKey("biz-a", "source-1")).toBe("import_mapping::biz-a::source-1");
    expect(mappingMemoryKey("biz-b", "source-1")).not.toBe(mappingMemoryKey("biz-a", "source-1"));
  });

  it("round-trips a valid mapping", async () => {
    const storage = memoryKv();
    await putImportMappingMemory({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
      updatedAt: "2026-07-20T12:00:00.000Z",
    }, storage);
    await expect(getImportMappingMemory("biz-a", "source-1", storage)).resolves.toEqual({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("fails closed on corrupt or cross-account records", async () => {
    const corrupt: MappingKv = {
      get: async () => JSON.stringify({ businessId: "biz-b", sourceSignature: "source-1", mapping: {} }),
      set: async () => undefined,
    };
    await expect(getImportMappingMemory("biz-a", "source-1", corrupt)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npx vitest run src/server/importMappingMemory.test.ts`

Expected: FAIL with `Cannot find module '@/server/importMappingMemory'`.

- [ ] **Step 3: Create the complete server-only store**

```typescript
// src/server/importMappingMemory.ts
import "server-only";

import type { ColumnMapping, ImportField } from "@/services/importSchema";
import { IMPORT_FIELD_ORDER } from "@/services/importSchema";
import { ladderStorage, type LadderStorage } from "@/server/upc/storage";

export type MappingKv = Pick<LadderStorage, "get" | "set">;

export interface ImportMappingMemoryRecord {
  businessId: string;
  sourceSignature: string;
  mapping: ColumnMapping;
  updatedAt: string;
}

export function mappingMemoryKey(businessId: string, sourceSignature: string): string {
  return `import_mapping::${businessId}::${sourceSignature}`;
}

function validMapping(value: unknown): value is ColumnMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, index]) =>
    IMPORT_FIELD_ORDER.includes(key as ImportField) && Number.isSafeInteger(index) && Number(index) >= 0,
  );
}

function validRecord(value: unknown): value is ImportMappingMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.businessId === "string"
    && typeof record.sourceSignature === "string"
    && typeof record.updatedAt === "string"
    && validMapping(record.mapping);
}

export async function getImportMappingMemory(
  businessId: string,
  sourceSignature: string,
  storage?: MappingKv,
): Promise<ImportMappingMemoryRecord | null> {
  const kv = storage ?? await ladderStorage();
  const raw = await kv.get(mappingMemoryKey(businessId, sourceSignature));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!validRecord(parsed)) return null;
    if (parsed.businessId !== businessId || parsed.sourceSignature !== sourceSignature) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function putImportMappingMemory(
  record: ImportMappingMemoryRecord,
  storage?: MappingKv,
): Promise<void> {
  if (!record.businessId || !record.sourceSignature || !validMapping(record.mapping)) {
    throw new Error("Invalid import mapping memory record.");
  }
  const kv = storage ?? await ladderStorage();
  await kv.set(mappingMemoryKey(record.businessId, record.sourceSignature), JSON.stringify(record));
}
```

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run src/server/importMappingMemory.test.ts`

Expected: PASS, 3 tests, with no Turso credentials and no network call.

---
## Task 6: Expose mapping memory through an authenticated read and delayed-write route

**Stage:** A

**Files:**

- Create: `src/app/api/import-mapping/route.ts`
- Test: `src/app/api/import-mapping/route.test.ts`

**Interfaces:**

- Consumes: GET query fields `businessId`, `sourceSignature`, optional `idToken`; PUT JSON `{ businessId: string; sourceSignature: string; mapping: ColumnMapping; idToken?: string }`.
- Produces: `GET(request: NextRequest): Promise<NextResponse>` and `PUT(request: NextRequest): Promise<NextResponse>`; live mode verifies membership at `businessMembers/{businessId}_{uid}`, mock/E2E mode uses the existing explicit bypass convention.

- [ ] **Step 1: Write the complete failing route test**

```typescript
// src/app/api/import-mapping/route.test.ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getMemory = vi.fn();
const putMemory = vi.fn();
vi.mock("@/server/importMappingMemory", () => ({
  getImportMappingMemory: (...args: unknown[]) => getMemory(...args),
  putImportMappingMemory: (...args: unknown[]) => putMemory(...args),
}));
vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => false }));
vi.mock("@/lib/firebaseAdmin", () => ({
  getAdminAuth: () => ({ verifyIdToken: vi.fn() }),
  getAdminDb: () => ({ doc: vi.fn() }),
}));

import { GET, PUT } from "@/app/api/import-mapping/route";

beforeEach(() => {
  vi.clearAllMocks();
  getMemory.mockResolvedValue(null);
  putMemory.mockResolvedValue(undefined);
});

describe("/api/import-mapping", () => {
  it("returns a remembered mapping for the requested account and signature", async () => {
    getMemory.mockResolvedValue({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const request = new Request(
      "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1",
    );
    const response = await GET(request as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mapping: { partNumber: 0, quantity: 4 } });
  });

  it("returns null when no mapping is remembered", async () => {
    const request = new Request(
      "http://localhost/api/import-mapping?businessId=biz-a&sourceSignature=source-1",
    );
    const response = await GET(request as never);
    await expect(response.json()).resolves.toEqual({ mapping: null });
  });

  it("writes a mapping only through PUT", async () => {
    const request = new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        businessId: "biz-a",
        sourceSignature: "source-1",
        mapping: { partNumber: 0, quantity: 4 },
      }),
    });
    const response = await PUT(request as never);
    expect(response.status).toBe(200);
    expect(putMemory).toHaveBeenCalledWith(expect.objectContaining({
      businessId: "biz-a",
      sourceSignature: "source-1",
      mapping: { partNumber: 0, quantity: 4 },
    }));
  });

  it("rejects missing scope and oversized bodies before storage", async () => {
    const missing = await PUT(new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      body: JSON.stringify({ mapping: {} }),
    }) as never);
    expect(missing.status).toBe(400);

    const oversized = await PUT(new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      headers: { "content-length": String(32 * 1024 + 1) },
      body: "{}",
    }) as never);
    expect(oversized.status).toBe(413);
    expect(putMemory).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the route test and verify the expected failure**

Run: `npx vitest run src/app/api/import-mapping/route.test.ts`

Expected: FAIL with `Cannot find module '@/app/api/import-mapping/route'`.

- [ ] **Step 3: Create the complete Route Handler**

```typescript
// src/app/api/import-mapping/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { isLiveAuth } from "@/services/auth/authMode";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import type { ColumnMapping } from "@/services/importSchema";
import {
  getImportMappingMemory,
  putImportMappingMemory,
} from "@/server/importMappingMemory";

export const runtime = "nodejs";
const MAX_MAPPING_BODY_BYTES = 32 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message);
}

async function authorize(businessId: string, idToken: string): Promise<NextResponse | null> {
  if (process.env.IS_E2E === "1" || !isLiveAuth()) return null;
  if (!idToken) return json({ error: "Sign in required." }, 401);
  let uid: string;
  try {
    uid = (await getAdminAuth().verifyIdToken(idToken)).uid;
  } catch (error) {
    if (authConfigurationError(error)) return json({ error: "Server auth is not configured." }, 503);
    return json({ error: "Invalid or expired sign-in." }, 401);
  }
  try {
    const member = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`)
      .get();
    return member.exists ? null : json({ error: "Not a member of this business." }, 403);
  } catch (error) {
    if (authConfigurationError(error)) return json({ error: "Server auth is not configured." }, 503);
    return json({ error: "Could not verify business membership." }, 503);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const businessId = text(request.nextUrl.searchParams.get("businessId"));
  const sourceSignature = text(request.nextUrl.searchParams.get("sourceSignature"));
  const idToken = text(request.nextUrl.searchParams.get("idToken"));
  if (!businessId || !sourceSignature) {
    return json({ error: "businessId and sourceSignature are required." }, 400);
  }
  const denied = await authorize(businessId, idToken);
  if (denied) return denied;
  const record = await getImportMappingMemory(businessId, sourceSignature);
  return json({ mapping: record?.mapping ?? null });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MAPPING_BODY_BYTES) {
    return json({ error: "Import mapping must be 32KB or smaller." }, 413);
  }
  const raw = await request.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > MAX_MAPPING_BODY_BYTES) {
    return json({ error: "Import mapping must be 32KB or smaller." }, 413);
  }
  let body: { businessId?: unknown; sourceSignature?: unknown; mapping?: unknown; idToken?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const businessId = text(body.businessId);
  const sourceSignature = text(body.sourceSignature);
  const idToken = text(body.idToken);
  if (!businessId || !sourceSignature || !body.mapping || typeof body.mapping !== "object") {
    return json({ error: "businessId, sourceSignature, and mapping are required." }, 400);
  }
  const denied = await authorize(businessId, idToken);
  if (denied) return denied;
  await putImportMappingMemory({
    businessId,
    sourceSignature,
    mapping: body.mapping as ColumnMapping,
    updatedAt: new Date().toISOString(),
  });
  return json({ ok: true });
}
```

- [ ] **Step 4: Run the route and store tests**

Run: `npx vitest run src/app/api/import-mapping/route.test.ts src/server/importMappingMemory.test.ts`

Expected: PASS. GET is read-only; PUT is the only mapping-memory write path.

---

## Task 7: Map rows, expose matcher confidence, and build the Stage A preview

**Stage:** A

**Files:**

- Create: `src/services/universalImportPreview.ts`
- Test: `src/services/universalImportPreview.test.ts`
- Modify: `src/services/reconcile/types.ts`
- Modify: `src/services/reconcile/identityMatcher.ts`
- Test: `src/services/reconcile/identityMatcher.test.ts`

**Interfaces:**

- Consumes: `UniversalSheet`, `ColumnMapping`, `MappingSource`, and one `PreviewMatchResult` for each mapped row.
- Produces: `MappingResult`, `PreviewMatchResult`, `mapUniversalRows(sheet: UniversalSheet, mapping: ColumnMapping): MappingResult`, `buildImportPreview(mapped: MappingResult, matches: PreviewMatchResult[], mappingSource: MappingSource): ImportPreview`, exported `JACCARD_THRESHOLD = 0.75`, and optional `MatchResult.confidence`.

- [ ] **Step 1: Write the complete failing preview tests**

```typescript
// src/services/universalImportPreview.test.ts
import { describe, expect, it } from "vitest";
import type { UniversalSheet } from "@/services/importSchema";
import {
  buildImportPreview,
  mapUniversalRows,
  type PreviewMatchResult,
} from "@/services/universalImportPreview";

const sheet: UniversalSheet = {
  fileName: "boss.csv",
  kind: "csv",
  headers: ["PN", "Make", "Model", "Tire Size", "QOH", "Cost"],
  rows: [
    ["ABC-1", "Acme", "Road", "225/45R18", "7", "99"],
    ["ABC-2", "Acme", "Road+", "225/45R18", "2", "88"],
    ["ABC-3", "Acme", "Road", "225/45R18", "bad", "77"],
  ],
  headerRowIndex: 0,
  sourceSignature: "source-1",
  seenRows: [],
};

describe("universalImportPreview", () => {
  it("maps sanitized rows, excludes cost, and rejects an invalid quantity", () => {
    const result = mapUniversalRows(sheet, {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rows[0].expected.raw.cost).toBeUndefined();
    expect(result.rows[0].quantity).toBe(7);
  });

  it("auto-applies only corroborated exact PN hits and routes token matches to fuzzy review", () => {
    const mapped = mapUniversalRows(sheet, {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    const matches: PreviewMatchResult[] = [
      {
        row: mapped.rows[0].expected,
        status: "matched",
        reason: "Part number hit for exact candidate.",
        confidence: 1,
        candidate: { uid: "uid-1", brand: "Acme", name: "Road" },
      },
      {
        row: mapped.rows[1].expected,
        status: "matched",
        reason: "Identity match on size and model name similarity.",
        confidence: 0.75,
        candidate: { uid: "uid-2", brand: "Acme", name: "Road Plus" },
      },
    ];
    const preview = buildImportPreview(mapped, matches, "header");
    expect(preview).toMatchObject({ total: 3, exact: 1, fuzzy: 1, review: 0, reject: 1 });
    expect(preview.headline).toBe("Matched 1 of 3 automatically");
    expect(preview.rows[1].status).toBe("fuzzy");
  });

  it("keeps ambiguous and affix-core candidates out of automatic apply", () => {
    const mapped = mapUniversalRows({ ...sheet, rows: [sheet.rows[0]] }, {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    const ambiguous: PreviewMatchResult = {
      row: mapped.rows[0].expected,
      status: "ambiguous",
      reason: "Two candidates.",
      confidence: null,
      candidates: [
        { uid: "a", brand: "Acme", name: "Road" },
        { uid: "b", brand: "Acme", name: "Road" },
      ],
    };
    expect(buildImportPreview(mapped, [ambiguous], "header").rows[0].status).toBe("review");

    const affix: PreviewMatchResult = {
      row: mapped.rows[0].expected,
      status: "matched",
      reason: "Part number hit through affix core.",
      confidence: 1,
      candidate: { uid: "a", brand: "Acme", name: "Road" },
      viaAffixCore: true,
    };
    expect(buildImportPreview(mapped, [affix], "header").rows[0].status).toBe("fuzzy");
  });
});
```

- [ ] **Step 2: Run the tests and verify the expected failures**

Run: `npx vitest run src/services/universalImportPreview.test.ts src/services/reconcile/identityMatcher.test.ts`

Expected: FAIL because the preview module and `MatchResult.confidence` do not exist.

- [ ] **Step 3: Apply the complete type and matcher patch**

```diff
*** Begin Patch
*** Update File: src/services/reconcile/types.ts
@@
   specs?: string;
+  barcode?: string;
+  name?: string;
+  category?: string;
*** Update File: src/services/reconcile/identityMatcher.ts
@@
 export interface MatchResult {
@@
   reason: string;
+  /** Deterministic similarity in [0,1]. Exact corroborated PN hits are 1. */
+  confidence?: number;
@@
-const JACCARD_THRESHOLD = 0.75;
+export const JACCARD_THRESHOLD = 0.75;
@@
       return {
         row,
         status: "matched",
+        confidence: 1,
         reason: `Part number hit for "${hit.brand} ${hit.name}" (${reasonBits.join(", ") || "corroborated"}).${coreNote}`,
@@
-    const identityMatches: CorpusCandidate[] = [];
+    const identityMatches: Array<{ candidate: CorpusCandidate; confidence: number }> = [];
@@
-      identityMatches.push(cand);
+      identityMatches.push({ candidate: cand, confidence: sim });
@@
-      const cand = identityMatches[0];
+      const { candidate: cand, confidence } = identityMatches[0];
       return {
         row,
         status: "matched",
+        confidence,
@@
-        reason: `Identity match on size ${rowSize} and brand matches ${identityMatches.length} different corpus products (${identityMatches.map((c) => c.name).join(", ")}); cannot pick one safely.`,
-        candidates: identityMatches,
+        reason: `Identity match on size ${rowSize} and brand matches ${identityMatches.length} different corpus products (${identityMatches.map((c) => c.candidate.name).join(", ")}); cannot pick one safely.`,
+        confidence: Math.max(...identityMatches.map((entry) => entry.confidence)),
+        candidates: identityMatches.map((entry) => entry.candidate),
*** Update File: src/services/reconcile/identityMatcher.test.ts
@@
 describe("matchExpectedRow", () => {
+  it("reports exact PN confidence 1 and token similarity confidence at the canonical threshold", () => {
+    const exact = matchExpectedRow(row({ partNumbers: ["ABC-1"], brand: "Acme", sizeText: "225/45R18" }), {
+      lookupByPartNumber: () => [{ uid: "a", brand: "Acme", name: "Road", sizeToken: "225/45R18" }],
+      candidatesByBrandSize: () => [],
+    });
+    expect(exact.confidence).toBe(1);
+
+    const token = matchExpectedRow(row({ partNumbers: ["MISS"], brand: "Acme", model: "Road Sport XL", sizeText: "225/45R18" }), {
+      lookupByPartNumber: () => [],
+      candidatesByBrandSize: () => [{ uid: "b", brand: "Acme", name: "Road Sport", sizeToken: "225/45R18" }],
+    });
+    expect(token.status).toBe("matched");
+    expect(token.confidence).toBeGreaterThanOrEqual(JACCARD_THRESHOLD);
+  });
*** End Patch
```

The test file already has a local `row(...)` fixture helper. Extend its existing import from `identityMatcher.ts` to include `JACCARD_THRESHOLD`. This exact import replacement is required:

```diff
*** Begin Patch
*** Update File: src/services/reconcile/identityMatcher.test.ts
@@
-import { matchExpectedRow } from "@/services/reconcile/identityMatcher";
+import { JACCARD_THRESHOLD, matchExpectedRow } from "@/services/reconcile/identityMatcher";
*** End Patch
```

- [ ] **Step 4: Create the complete preview module**

```typescript
// src/services/universalImportPreview.ts
import type { ColumnMapping, ImportPreview, ImportPreviewRow, MappedImportRow, MappingSource, RetailCatalogMatch, UniversalSheet } from "@/services/importSchema";
import type { MatchResult } from "@/services/reconcile/identityMatcher";

const SENSITIVE_HEADER = /(^|[ _-])(cost|price|retail|msrp|margin)([ _-]|$)/i;

export interface PreviewMatchResult extends MatchResult {
  retailCatalogMatch?: RetailCatalogMatch;
}

export interface MappingResult {
  rows: MappedImportRow[];
  heldForReview: ImportPreviewRow[];
  rejected: ImportPreviewRow[];
}

function cell(row: string[], mapping: ColumnMapping, field: keyof ColumnMapping): string {
  const index = mapping[field];
  return index === undefined ? "" : row[index] ?? "";
}

function displayName(row: Omit<MappedImportRow, "expected">): string {
  return row.name || [row.brand, row.model, row.size].filter(Boolean).join(" ") || row.partNumber || row.barcode;
}

export function mapUniversalRows(sheet: UniversalSheet, mapping: ColumnMapping): MappingResult {
  const rows: MappedImportRow[] = [];
  const heldForReview: ImportPreviewRow[] = [];
  const rejected: ImportPreviewRow[] = [];
  sheet.rows.forEach((sourceCells, rowIndex) => {
    const line = sheet.headerRowIndex + rowIndex + 2;
    const quantityText = cell(sourceCells, mapping, "quantity");
    const quantity = Number(quantityText);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      rejected.push({ source: null, line, status: "reject", reason: `Quantity "${quantityText}" is not a non-negative whole number.`, confidence: null });
      return;
    }
    const base = {
      line,
      partNumber: cell(sourceCells, mapping, "partNumber"),
      barcode: cell(sourceCells, mapping, "barcode"),
      name: cell(sourceCells, mapping, "name"),
      brand: cell(sourceCells, mapping, "brand"),
      model: cell(sourceCells, mapping, "model"),
      size: cell(sourceCells, mapping, "size"),
      category: cell(sourceCells, mapping, "category"),
      quantity,
      uom: cell(sourceCells, mapping, "uom"),
    };
    const identity = base.partNumber || base.barcode || base.name;
    if (!identity) {
      rejected.push({ source: null, line, status: "reject", reason: "No part number, barcode, or name was found on this row.", confidence: null });
      return;
    }
    const raw = Object.fromEntries(
      sheet.headers
        .map((header, index) => [header, sourceCells[index] ?? ""] as const)
        .filter(([header]) => !SENSITIVE_HEADER.test(header)),
    );
    const mapped: MappedImportRow = {
      ...base,
      expected: {
        externalId: identity,
        partNumbers: [...new Set([base.partNumber, base.barcode].filter(Boolean))],
        brand: base.brand || undefined,
        model: base.model || undefined,
        sizeText: base.size || undefined,
        specs: displayName(base),
        barcode: base.barcode || undefined,
        name: displayName(base),
        category: base.category || undefined,
        qty: quantity,
        raw,
      },
    };
    if (mapped.uom && mapped.uom.toLowerCase() !== "each") {
      heldForReview.push({ source: mapped, line, status: "review", reason: `Unit "${mapped.uom}" requires review; only each is applied automatically.`, confidence: null });
      return;
    }
    rows.push(mapped);
  });
  return { rows, heldForReview, rejected };
}

function statusForMatch(match: PreviewMatchResult, mappingSource: MappingSource): ImportPreviewStatus {
  if (match.status === "ambiguous") return "review";
  if (match.status === "matched") {
    if (match.viaAffixCore) return "fuzzy";
    return match.reason.startsWith("Part number hit") ? "exact" : "fuzzy";
  }
  if (match.status === "non_tire" && match.retailCatalogMatch) return "exact";
  return mappingSource === "content" ? "review" : "exact";
}

export function buildImportPreview(
  mapped: MappingResult,
  matches: PreviewMatchResult[],
  mappingSource: MappingSource,
): ImportPreview {
  if (matches.length !== mapped.rows.length) {
    throw new Error(`Matcher returned ${matches.length} results for ${mapped.rows.length} rows.`);
  }
  const matchedRows = mapped.rows.map((source, index): ImportPreviewRow => {
    const match = matches[index];
    const status = statusForMatch(match, mappingSource);
    const reason = match.retailCatalogMatch
      ? `identified from the 4M-product catalog: ${match.retailCatalogMatch.productName}`
      : match.reason;
    return {
      source,
      line: source.line,
      status,
      reason,
      confidence: match.confidence ?? (status === "exact" ? 1 : null),
      candidate: match.candidate,
      retailCatalogMatch: match.retailCatalogMatch,
    };
  });
  const rows = [...matchedRows, ...mapped.heldForReview, ...mapped.rejected].sort((a, b) => a.line - b.line);
  const count = (status: ImportPreviewStatus) => rows.filter((row) => row.status === status).length;
  const exact = count("exact");
  return {
    rows,
    total: rows.length,
    exact,
    fuzzy: count("fuzzy"),
    review: count("review"),
    reject: count("reject"),
    headline: `Matched ${exact} of ${rows.length} automatically`,
  };
}
```

- [ ] **Step 5: Run the focused tests**

Run: `npx vitest run src/services/universalImportPreview.test.ts src/services/reconcile/identityMatcher.test.ts`

Expected: PASS. The exact row is auto-applicable; Jaccard identity and affix-core rows are fuzzy review data only.

---

## Task 8: Enrich non-tire rows with exact retail-corpus evidence

**Stage:** A

**Files:**

- Modify: `src/app/api/reconcile/match/route.ts`
- Test: `src/app/api/reconcile/match/route.test.ts`

**Interfaces:**

- Consumes: `ExpectedInventoryRow.barcode?: string` and `lookupRetailBarcodeAsync(code: string): Promise<RetailLookupResult | null>`.
- Produces: each route result may carry `retailCatalogMatch: { productName: string; brand: string; category: string; barcode: string }`; the route never reads `getLastRetailLookupStatus()`, avoiding its module-level race.

- [ ] **Step 1: Add the complete failing mock and test**

```typescript
// Add beside the existing route-test mocks in src/app/api/reconcile/match/route.test.ts
const mockRetailLookup = vi.fn();
vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  lookupRetailBarcodeAsync: (code: string) => mockRetailLookup(code),
}));

// Add inside beforeEach()
  mockRetailLookup.mockResolvedValue(null);

// Append inside the route matching describe block
  it("adds exact retail-corpus evidence to a non-tire barcode row", async () => {
    mockRetailLookup.mockResolvedValue({
      productName: "Sparkling Water",
      brand: "Acme",
      category: "Beverages",
      barcode: "012345678905",
    });
    const res = await POST(makeRequest({ rows: [validRow({
      externalId: "012345678905",
      partNumbers: ["012345678905"],
      brand: "Acme",
      model: "Sparkling Water",
      sizeText: undefined,
      specs: "Beverages",
      barcode: "012345678905",
    })] }));
    const body = await res.json();
    expect(mockRetailLookup).toHaveBeenCalledWith("012345678905");
    expect(body.matches[0].retailCatalogMatch).toEqual({
      productName: "Sparkling Water",
      brand: "Acme",
      category: "Beverages",
      barcode: "012345678905",
    });
  });
```

- [ ] **Step 2: Run the route test and verify the expected failure**

Run: `npx vitest run src/app/api/reconcile/match/route.test.ts -t "adds exact retail-corpus evidence"`

Expected: FAIL because `lookupRetailBarcodeAsync` is not called and `retailCatalogMatch` is absent.

- [ ] **Step 3: Apply the complete route patch**

```diff
*** Begin Patch
*** Update File: src/app/api/reconcile/match/route.ts
@@
 import { tirePartNumberVariants } from "@/services/catalog/tirePartNumber";
+import { lookupRetailBarcodeAsync } from "@/server/retail-knowledge/retailKnowledgeIndex";
@@
-    matches.push(matchExpectedRow(row, deps));
+    const match = matchExpectedRow(row, deps);
+    if (match.status === "non_tire" && row.barcode) {
+      const retailCatalogMatch = await lookupRetailBarcodeAsync(row.barcode);
+      matches.push(retailCatalogMatch ? { ...match, retailCatalogMatch } : match);
+    } else {
+      matches.push(match);
+    }
*** End Patch
```

- [ ] **Step 4: Run the full route test**

Run: `npx vitest run src/app/api/reconcile/match/route.test.ts`

Expected: PASS. Non-tire exact catalog rows carry the badge payload, and no test calls a real corpus or network.

---

## Task 9: Build the read-only mapping and preview screen

**Stage:** A

**Files:**

- Create: `src/components/UniversalImportPanel.tsx`
- Test: `src/components/UniversalImportPanel.test.tsx`

**Interfaces:**

- Consumes props `readFile(file)`, `loadMapping(sourceSignature)`, `saveMapping(sourceSignature, mapping)`, `matchRows(rows)`, and `onApply(rows)`; no store import is allowed in this file.
- Produces: `UniversalImportPanel(props: UniversalImportPanelProps)`, mapping UI with actual headers and sample values, preview buckets, exact headline, explicit Apply, and delayed mapping save.

- [ ] **Step 1: Write the complete failing component test**

```tsx
// src/components/UniversalImportPanel.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import type { UniversalSheet } from "@/services/importSchema";

const nonsenseSheet: UniversalSheet = {
  fileName: "nonsense.csv",
  kind: "csv",
  headers: ["Alpha", "Beta", "Gamma", "Delta", "Echo"],
  rows: [["ABC-1", "Acme", "Road", "225/45R18", "7"]],
  headerRowIndex: 0,
  sourceSignature: "source-nonsense",
  seenRows: [["Alpha", "Beta", "Gamma", "Delta", "Echo"], ["ABC-1", "Acme", "Road", "225/45R18", "7"]],
};

function props() {
  return {
    readFile: vi.fn().mockResolvedValue(nonsenseSheet),
    loadMapping: vi.fn().mockResolvedValue(null),
    saveMapping: vi.fn().mockResolvedValue(undefined),
    matchRows: vi.fn().mockImplementation(async (rows) => rows.map((row: { expected: unknown }) => ({
      row: row.expected,
      status: "unmatched",
      reason: "No corpus match.",
    }))),
    onApply: vi.fn().mockResolvedValue({ applied: 1, queuedForReview: 0, rejected: 0 }),
  };
}

describe("UniversalImportPanel", () => {
  it("shows actual headers and sample values for a low-confidence file without applying anything", async () => {
    const handlers = props();
    render(<UniversalImportPanel {...handlers} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "nonsense.csv")] } });
    expect(await screen.findByTestId("column-mapping")).toHaveTextContent("Alpha");
    expect(screen.getByTestId("column-mapping")).toHaveTextContent("ABC-1");
    expect(handlers.onApply).not.toHaveBeenCalled();
    expect(handlers.saveMapping).not.toHaveBeenCalled();
  });

  it("previews after manual mapping and writes only after Apply", async () => {
    const handlers = props();
    render(<UniversalImportPanel {...handlers} />);
    fireEvent.change(screen.getByTestId("universal-import-file"), { target: { files: [new File(["x"], "nonsense.csv")] } });
    await screen.findByTestId("column-mapping");
    fireEvent.change(screen.getByLabelText("Part number column"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Brand column"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Model column"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Size column"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Quantity column"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview mapped file" }));
    expect(await screen.findByTestId("import-headline")).toHaveTextContent("Matched 1 of 1 automatically");
    expect(handlers.onApply).not.toHaveBeenCalled();
    expect(handlers.saveMapping).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 rows" }));
    await waitFor(() => expect(handlers.onApply).toHaveBeenCalledTimes(1));
    expect(handlers.saveMapping).toHaveBeenCalledWith("source-nonsense", {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `npx vitest run src/components/UniversalImportPanel.test.tsx`

Expected: FAIL with `Cannot find module '@/components/UniversalImportPanel'`.

- [ ] **Step 3: Create the complete component**

```tsx
// src/components/UniversalImportPanel.tsx
"use client";

import { useRef, useState } from "react";
import { IMPORT_FIELD_ORDER, type ColumnMapping, type ImportPreview, type ImportPreviewRow, type MappedImportRow, type UniversalImportApplySummary, type UniversalSheet, type UploadFileLike } from "@/services/importSchema";
import { inferColumnMapping, validateManualMapping } from "@/services/columnIntelligence";
import { readUniversalFile } from "@/services/universalFileReader";
import { buildImportPreview, mapUniversalRows, type PreviewMatchResult } from "@/services/universalImportPreview";

const PREVIEW_LIMIT = 20;

export interface UniversalImportPanelProps {
  readFile?: (file: UploadFileLike) => Promise<UniversalSheet>;
  loadMapping(sourceSignature: string): Promise<ColumnMapping | null>;
  saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void>;
  matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]>;
  onApply(rows: ImportPreviewRow[]): Promise<UniversalImportApplySummary> | UniversalImportApplySummary;
}

const FIELD_LABELS: Record<(typeof IMPORT_FIELD_ORDER)[number], string> = {
  partNumber: "Part number",
  brand: "Brand",
  model: "Model",
  size: "Size",
  quantity: "Quantity",
  uom: "Unit",
  barcode: "Barcode",
  name: "Name",
  category: "Category",
};

export function UniversalImportPanel({
  readFile = readUniversalFile,
  loadMapping,
  saveMapping,
  matchRows,
  onApply,
}: UniversalImportPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<UniversalSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [mappingMode, setMappingMode] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<UniversalImportApplySummary | null>(null);

  async function previewWith(nextSheet: UniversalSheet, nextMapping: ColumnMapping, source: "header" | "content" | "manual" | "remembered") {
    const validation = validateManualMapping(nextSheet.headers, nextMapping);
    if (!validation.ok) {
      setError(`${validation.errors.join(" ")} Seen headers: ${nextSheet.headers.join(", ") || "(none)"}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const mapped = mapUniversalRows(nextSheet, nextMapping);
      const matches = await matchRows(mapped.rows);
      setPreview(buildImportPreview(mapped, matches, source));
      setMapping(nextMapping);
      setMappingMode(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not build the import preview.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    setPreview(null);
    setSummary(null);
    try {
      const nextSheet = await readFile(file);
      setSheet(nextSheet);
      const remembered = await loadMapping(nextSheet.sourceSignature);
      if (remembered) {
        await previewWith(nextSheet, remembered, "remembered");
        return;
      }
      const inferred = inferColumnMapping([nextSheet.headers, ...nextSheet.rows]);
      setMapping(inferred.mapping);
      if (inferred.confidence === "high") {
        await previewWith(nextSheet, inferred.mapping, "header");
      } else {
        setMappingMode(true);
        setError(inferred.reasons.join(" "));
      }
    } catch (cause) {
      setSheet(null);
      setError(cause instanceof Error ? cause.message : "Could not read this file.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!sheet || !preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await onApply(preview.rows);
      setSummary(result);
      await saveMapping(sheet.sourceSignature, mapping);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply this import.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4" data-testid="universal-import-panel">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Universal inventory import</h2>
        <p className="text-sm text-zinc-600">Choose CSV, TSV, XLSX, or XLS. Nothing changes until you press Apply.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => inputRef.current?.click()} className="min-h-[44px] rounded-lg border border-zinc-300 px-4 font-medium">Choose file</button>
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept=".csv,.tsv,.xlsx,.xls,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          data-testid="universal-import-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void onFile(file);
          }}
        />
        {sheet && <span className="text-sm text-zinc-600">{sheet.fileName}</span>}
      </div>
      {error && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="import-error">{error}</p>}
      {mappingMode && sheet && (
        <div className="flex flex-col gap-3" data-testid="column-mapping">
          <h3 className="font-semibold">Map the columns we saw</h3>
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <thead><tr>{sheet.headers.map((header, index) => <th key={`${header}-${index}`} className="px-2 py-1">{header || `(blank ${index + 1})`}</th>)}</tr></thead>
              <tbody>{sheet.rows.slice(0, 3).map((row, rowIndex) => <tr key={rowIndex}>{sheet.headers.map((_, index) => <td key={index} className="px-2 py-1">{row[index] || "-"}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {IMPORT_FIELD_ORDER.map((field) => (
              <label key={field} className="flex flex-col gap-1 text-sm">
                {FIELD_LABELS[field]}
                <select
                  aria-label={`${FIELD_LABELS[field]} column`}
                  value={mapping[field] ?? ""}
                  onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value === "" ? undefined : Number(event.target.value) }))}
                  className="min-h-[44px] rounded border border-zinc-300 px-2"
                >
                  <option value="">Not mapped</option>
                  {sheet.headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header || `(blank ${index + 1})`}</option>)}
                </select>
              </label>
            ))}
          </div>
          <button type="button" disabled={busy} onClick={() => void previewWith(sheet, mapping, "manual")} className="min-h-[44px] w-fit rounded-lg bg-blue-600 px-4 font-medium text-white disabled:opacity-50">Preview mapped file</button>
        </div>
      )}
      {preview && (
        <div className="flex flex-col gap-3" data-testid="import-preview">
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
            <p className="text-xl font-bold text-emerald-900" data-testid="import-headline">{preview.headline}</p>
            <p className="text-sm text-emerald-800">{preview.exact} exact, {preview.fuzzy} fuzzy, {preview.review} review, {preview.reject} rejected</p>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <thead><tr><th className="px-2 py-2">Line</th><th className="px-2 py-2">Item</th><th className="px-2 py-2">Qty</th><th className="px-2 py-2">Result</th><th className="px-2 py-2">Why</th></tr></thead>
              <tbody>{preview.rows.slice(0, PREVIEW_LIMIT).map((row) => <tr key={row.line} className="border-t border-zinc-100"><td className="px-2 py-2">{row.line}</td><td className="px-2 py-2">{row.source?.expected.name ?? row.source?.partNumber ?? "Unreadable row"}</td><td className="px-2 py-2">{row.source?.quantity ?? "-"}</td><td className="px-2 py-2 font-medium">{row.status}</td><td className="px-2 py-2">{row.reason}{row.confidence !== null ? ` (${Math.round(row.confidence * 100)}%)` : ""}</td></tr>)}</tbody>
            </table>
          </div>
          {!summary && <button type="button" disabled={busy} onClick={() => void apply()} className="min-h-[44px] w-fit rounded-lg bg-blue-600 px-4 font-medium text-white disabled:opacity-50">Apply {preview.total} rows</button>}
        </div>
      )}
      {summary && <p className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900" data-testid="import-summary">Applied {summary.applied}. Needs Review {summary.queuedForReview}. Rejected {summary.rejected}.</p>}
      {busy && <p className="text-sm text-zinc-600">Working...</p>}
    </section>
  );
}
```

- [ ] **Step 4: Run the focused component test**

Run: `npx vitest run src/components/UniversalImportPanel.test.tsx`

Expected: PASS, 2 tests. Before Apply, both `onApply` and `saveMapping` have zero calls.

---

## Task 10: Add the import quantity resolution variant and wire the products page

**Stage:** A

**Monolith warning:** This is the only Stage A edit to `src/stores/scanStore.ts`. It is intentionally ordered after every pure service and the read-only UI.

**Files:**

- Modify: `src/types.ts`
- Modify: `src/services/security/sensitiveFields.ts`
- Modify: `src/stores/scanStore.ts`
- Modify: `src/stores/scanStoreMigrate.test.ts`
- Create: `src/stores/universalImport.store.test.ts`
- Modify: `src/components/NeedsReviewTable.tsx`
- Create: `src/components/UniversalImportPanelContainer.tsx`
- Modify: `src/app/(app)/products/page.tsx`

**Interfaces:**

- Consumes: `ImportPreviewRow[]`, `ImportReviewContext`, existing `reopenNeedsReview`, `resolveUnknown`, `processScan`, and `snapshotCount`.
- Produces: optional persisted `UnknownCodeReview.importQuantity?: number`; `reopenNeedsReview(cleanCode: string, reason: string, importContext?: ImportReviewContext): string | null`; `applyUniversalImport(rows: ImportPreviewRow[]): UniversalImportApplySummary`; exact Apply resolves with `origin: "human"`; fuzzy Apply creates review only; later human confirmation applies the full stored quantity.

- [ ] **Step 1: Write the complete store regression test**

```typescript
// src/stores/universalImport.store.test.ts
import { describe, expect, it } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import type { ImportPreviewRow } from "@/services/importSchema";

function previewRow(status: "exact" | "fuzzy", code: string, quantity: number): ImportPreviewRow {
  return {
    line: 2,
    status,
    reason: status === "exact" ? "Part number hit for exact candidate." : "Character-level fuzzy candidate.",
    confidence: status === "exact" ? 1 : 0.8,
    candidate: { uid: `uid-${code}`, brand: "Acme", name: "Road", partNumber: code },
    source: {
      line: 2,
      partNumber: code,
      barcode: "",
      name: "",
      brand: "Acme",
      model: "Road",
      size: "225/45R18",
      category: "Tires",
      quantity,
      uom: "each",
      expected: {
        externalId: code,
        partNumbers: [code],
        brand: "Acme",
        model: "Road",
        sizeText: "225/45R18",
        qty: quantity,
        raw: {},
      },
    },
  };
}

describe("applyUniversalImport", () => {
  it("does not write until called, then exact rows approve and apply the full quantity", () => {
    const store = createTestScanStore();
    const before = store.getState();
    expect(before.finalCounts).toEqual([]);
    expect(before.needsReviewQueue).toEqual([]);
    const summary = before.applyUniversalImport([previewRow("exact", "PN-EXACT-1", 3)]);
    expect(summary).toEqual({ applied: 1, queuedForReview: 0, rejected: 0 });
    const after = store.getState();
    expect(after.aliases.some((alias) => alias.cleanCode === "PN-EXACT-1" && alias.approved)).toBe(true);
    expect(after.finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(3);
    expect(after.countSnapshots).toHaveLength(2);
  });

  it("routes fuzzy rows to Needs Review without alias or quantity, then human confirmation applies quantity", () => {
    const store = createTestScanStore();
    const summary = store.getState().applyUniversalImport([previewRow("fuzzy", "PN-FUZZY-1", 4)]);
    expect(summary).toEqual({ applied: 0, queuedForReview: 1, rejected: 0 });
    let state = store.getState();
    const review = state.needsReviewQueue.find((item) => item.cleanCode === "PN-FUZZY-1");
    expect(review?.importQuantity).toBe(4);
    expect(state.aliases.some((alias) => alias.cleanCode === "PN-FUZZY-1")).toBe(false);
    expect(state.finalCounts).toEqual([]);

    state.resolveUnknown(review!.id, "create_new", {
      origin: "human",
      applyToCount: true,
      newProduct: { name: review!.suggestedProductName, brand: review!.suggestedBrand },
    });
    state = store.getState();
    expect(state.aliases.some((alias) => alias.cleanCode === "PN-FUZZY-1" && alias.approved)).toBe(true);
    expect(state.finalCounts.reduce((sum, count) => sum + count.quantity, 0)).toBe(4);
  });
});
```

- [ ] **Step 2: Run the store test and verify the expected failure**

Run: `npx vitest run src/stores/universalImport.store.test.ts`

Expected: FAIL because `ScanState.applyUniversalImport` and `UnknownCodeReview.importQuantity` do not exist.

- [ ] **Step 3: Apply the complete contract, persistence, monolith, and resolution patch**

```diff
*** Begin Patch
*** Update File: src/types.ts
@@
 export interface UnknownCodeReview {
@@
   provisionalProductId?: string | null;
+  /** Phase 4 import-only quantity. Absent for scans and reconcile links. A fuzzy import row keeps
+   *  this quantity pending until an explicit human confirmation applies it. */
+  importQuantity?: number;
 }
*** Update File: src/services/security/sensitiveFields.ts
@@
   "provisionalProductId",
+  "importQuantity",
 ] as const;
*** Update File: src/stores/scanStore.ts
@@
 import type { AiStatus } from "@/types";
+import type { ImportPreviewRow, ImportReviewContext, UniversalImportApplySummary } from "@/services/importSchema";
@@
   reopenNeedsReview: (cleanCode: string, reason: string) => string | null;
+  applyUniversalImport: (rows: ImportPreviewRow[]) => UniversalImportApplySummary;
@@
-  reopenNeedsReview: (cleanCode: string, reason: string) => string | null;
+  reopenNeedsReview: (cleanCode: string, reason: string, importContext?: ImportReviewContext) => string | null;
@@
-      reopenNeedsReview: (cleanCode, reason) => {
+      reopenNeedsReview: (cleanCode, reason, importContext) => {
@@
                     correctionRecheckStatus: undefined, correctionRecheckedAt: null, correctionRecheckMissingKeys: undefined,
                     reopenedFromWrong: true,
+                    importQuantity: importContext?.importQuantity,
+                    suggestedProductName: importContext?.suggestion?.name ?? "",
+                    suggestedBrand: importContext?.suggestion?.brand ?? "",
+                    suggestedCategory: importContext?.suggestion?.category ?? "",
+                    suggestedSpecsShort: importContext?.suggestion?.specsShort ?? "",
+                    suggestedPrimarySku: importContext?.suggestion?.primarySku ?? "",
+                    suggestedPrimaryBarcode: importContext?.suggestion?.primaryBarcode ?? "",
+                    hasSuggestion: Boolean(importContext?.suggestion),
                   }
@@
           syncStatus: "pending", idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, id, "SAVE_UNKNOWN_SCAN"),
+          importQuantity: importContext?.importQuantity,
+          ...(importContext?.suggestion ? {
+            suggestedProductName: importContext.suggestion.name,
+            suggestedBrand: importContext.suggestion.brand,
+            suggestedCategory: importContext.suggestion.category,
+            suggestedSpecsShort: importContext.suggestion.specsShort,
+            suggestedPrimarySku: importContext.suggestion.primarySku,
+            suggestedPrimaryBarcode: importContext.suggestion.primaryBarcode,
+            hasSuggestion: true,
+          } : {}),
         };
@@
-        if (payload.applyToCount && !weakGuessProduct && !approvingProvisional) {
-          get().processScan(review.rawCode || review.cleanCode);
+        if (payload.applyToCount && !weakGuessProduct && !approvingProvisional) {
+          const applications = review.importQuantity ?? 1;
+          if (!Number.isSafeInteger(applications) || applications < 0) return;
+          for (let index = 0; index < applications; index += 1) {
+            get().processScan(review.rawCode || review.cleanCode);
+          }
         } else {
           get().syncPending();
         }
       },
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
import { readUniversalFile, inferColumnMapping, validateManualMapping, buildSourceSignature } from "@/services/importSchema";

const dir = join(__dirname, "__fixtures__");
function file(name: string, type = "text/csv") {
  return { name, type, arrayBuffer: async () => readFileSync(join(dir, name)) } as unknown as Parameters<typeof readUniversalFile>[0];
}

describe("Stage A fixture battery (AC1, AC3)", () => {
  it("Shop-Ware headers import without the old four-name failure", async () => {
    const sheet = await readUniversalFile(file("shopware.csv"));
    const inference = inferColumnMapping(sheet.matrix);
    expect(inference.mapping.name).toBeGreaterThanOrEqual(0);
    expect(inference.mapping.quantity).toBeGreaterThanOrEqual(0);
  });

  it("reordered/renamed/extra/blank-leading-row TSV maps by synonym, not position", async () => {
    const sheet = await readUniversalFile(file("reordered-renamed.tsv", "text/tab-separated-values"));
    const inference = inferColumnMapping(sheet.matrix);
    expect(inference.mapping.partNumber).toBeGreaterThanOrEqual(0);
    expect(inference.mapping.tireSize).toBeGreaterThanOrEqual(0);
  });

  it("nonsense-header file yields low confidence and requires manual mapping (AC3)", async () => {
    const sheet = await readUniversalFile(file("nonsense-headers.csv"));
    const inference = inferColumnMapping(sheet.matrix);
    expect(inference.confidence).toBe("low");
    const manual = validateManualMapping({ name: 0, tireSize: 2, quantity: 3 }, sheet.matrix[0].length);
    expect(manual.ok).toBe(true);
  });

  it("the same file yields a stable source signature for mapping memory (AC3 remembered)", async () => {
    const sheet = await readUniversalFile(file("nonsense-headers.csv"));
    const a = buildSourceSignature(sheet.matrix[0]);
    const b = buildSourceSignature(sheet.matrix[0]);
    expect(a).toBe(b);
  });

  it("every imported cell passes through the sanitizer (no raw formula injection survives)", async () => {
    const sheet = await readUniversalFile(file("shopware.csv"));
    for (const row of sheet.matrix) for (const cell of row) {
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
import { inferColumnMapping } from "@/services/importSchema";

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
