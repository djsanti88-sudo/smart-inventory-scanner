# Phase 4: Universal Import and Smart Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Track every checkbox, run every failing test before implementation, and perform independent review before merging parallel tracks.

**Goal:** Let a Scanbin account upload CSV, TSV, XLSX, or a file carrying an `.xls` name, understand or manually map its columns, see one honest preview headed by `Matched 380 of 400 automatically`, and explicitly apply exact rows while every algorithmic fuzzy or ambiguous row stays in Needs Review until a human confirms it. The flow must feed the existing count snapshots, variance view, and Boss Report without any inventory, alias, count, review, localStorage, Turso, or Firestore write before the Apply click. ExcelJS 4.4.0 can read XLSX but not legacy BIFF, so true BIFF `.xls` remains a flagged acceptance gap until the owner approves a compatible parser.

**Architecture:** Build Stage A as an isolated universal-import pipeline around the existing pure seams. `sanitizeCell(raw: string): string` remains the single untrusted-cell boundary in `src/services/csvImport.ts`; `readUniversalFile(file: UploadFileLike): Promise<UniversalSheet>` sanitizes every CSV, TSV, and ExcelJS cell before inference. `inferColumnMapping(matrix: string[][]): ColumnInference` performs deterministic header normalization and conservative content inference, then `UniversalImportPanel` falls back to an explicit mapping screen. Preview calls the existing Node route `POST /api/reconcile/match`, which continues to run `matchExpectedRow(row, deps)` and gains exact retail-corpus enrichment through `lookupRetailBarcodeAsync(code)`. Preview state stays in React memory only. Mapping memory is a namespaced Turso KV record through `LadderStorage.get/set`, keyed by `businessId` and `sourceSignature`; its route writes only after Apply. Exact human-upload rows use the existing `resolveUnknown(reviewId, action, payload)` human origin path and remain `approved: true`. Fuzzy rows are staged as import-specific Needs Review records with persisted `importQuantity`. The distinct `resolveImportReview(reviewId, action, payload)` action confirms identity with `applyToCount: false`, then applies the stored quantity through the existing ledger-backed `processScan(rawCode)` path. Stage B starts only after the complete Stage A proof gate and adds net-new character-level edit distance plus the canonical token Jaccard from `src/services/catalog/identityMerge.ts`.

**Tech Stack:** Next.js 16.2.9 App Router and Route Handlers, React 19.2.4, TypeScript 5, Tailwind v4, Zustand 5.0.14, Vitest 4.1.8 unit and dom projects, Playwright 1.60.0, `csv-parse` 7.0.0, ExcelJS 4.4.0 lazy read, existing tire and retail SQLite/Turso corpus access, and existing Turso/file-backed `LadderStorage` KV.

## Global Constraints

- **Repository and branch:** execute in `C:\Users\djsan\inventory` on `feat/decode-ladder-goupc`.
- **Stage order:** Tasks 1 through 12 are Stage A. Task 12 is the independently shippable Stage A gate. Tasks 13 through 15 are Stage B and cannot start until Task 12 passes. No Stage B tuning may block a Stage A release.
- **Binding threshold T:** `0.75`, grounded in `src/services/reconcile/identityMatcher.ts:66` and the existing literal used by `findIdentityMerge` in `src/services/catalog/identityMerge.ts:167`. Task 7 exports `IDENTITY_JACCARD_THRESHOLD = 0.75` from the canonical identity-merge module and makes both existing consumers import it. Stage B imports it and does not create a third threshold literal.
- **Canonical Jaccard:** only `jaccard(a: string[], b: string[]): number`, `nameTokens(s: string | null | undefined): string[]`, and `plusGenerationDiff(a: string[], b: string[]): boolean` from `src/services/catalog/identityMerge.ts` are canonical for Phase 4. The independent `jaccard` functions in `src/services/ai/crossCheckEngine.ts` and `src/services/fetchV2/siblingGuard.ts` remain untouched. This is a landmine: `identityMerge.ts` returns `0` for empty/empty, while `siblingGuard.ts` returns `1`. Unifying them is out of scope.
- **Resolver trust invariant:** wrong identity is failure and ambiguity is acceptable. Every product-identity fuzzy match, including a score at or above `0.75`, is suggestion data only until a human confirms it. Every fuzzy score below `0.75`, every tie, every affix-core-only match, and every conflicting corroboration routes to Needs Review. No fuzzy row receives `approved: true` during Apply. Exact human-upload rows retain the current `approved: true`, `verified: true` behavior through `resolveUnknown` with `origin: "human"`.
- **Preview before apply:** follow the preview-and-confirm precedent in `src/stores/reconcileStore.ts` and `src/components/ReconcilePanel.tsx`, but keep universal-import preview in React memory because the persisted reconcile store would write localStorage before Apply. File read, column inference, mapping UI, corpus lookup, and preview are read-only. They may perform GET/POST reads, but they must not call `useScanStore.setState`, `reopenNeedsReview`, `resolveUnknown`, `snapshotCount`, `LadderStorage.set`, or a Firestore write. The first permitted write is the explicit Apply click.
- **Demo beat:** the preview header is exactly `Matched X of Y automatically`; the scripted fixture proves `Matched 380 of 400 automatically` on one screen before Apply.
- **Sanitizer boundary:** every imported cell follows exactly `stripControlChars -> 500-character cap -> defuseFormulaInjection` through `sanitizeCell`. This applies to CSV, TSV, XLSX, OOXML-with-`.xls` filenames, header cells, mapped cells, sample rows, and `ExpectedInventoryRow.raw`. Task 2 closes the current Shop-Ware adapter gap.
- **ExcelJS read reality:** `package.json` contains `exceljs: ^4.4.0`, and `node_modules/exceljs/README.md` documents `workbook.xlsx.load(data)` for XLSX only. Task 4 introduces the first repository read path. A true legacy BIFF `.xls` file is not silently claimed as supported; it gets the exact error `Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.` Supporting genuine BIFF remains a flagged unknown requiring an owner-approved parser decision. An OOXML payload named `.xls` is accepted because content, not the suffix, is passed to `workbook.xlsx.load`.
- **Mapping memory decision:** choose Turso KV, wrapped by `src/server/importMappingMemory.ts`, using `LadderStorage.get/set` and key `import_mapping::<businessId>::<sourceSignature>`. Firestore is not chosen because the current default and demo backend is mock, while Firestore-only memory would disappear from that path. localStorage is not chosen because it is per browser rather than per account. The namespaced Turso/file seam works in mock and live modes, remains outside inventory truth, and preserves per-account keys. The API route still verifies membership in live mode. Reusing `ladder_kv` is an acknowledged semantic compromise; a dedicated table is deferred until mapping volume or retention warrants it.
- **Monolith containment:** Tasks 1 through 10 create isolated modules or touch narrow existing files. Task 11 is the only Stage A task that edits the approximately 5,700-line `src/stores/scanStore.ts`; it is ordered last among Stage A implementation tasks and adds only optional import review context, `resolveImportReview`, and `applyUniversalImport`.
- **Persist migration law:** the actual store is `name: "sis-scan-v1"`, `version: 8`, with `scanStoreMigrate(persisted, version)` at `src/stores/scanStore.ts:5685` and the version at `src/stores/scanStore.ts:5733`. Task 11 bumps to version 9 because `UnknownCodeReview.importQuantity` is persisted. Its migration preserves the v8 rule at `src/stores/scanStore.ts:5703`: transform only keys the blob already carries, never inject absent arrays or settings into a partial blob. `countSnapshots` remains the one documented unconditional exception at line 5721.
- **Performance:** parsing, mapping, matching supplied in-memory match results, and constructing a 5,000-row preview must complete in less than `10_000` ms locally. The performance test excludes Apply and external network latency, which are not import processing.
- **Limits already grounded in code:** `MAX_FIELD_LENGTH = 500`, `PREVIEW_LIMIT = 20`, and reconcile route `MAX_ROWS = 20000`. The mapping API body cap reuses the existing share-route value `32 * 1024` bytes.
- **No paid or live calls:** automated tests mock retail/Turso/Firebase access and never call paid providers. Phase 4 does not call `/api/ai-lookup`.
- **No em dash or en dash:** all new user-facing copy, source comments, tests, fixtures, and this plan use ASCII punctuation.
- **Out of scope:** unifying the three legacy Jaccard implementations, replacing the scan ledger, live production import, importing price/cost, adding AI-based column mapping, and claiming true BIFF `.xls` support without a compatible parser.
- **Cost worst case:** paid API cost is `$0`; this phase uses deterministic code and existing local/server corpora. Subscription token usage is reported at closeout rather than guessed in advance.

## Track and dependency map

This plan contains exactly 15 tasks.

| Track | Tasks | Dependency |
|---|---|---|
| Stage A contract and sanitizer | 1, then 2 | Sequential foundation |
| Stage A column and file intelligence | 3, then 4 | Sequential |
| Stage A mapping memory | 5, then 6 | Parallel with Tasks 7 through 10 after Task 4 |
| Stage A preview and corpus | 7, then 8 | Parallel with Tasks 5, 6, 9, and 10 at disjoint boundaries |
| Stage A UI | 9 after Tasks 6 through 8 | Component-only before store bridge |
| Stage A legacy and performance | 10 after Tasks 1 through 4 and 7 | Parallel legacy adapter track |
| Stage A store bridge | 11 after Tasks 5 through 10 | Sole monolith task |
| Stage A ship gate | 12 after Task 11 | Blocking gate |
| Stage B edit distance | 13 after Task 12 | Strictly after Stage A |
| Stage B fuzzy matcher | 14 after Task 13 | Pure matcher |
| Stage B integration | 15 after Task 14 | Final route, fixture, E2E, and polish gate |

Tasks 5, 8, 9, and 10 can be assigned to parallel workers once their listed dependencies are complete because their production files do not overlap. Task 11 serializes the only scanStore change. Tasks 13 through 15 cannot begin until Task 12 proves Stage A independently shippable.

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
-    const available =â€¦15636 tokens truncatedâ€¦iew");
    expect(result.reason).toContain("brand prefix conflict");
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/services/reconcile/importFuzzyMatcher.test.ts

Expected: FAIL with Cannot find module '@/services/reconcile/importFuzzyMatcher…12600 tokens truncated…onst SENSITIVE_HEADER = /(^|[ _-])(cost|price|retail|msrp|margin)([ _-]|$)/i;

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
      rejected.push({
        source: null,
        line,
        status: "reject",
        reason: "Quantity " + JSON.stringify(quantityText) + " is not a non-negative whole number.",
        confidence: null,
      });
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
      rejected.push({
        source: null,
        line,
        status: "reject",
        reason: "No part number, barcode, or name was found on this row.",
        confidence: null,
      });
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
      heldForReview.push({
        source: mapped,
        line,
        status: "review",
        reason: "Unit " + JSON.stringify(mapped.uom) + " requires review; only each is automatic.",
        confidence: null,
      });
      return;
    }
    rows.push(mapped);
  });

  return { rows, heldForReview, rejected };
}

function statusForMatch(match: PreviewMatchResult, mappingSource: MappingSource): ImportPreviewStatus {
  if (match.status === "ambiguous") return "review";
  if (match.status === "matched") return match.matchBasis === "part_number_exact" ? "exact" : "fuzzy";
  if (match.status === "non_tire" && match.retailCatalogMatch) return "exact";
  return mappingSource === "content" ? "review" : "exact";
}

export function buildImportPreview(
  mapped: MappingResult,
  matches: PreviewMatchResult[],
  mappingSource: MappingSource,
): ImportPreview {
  if (matches.length !== mapped.rows.length) {
    throw new Error("Matcher returned " + matches.length + " results for " + mapped.rows.length + " rows.");
  }

  const matchedRows = mapped.rows.map((source, index): ImportPreviewRow => {
    const match = matches[index];
    const status = statusForMatch(match, mappingSource);
    return {
      source,
      line: source.line,
      status,
      reason: match.retailCatalogMatch
        ? "Identified from the retail catalog: " + match.retailCatalogMatch.productName
        : match.reason,
      confidence: match.confidence ?? (status === "exact" ? 1 : null),
      candidate: match.candidate,
      retailCatalogMatch: match.retailCatalogMatch,
    };
  });

  const rows = [...matchedRows, ...mapped.heldForReview, ...mapped.rejected]
    .sort((left, right) => left.line - right.line);
  const count = (status: ImportPreviewStatus) => rows.filter((row) => row.status === status).length;
  const exact = count("exact");
  return {
    rows,
    total: rows.length,
    exact,
    fuzzy: count("fuzzy"),
    review: count("review"),
    reject: count("reject"),
    headline: "Matched " + exact + " of " + rows.length + " automatically",
  };
}
~~~

- [ ] **Step 5: Run focused tests**

Run: npx vitest run src/services/universalImportPreview.test.ts src/services/reconcile/identityMatcher.test.ts

Expected: PASS. Exact PN evidence is the only matcher result auto-classified. Jaccard, affix-core, and ambiguity data never auto-applies.

---

## Task 3: Build deterministic column intelligence and manual validation

**Stage:** A

**Files:**

- Create: src/services/columnIntelligence.ts
- Test: src/services/columnIntelligence.test.ts

**Interfaces:**

- Consumes: ImportField, ColumnMapping, MappingSource, sanitizeCell(raw: string): string, isGtinShaped(code: string): boolean, and tireSizeToken(r: IdentityText | null | undefined): string.
- Produces: HEADER_SYNONYMS, ColumnInference, normalizeImportHeader(value: string): string, inferColumnMapping(matrix: string[][]): ColumnInference, and validateManualMapping(headers: string[], mapping: ColumnMapping): { ok: true } | { ok: false; errors: string[] }.

- [ ] **Step 1: Write the complete failing test**

~~~typescript
// src/services/columnIntelligence.test.ts
import { describe, expect, it } from "vitest";
import { inferColumnMapping, normalizeImportHeader, validateManualMapping } from "@/services/columnIntelligence";

describe("columnIntelligence", () => {
  it("maps the binding vocabulary in any order", () => {
    expect(normalizeImportHeader(" Item No. ")).toBe("item no");
    const result = inferColumnMapping([
      [],
      ["QOH", "Tire Size", "Model", "Make", "PN", "Unused"],
      ["4", "225/45R18", "Road", "Acme", "ABC-1", "x"],
    ]);
    expect(result).toMatchObject({
      headerRowIndex: 1,
      mapping: { quantity: 0, size: 1, model: 2, brand: 3, partNumber: 4 },
      confidence: "high",
      source: "header",
    });
  });

  it("keeps content inference conservative", () => {
    const result = inferColumnMapping([
      ["aaa", "bbb", "ccc"],
      ["012345678905", "225/45R18", "7"],
      ["012345678912", "245/40R18", "3"],
    ]);
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("content");
    expect(result.mapping).toMatchObject({ barcode: 0, size: 1, quantity: 2 });
  });

  it("requires quantity plus identity and rejects duplicate assignments", () => {
    expect(validateManualMapping(["a", "b"], { partNumber: 0 })).toEqual({
      ok: false,
      errors: ["Map a quantity column."],
    });
    expect(validateManualMapping(["a"], { partNumber: 0, quantity: 0 })).toEqual({
      ok: false,
      errors: ["One source column cannot be assigned to more than one field."],
    });
    expect(validateManualMapping(["a", "b"], { partNumber: 0, quantity: 1 })).toEqual({ ok: true });
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/services/columnIntelligence.test.ts

Expected: FAIL with Cannot find module '@/services/columnIntelligence'.

- [ ] **Step 3: Create the complete module**

~~~typescript
// src/services/columnIntelligence.ts
import { tireSizeToken } from "@/services/ai/tireSpecs";
import { isGtinShaped } from "@/services/catalog/barcodeGrade";
import { sanitizeCell } from "@/services/csvImport";
import type { ColumnMapping, ImportField, MappingSource } from "@/services/importSchema";

export const HEADER_SYNONYMS: Record<ImportField, string[]> = {
  partNumber: ["part number", "part no", "part", "part #", "pn", "item no", "mfg part number", "sku", "primary sku"],
  brand: ["brand", "make", "manufacturer", "mfg"],
  model: ["model", "product model"],
  size: ["size", "tire size", "tyre size"],
  quantity: ["quantity", "qty", "qoh", "qty on hand", "quantity on hand", "on hand"],
  uom: ["uom", "unit", "unit of measure"],
  barcode: ["barcode", "primary barcode", "upc", "ean", "gtin"],
  name: ["name", "product name", "description"],
  category: ["category", "product category"],
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
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[.:]+$/g, "")
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

function valuesFor(matrix: string[][], headerIndex: number, column: number): string[] {
  return matrix.slice(headerIndex + 1, headerIndex + 21)
    .map((row) => row[column] ?? "")
    .filter(Boolean);
}

function contentField(values: string[]): ImportField | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => isGtinShaped(value))) return "barcode";
  if (values.every((value) => tireSizeToken({ productName: value }) !== "")) return "size";
  if (values.every((value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0)) return "quantity";
  return undefined;
}

export function inferColumnMapping(matrix: string[][]): ColumnInference {
  const candidates = matrix
    .map((row, index) => ({ row, index, score: row.filter(fieldForHeader).length }))
    .filter(({ row }) => nonBlank(row));
  const first = candidates[0] ?? { row: [], index: 0, score: 0 };
  const header = candidates.reduce((best, current) => current.score > best.score ? current : best, first);
  const headers = header.row.map(sanitizeCell);
  const mapping: ColumnMapping = {};
  const reasons: string[] = [];

  headers.forEach((value, index) => {
    const field = fieldForHeader(value);
    if (field && mapping[field] === undefined) mapping[field] = index;
  });

  let source: MappingSource = "header";
  if (header.score < 2) {
    source = "content";
    headers.forEach((_value, index) => {
      const field = contentField(valuesFor(matrix, header.index, index));
      if (field && mapping[field] === undefined) {
        mapping[field] = index;
        reasons.push("Column " + (index + 1) + " inferred as " + field + ".");
      }
    });
  }

  const valid = validateManualMapping(headers, mapping);
  return {
    headerRowIndex: header.index,
    headers,
    mapping,
    confidence: header.score >= 2 && valid.ok ? "high" : "low",
    source,
    seenHeaders: headers.map(normalizeImportHeader),
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
    return { ok: false, errors: ["A mapped column is outside the uploaded header range."] };
  }
  if (mapping.quantity === undefined) return { ok: false, errors: ["Map a quantity column."] };
  if (mapping.partNumber === undefined && mapping.barcode === undefined && mapping.name === undefined) {
    return { ok: false, errors: ["Map a part number, barcode, or name column."] };
  }
  return { ok: true };
}
~~~

- [ ] **Step 4: Run the focused test**

Run: npx vitest run src/services/columnIntelligence.test.ts

Expected: PASS, 3 tests. Nonsense headers stay low confidence and require Task 9.

---


## Task 4: Add the net-new lazy ExcelJS reader and sanitize every cell

**Stage:** A

**Files:**

- Create: src/services/universalFileReader.ts
- Test: src/services/universalFileReader.test.ts

**Interfaces:**

- Consumes: UploadFileLike, UniversalSheet, buildSourceSignature, inferColumnMapping, sanitizeCell, csv-parse/sync parse, and ExcelJS 4.4.0 Workbook.xlsx.load(data).
- Produces: readUniversalFile(file: UploadFileLike): Promise<UniversalSheet>. It accepts CSV, TSV, XLSX, and OOXML bytes named .xls. True BIFF throws the exact binding error.

- [ ] **Step 1: Write the complete failing test**

~~~typescript
// src/services/universalFileReader.test.ts
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readUniversalFile } from "@/services/universalFileReader";

function textFile(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return { name, text: async () => text, arrayBuffer: async () => bytes.buffer };
}

describe("readUniversalFile", () => {
  it("reads CSV and sanitizes all cells", async () => {
    const sheet = await readUniversalFile(textFile("boss.csv", "PN,Make,QOH\nABC-1,=2+2,3\n"));
    expect(sheet.headers).toEqual(["PN", "Make", "QOH"]);
    expect(sheet.rows).toEqual([["ABC-1", "'=2+2", "3"]]);
  });

  it("reads XLSX through the net-new lazy path", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Inventory");
    worksheet.addRow(["PN", "Make", "QOH"]);
    worksheet.addRow(["ABC-1", "@brand", 4]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const sheet = await readUniversalFile({
      name: "boss.xlsx",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    expect(sheet.rows[0]).toEqual(["ABC-1", "'@brand", "4"]);
  });

  it("accepts OOXML bytes named .xls", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Inventory").addRow(["PN", "QOH"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(readUniversalFile({
      name: "renamed.xls",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })).resolves.toMatchObject({ kind: "xls" });
  });

  it("rejects true BIFF with exact actionable copy", async () => {
    const bytes = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(readUniversalFile({
      name: "legacy.xls",
      text: async () => "",
      arrayBuffer: async () => bytes.buffer,
    })).rejects.toThrow(
      "Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.",
    );
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/services/universalFileReader.test.ts

Expected: FAIL with Cannot find module '@/services/universalFileReader'.

- [ ] **Step 3: Create the complete reader**

~~~typescript
// src/services/universalFileReader.ts
import { parse } from "csv-parse/sync";
import { inferColumnMapping } from "@/services/columnIntelligence";
import { sanitizeCell } from "@/services/csvImport";
import { buildSourceSignature, type UploadFileLike, type UploadKind, type UniversalSheet } from "@/services/importSchema";

function extension(name: string): UploadKind {
  const value = name.toLowerCase();
  if (value.endsWith(".csv")) return "csv";
  if (value.endsWith(".tsv")) return "tsv";
  if (value.endsWith(".xlsx")) return "xlsx";
  if (value.endsWith(".xls")) return "xls";
  throw new Error("Upload a CSV, TSV, XLSX, or XLS file.");
}

function cleanMatrix(matrix: unknown[][]): string[][] {
  return matrix.map((row) => row.map((cell) => sanitizeCell(String(cell ?? ""))));
}

function delimitedMatrix(text: string, kind: "csv" | "tsv"): string[][] {
  return cleanMatrix(parse(text, {
    delimiter: kind === "tsv" ? "\t" : ",",
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  }) as unknown[][]);
}

function isOleBiff(bytes: Uint8Array): boolean {
  return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    .every((value, index) => bytes[index] === value);
}

async function workbookMatrix(file: UploadFileLike): Promise<string[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isOleBiff(bytes)) {
    throw new Error(
      "Legacy binary .xls is not supported by installed ExcelJS 4.4.0. Save it as .xlsx or .csv.",
    );
  }
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];
  const matrix: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    matrix.push(row.values.slice(1) as unknown[]);
  });
  return cleanMatrix(matrix);
}

function hasData(row: string[]): boolean {
  return row.some((cell) => cell !== "");
}

export async function readUniversalFile(file: UploadFileLike): Promise<UniversalSheet> {
  const kind = extension(file.name);
  const matrix = kind === "csv" || kind === "tsv"
    ? delimitedMatrix(await file.text(), kind)
    : await workbookMatrix(file);
  if (!matrix.some(hasData)) throw new Error("The uploaded file is empty.");
  const inference = inferColumnMapping(matrix);
  return {
    fileName: file.name,
    kind,
    headers: inference.headers,
    rows: matrix.slice(inference.headerRowIndex + 1).filter(hasData),
    headerRowIndex: inference.headerRowIndex,
    sourceSignature: buildSourceSignature(inference.headers),
    seenRows: matrix.slice(0, Math.min(matrix.length, 21)),
  };
}
~~~

- [ ] **Step 4: Run focused and sanitizer tests**

Run: npx vitest run src/services/universalFileReader.test.ts src/services/csvImport.trustGate.test.ts

Expected: PASS. Every header and cell follows stripControlChars, cap 500, and defuseFormulaInjection.

---


## Task 5: Persist per-account mapping memory behind LadderStorage KV

**Stage:** A

**Parallel boundary:** Run after Task 4 in parallel with Tasks 7 through 10. It alone owns the server persistence seam.

**Files:**

- Create: src/server/importMappingMemory.ts
- Test: src/server/importMappingMemory.test.ts

**Interfaces:**

- Consumes: LadderStorage.get(key: string): Promise<string | null>, LadderStorage.set(key: string, value: string): Promise<void>, ladderStorage(dir?: string): Promise<LadderStorage>, and ColumnMapping.
- Produces: mappingMemoryKey(businessId: string, sourceSignature: string): string, readImportMapping(businessId: string, sourceSignature: string, storage?: LadderStorage): Promise<ColumnMapping | null>, and writeImportMapping(businessId: string, sourceSignature: string, mapping: ColumnMapping, storage?: LadderStorage): Promise<void>.

- [ ] **Step 1: Write the complete failing test**

~~~typescript
// src/server/importMappingMemory.test.ts
import { describe, expect, it, vi } from "vitest";
import type { LadderStorage } from "@/server/upc/storage";
import { mappingMemoryKey, readImportMapping, writeImportMapping } from "@/server/importMappingMemory";

function storage(): LadderStorage {
  const values = new Map<string, string>();
  return {
    get: vi.fn(async (key) => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
  } as unknown as LadderStorage;
}

describe("importMappingMemory", () => {
  it("namespaces by account and source signature", () => {
    expect(mappingMemoryKey("biz-a", "source-1")).toBe("import_mapping::biz-a::source-1");
  });

  it("round-trips a mapping", async () => {
    const kv = storage();
    await writeImportMapping("biz-a", "source-1", { partNumber: 0, quantity: 4 }, kv);
    await expect(readImportMapping("biz-a", "source-1", kv)).resolves.toEqual({
      partNumber: 0,
      quantity: 4,
    });
  });

  it("returns null for corrupt or other-tenant data", async () => {
    const kv = storage();
    await kv.set(mappingMemoryKey("biz-a", "source-1"), "{bad");
    await expect(readImportMapping("biz-a", "source-1", kv)).resolves.toBeNull();
    await expect(readImportMapping("biz-b", "source-1", kv)).resolves.toBeNull();
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/server/importMappingMemory.test.ts

Expected: FAIL with Cannot find module '@/server/importMappingMemory'.

- [ ] **Step 3: Create the complete persistence seam**

~~~typescript
// src/server/importMappingMemory.ts
import "server-only";

import type { ColumnMapping } from "@/services/importSchema";
import { ladderStorage, type LadderStorage } from "@/server/upc/storage";

function segment(value: string, field: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 200 || /[:\u0000-\u001f]/.test(clean)) {
    throw new Error("Invalid " + field + ".");
  }
  return clean;
}

export function mappingMemoryKey(businessId: string, sourceSignature: string): string {
  return "import_mapping::" + segment(businessId, "businessId") + "::" + segment(sourceSignature, "sourceSignature");
}

function isMapping(value: unknown): value is ColumnMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((index) => Number.isInteger(index) && Number(index) >= 0);
}

export async function readImportMapping(
  businessId: string,
  sourceSignature: string,
  storage?: LadderStorage,
): Promise<ColumnMapping | null> {
  const kv = storage ?? await ladderStorage();
  const raw = await kv.get(mappingMemoryKey(businessId, sourceSignature));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isMapping(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeImportMapping(
  businessId: string,
  sourceSignature: string,
  mapping: ColumnMapping,
  storage?: LadderStorage,
): Promise<void> {
  if (!isMapping(mapping)) throw new Error("Invalid column mapping.");
  const kv = storage ?? await ladderStorage();
  await kv.set(mappingMemoryKey(businessId, sourceSignature), JSON.stringify(mapping));
}
~~~

- [ ] **Step 4: Run the focused test**

Run: npx vitest run src/server/importMappingMemory.test.ts

Expected: PASS, 3 tests. Turso is selected in configured live mode; file KV works in mock. localStorage and Firestore are not used.

---


## Task 6: Expose authenticated mapping reads and delayed writes

**Stage:** A

**Depends on:** Task 5.

**Files:**

- Create: src/app/api/import-mapping/route.ts
- Test: src/app/api/import-mapping/route.test.ts

**Interfaces:**

- Consumes: readImportMapping, writeImportMapping, isLiveAuth(): boolean, getAdminAuth().verifyIdToken(idToken), getAdminDb().doc(path).get(), COLLECTIONS.businessMembers, and memberDocId(businessId: string, uid: string): string.
- Produces: GET /api/import-mapping and PUT /api/import-mapping. GET never writes. Task 9 calls PUT only after Apply.

- [ ] **Step 1: Write the complete failing route test**

~~~typescript
// src/app/api/import-mapping/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readImportMapping, writeImportMapping } = vi.hoisted(() => ({
  readImportMapping: vi.fn(),
  writeImportMapping: vi.fn(),
}));

vi.mock("@/server/importMappingMemory", () => ({ readImportMapping, writeImportMapping }));
vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => false }));

import { GET, PUT } from "@/app/api/import-mapping/route";

describe("/api/import-mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readImportMapping.mockResolvedValue({ partNumber: 0, quantity: 1 });
  });

  it("GET is read-only", async () => {
    const response = await GET(new Request(
      "http://localhost/api/import-mapping?businessId=demo-business&sourceSignature=source-1",
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mapping: { partNumber: 0, quantity: 1 } });
    expect(writeImportMapping).not.toHaveBeenCalled();
  });

  it("PUT writes one scoped mapping", async () => {
    const response = await PUT(new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      body: JSON.stringify({
        businessId: "demo-business",
        sourceSignature: "source-1",
        mapping: { partNumber: 0, quantity: 1 },
      }),
    }));
    expect(response.status).toBe(200);
    expect(writeImportMapping).toHaveBeenCalledWith(
      "demo-business",
      "source-1",
      { partNumber: 0, quantity: 1 },
    );
  });

  it("rejects more than 32KB", async () => {
    const response = await PUT(new Request("http://localhost/api/import-mapping", {
      method: "PUT",
      body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
    }));
    expect(response.status).toBe(413);
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/app/api/import-mapping/route.test.ts

Expected: FAIL with Cannot find module '@/app/api/import-mapping/route'.

- [ ] **Step 3: Create the complete route**

~~~typescript
// src/app/api/import-mapping/route.ts
import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { readImportMapping, writeImportMapping } from "@/server/importMappingMemory";
import { isLiveAuth } from "@/services/auth/authMode";
import { COLLECTIONS, memberDocId } from "@/services/db/types";
import type { ColumnMapping } from "@/services/importSchema";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 32 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorize(request: Request, businessId: string): Promise<NextResponse | null> {
  if (process.env.IS_E2E === "1" || !isLiveAuth()) return null;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return json({ error: "Sign in required." }, 401);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    const member = await getAdminDb()
      .doc(COLLECTIONS.businessMembers + "/" + memberDocId(businessId, decoded.uid))
      .get();
    return member.exists ? null : json({ error: "Not a member of this business." }, 403);
  } catch {
    return json({ error: "Could not verify business membership." }, 503);
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId")?.trim() ?? "";
  const sourceSignature = url.searchParams.get("sourceSignature")?.trim() ?? "";
  if (!businessId || !sourceSignature) return json({ error: "Missing mapping key." }, 400);
  const denied = await authorize(request, businessId);
  if (denied) return denied;
  return json({ mapping: await readImportMapping(businessId, sourceSignature) });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return json({ error: "Mapping body must be 32KB or smaller." }, 413);
  }
  let body: { businessId?: unknown; sourceSignature?: unknown; mapping?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const businessId = typeof body.businessId === "string" ? body.businessId.trim() : "";
  const sourceSignature = typeof body.sourceSignature === "string" ? body.sourceSignature.trim() : "";
  const mapping = body.mapping as ColumnMapping;
  if (!businessId || !sourceSignature || !mapping || typeof mapping !== "object") {
    return json({ error: "Missing mapping data." }, 400);
  }
  const denied = await authorize(request, businessId);
  if (denied) return denied;
  await writeImportMapping(businessId, sourceSignature, mapping);
  return json({ ok: true });
}
~~~

- [ ] **Step 4: Run route and seam tests**

Run: npx vitest run src/app/api/import-mapping/route.test.ts src/server/importMappingMemory.test.ts

Expected: PASS. GET is read-only, PUT is scoped, and live mode verifies membership.

---


## Task 7: Map rows, expose matcher confidence, and construct the read-only preview

**Stage:** A

**Files:**

- Create: src/services/universalImportPreview.ts
- Test: src/services/universalImportPreview.test.ts
- Modify: src/services/reconcile/types.ts
- Modify: src/services/catalog/identityMerge.ts
- Modify: src/services/reconcile/identityMatcher.ts
- Test: src/services/reconcile/identityMatcher.test.ts

**Interfaces:**

- Consumes: UniversalSheet, ColumnMapping, MappingSource, MatchResult, ExpectedInventoryRow, and CorpusCandidate.
- Produces: MappingResult, PreviewMatchResult, mapUniversalRows(sheet: UniversalSheet, mapping: ColumnMapping): MappingResult, buildImportPreview(mapped: MappingResult, matches: PreviewMatchResult[], mappingSource: MappingSource): ImportPreview, IDENTITY_JACCARD_THRESHOLD = 0.75, MatchResult.confidence?, and MatchResult.matchBasis?.

- [ ] **Step 1: Write the complete failing preview test**

~~~typescript
// src/services/universalImportPreview.test.ts
import { describe, expect, it } from "vitest";
import type { UniversalSheet } from "@/services/importSchema";
import { buildImportPreview, mapUniversalRows, type PreviewMatchResult } from "@/services/universalImportPreview";

const sheet: UniversalSheet = {
  fileName: "boss.csv",
  kind: "csv",
  headers: ["PN", "Make", "Model", "Tire Size", "QOH", "Cost"],
  rows: [
    ["ABC-1", "Acme", "Road", "225/45R18", "7", "99"],
    ["ABC-2", "Acme", "Road Plus", "225/45R18", "2", "88"],
    ["ABC-3", "Acme", "Road", "225/45R18", "bad", "77"],
  ],
  headerRowIndex: 0,
  sourceSignature: "source-1",
  seenRows: [],
};

describe("universalImportPreview", () => {
  it("maps rows, drops cost, and rejects invalid quantity", () => {
    const result = mapUniversalRows(sheet, { partNumber: 0, brand: 1, model: 2, size: 3, quantity: 4 });
    expect(result.rows).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rows[0].expected.raw.cost).toBeUndefined();
  });

  it("classifies exact, fuzzy, and rejected rows honestly", () => {
    const mapped = mapUniversalRows(sheet, { partNumber: 0, brand: 1, model: 2, size: 3, quantity: 4 });
    const matches: PreviewMatchResult[] = [
      {
        row: mapped.rows[0].expected,
        status: "matched",
        reason: "Part number hit.",
        confidence: 1,
        matchBasis: "part_number_exact",
        candidate: { uid: "one", brand: "Acme", name: "Road" },
      },
      {
        row: mapped.rows[1].expected,
        status: "matched",
        reason: "Identity similarity.",
        confidence: 0.75,
        matchBasis: "identity_jaccard",
        candidate: { uid: "two", brand: "Acme", name: "Road Plus" },
      },
    ];
    const preview = buildImportPreview(mapped, matches, "header");
    expect(preview).toMatchObject({ total: 3, exact: 1, fuzzy: 1, review: 0, reject: 1 });
    expect(preview.headline).toBe("Matched 1 of 3 automatically");
  });

  it("routes ambiguity to review", () => {
    const mapped = mapUniversalRows({ ...sheet, rows: [sheet.rows[0]] }, {
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
    });
    const preview = buildImportPreview(mapped, [{
      row: mapped.rows[0].expected,
      status: "ambiguous",
      reason: "Two candidates.",
      candidates: [
        { uid: "a", brand: "Acme", name: "Road" },
        { uid: "b", brand: "Acme", name: "Road" },
      ],
    }], "header");
    expect(preview.rows[0].status).toBe("review");
  });
});
~~~

- [ ] **Step 2: Run tests and verify the expected failures**

Run: npx vitest run src/services/universalImportPreview.test.ts src/services/reconcile/identityMatcher.test.ts

Expected: FAIL because the preview module and matcher metadata do not exist.

- [ ] **Step 3: Apply the complete type and threshold patch**

~~~diff
*** Begin Patch
*** Update File: src/services/reconcile/types.ts
@@
   specs?: string;
+  barcode?: string;
+  name?: string;
+  category?: string;
*** Update File: src/services/catalog/identityMerge.ts
@@
 export function jaccard(a: string[], b: string[]): number {
@@
 }
+
+export const IDENTITY_JACCARD_THRESHOLD = 0.75;
@@
-      if (sim >= 0.75 || plusDiff) {
+      if (sim >= IDENTITY_JACCARD_THRESHOLD || plusDiff) {
*** Update File: src/services/reconcile/identityMatcher.ts
@@
-import { nameTokens, jaccard, plusGenerationDiff } from "@/services/catalog/identityMerge";
+import {
+  IDENTITY_JACCARD_THRESHOLD,
+  nameTokens,
+  jaccard,
+  plusGenerationDiff,
+} from "@/services/catalog/identityMerge";
@@
 export interface MatchResult {
@@
   reason: string;
+  confidence?: number;
+  matchBasis?: "part_number_exact" | "part_number_affix_core" | "identity_jaccard";
@@
-const JACCARD_THRESHOLD = 0.75;
@@
       return {
         row,
         status: "matched",
+        confidence: 1,
+        matchBasis: viaAffixCore ? "part_number_affix_core" : "part_number_exact",
@@
-      if (sim < JACCARD_THRESHOLD) continue;
+      if (sim < IDENTITY_JACCARD_THRESHOLD) continue;
@@
       return {
         row,
         status: "matched",
+        confidence: jaccard(rowTokens, nameTokens(cand.name)),
+        matchBasis: "identity_jaccard",
*** Update File: src/services/reconcile/identityMatcher.test.ts
@@
+import { IDENTITY_JACCARD_THRESHOLD } from "@/services/catalog/identityMerge";
@@
 describe("matchExpectedRow", () => {
+  it("reports exact confidence and the canonical threshold", () => {
+    expect(IDENTITY_JACCARD_THRESHOLD).toBe(0.75);
+    const result = matchExpectedRow(row({
+      partNumbers: ["ABC-1"],
+      brand: "Acme",
+      sizeText: "225/45R18",
+    }), {
+      lookupByPartNumber: () => [
+        { uid: "one", brand: "Acme", name: "Road", sizeToken: "225/45R18" },
+      ],
+      candidatesByBrandSize: () => [],
+    });
+    expect(result.confidence).toBe(1);
+    expect(result.matchBasis).toBe("part_number_exact");
+  });
*** End Patch
~~~

- [ ] **Step 4: Create the complete preview module**

~~~typescript
// src/services/universalImportPreview.ts
import type {
  ColumnMapping,
  ImportPreview,
  ImportPreviewRow,
  ImportPreviewStatus,
  MappedImportRow,
  MappingSource,
  RetailCatalogMatch,
  UniversalSheet,
} from "@/services/importSchema";
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

export function mapUniversalRows(sheet: UniversalSheet, mapping: ColumnMapping): MappingResult {
  const rows: MappedImportRow[] = [];
  const heldForReview: ImportPreviewRow[] = [];
  const rejected: ImportPreviewRow[] = [];

  sheet.rows.forEach((sourceCells, rowIndex) => {
    const line = sheet.headerRowIndex + rowIndex + 2;
    const quantityText = cell(sourceCells, mapping, "quantity");
    const quantity = Number(quantityText);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      rejected.push({
        source: null,
        line,
        status: "reject",
        reason: "Quantity " + JSON.stringify(quantityText) + " is not a non-negative whole number.",
        confidence: null,
      });
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
      rejected.push({
        source: null,
        line,
        status: "reject",
        reason: "No part number, barcode, or name was found on this row.",
        confidence: null,
      });
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
        specs: base.name || [base.brand, base.model, base.size].filter(Boolean).join(" "),
        barcode: base.barcode || undefined,
        name: base.name || undefined,
        category: base.category || undefined,
        qty: quantity,
        raw,
      },
    };
    if (mapped.uom && mapped.uom.toLowerCase() !== "each") {
      heldForReview.push({
        source: mapped,
        line,
        status: "review",
        reason: "Unit " + JSON.stringify(mapped.uom) + " requires review; only each is automatic.",
        confidence: null,
      });
      return;
    }
    rows.push(mapped);
  });

  return { rows, heldForReview, rejected };
}

function statusForMatch(match: PreviewMatchResult, source: MappingSource): ImportPreviewStatus {
  if (match.status === "ambiguous") return "review";
  if (match.status === "matched") return match.matchBasis === "part_number_exact" ? "exact" : "fuzzy";
  if (match.status === "non_tire" && match.retailCatalogMatch) return "exact";
  return source === "content" ? "review" : "exact";
}

export function buildImportPreview(
  mapped: MappingResult,
  matches: PreviewMatchResult[],
  mappingSource: MappingSource,
): ImportPreview {
  if (matches.length !== mapped.rows.length) {
    throw new Error("Matcher returned " + matches.length + " results for " + mapped.rows.length + " rows.");
  }
  const matched = mapped.rows.map((source, index): ImportPreviewRow => {
    const match = matches[index];
    const status = statusForMatch(match, mappingSource);
    return {
      source,
      line: source.line,
      status,
      reason: match.retailCatalogMatch
        ? "Identified from the retail catalog: " + match.retailCatalogMatch.productName
        : match.reason,
      confidence: match.confidence ?? (status === "exact" ? 1 : null),
      candidate: match.candidate,
      retailCatalogMatch: match.retailCatalogMatch,
    };
  });
  const rows = [...matched, ...mapped.heldForReview, ...mapped.rejected]
    .sort((left, right) => left.line - right.line);
  const count = (status: ImportPreviewStatus) => rows.filter((row) => row.status === status).length;
  const exact = count("exact");
  return {
    rows,
    total: rows.length,
    exact,
    fuzzy: count("fuzzy"),
    review: count("review"),
    reject: count("reject"),
    headline: "Matched " + exact + " of " + rows.length + " automatically",
  };
}
~~~

- [ ] **Step 5: Run focused tests**

Run: npx vitest run src/services/universalImportPreview.test.ts src/services/reconcile/identityMatcher.test.ts

Expected: PASS. Exact PN is automatic. Jaccard, affix-core, and ambiguity are review paths.

---


## Task 8: Enrich non-tire rows with exact retail-corpus evidence

**Stage:** A

**Parallel boundary:** Run after Task 7. This task alone owns the reconcile route in Stage A.

**Files:**

- Modify: src/app/api/reconcile/match/route.ts
- Create: src/app/api/reconcile/match/universalImportRetail.test.ts

**Interfaces:**

- Consumes: ExpectedInventoryRow.barcode?: string, matchExpectedRow(row: ExpectedInventoryRow, deps: MatcherDeps): MatchResult, and lookupRetailBarcodeAsync(code: string): Promise<RetailLookupResult | null>.
- Produces: route results may carry retailCatalogMatch: { productName: string; brand: string; category: string; barcode: string }. The route never reads getLastRetailLookupStatus(), avoiding its module-level race.

- [ ] **Step 1: Write the complete failing route test**

~~~typescript
// src/app/api/reconcile/match/universalImportRetail.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupRetailBarcodeAsync, lookupAllByPartNumber, candidatesBySizeToken } = vi.hoisted(() => ({
  lookupRetailBarcodeAsync: vi.fn(),
  lookupAllByPartNumber: vi.fn(async () => []),
  candidatesBySizeToken: vi.fn(async () => []),
}));

vi.mock("@/server/retail-knowledge/retailKnowledgeIndex", () => ({
  lookupRetailBarcodeAsync,
}));
vi.mock("@/server/tire-knowledge/tireKnowledgeIndex", () => ({
  lookupAllByPartNumber,
  candidatesBySizeToken,
}));

import { POST } from "@/app/api/reconcile/match/route";

describe("reconcile retail enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookupRetailBarcodeAsync.mockResolvedValue({
      productName: "Denso Spark Plug",
      brand: "Denso",
      category: "Parts",
      barcode: "012345678905",
    });
  });

  it("adds exact retail evidence to a non-tire row", async () => {
    const response = await POST(new Request("http://localhost/api/reconcile/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: [{
          externalId: "012345678905",
          partNumbers: [],
          barcode: "012345678905",
          name: "Spark Plug",
          category: "Parts",
          qty: 2,
          raw: {},
        }],
      }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.matches[0]).toMatchObject({
      status: "non_tire",
      retailCatalogMatch: {
        productName: "Denso Spark Plug",
        brand: "Denso",
        category: "Parts",
        barcode: "012345678905",
      },
    });
    expect(lookupRetailBarcodeAsync).toHaveBeenCalledWith("012345678905");
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/app/api/reconcile/match/universalImportRetail.test.ts

Expected: FAIL because non-tire results do not yet include retailCatalogMatch.

- [ ] **Step 3: Apply the complete route patch**

~~~diff
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
~~~

- [ ] **Step 4: Run focused and existing route tests**

Run: npx vitest run src/app/api/reconcile/match/universalImportRetail.test.ts src/app/api/reconcile/match/route.test.ts

Expected: PASS. Exact retail barcode evidence is positive non-tire corroboration; no alias or store write occurs.

---

## Task 9: Build the mapping and preview UI with delayed Apply

**Stage:** A

**Parallel boundary:** Run after Tasks 6 through 8. It owns only the new panel and its test.

**Files:**

- Create: src/components/UniversalImportPanel.tsx
- Test: src/components/UniversalImportPanel.test.tsx

**Interfaces:**

- Consumes: readUniversalFile(file: UploadFileLike): Promise<UniversalSheet>, inferColumnMapping(matrix: string[][]): ColumnInference, validateManualMapping(headers: string[], mapping: ColumnMapping), mapUniversalRows, buildImportPreview, loadMapping(sourceSignature: string): Promise<ColumnMapping | null>, saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void>, matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]>, and onApply(rows: ImportPreviewRow[]): Promise<UniversalImportApplySummary>.
- Produces: UniversalImportPanel(props: UniversalImportPanelProps): JSX.Element. Preview stays in component state. saveMapping and onApply cannot run until Apply.

- [ ] **Step 1: Write the complete failing component test**

~~~tsx
// src/components/UniversalImportPanel.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UniversalImportPanel } from "@/components/UniversalImportPanel";

describe("UniversalImportPanel", () => {
  it("shows a preview without writes, then applies and remembers", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => ({ applied: 1, queuedForReview: 0, rejected: 0 }));
    const saveMapping = vi.fn(async () => undefined);
    render(
      <UniversalImportPanel
        loadMapping={vi.fn(async () => null)}
        saveMapping={saveMapping}
        matchRows={vi.fn(async (rows) => rows.map((row) => ({
          row: row.expected,
          status: "matched" as const,
          reason: "Part number hit.",
          confidence: 1,
          matchBasis: "part_number_exact" as const,
          candidate: { uid: "one", brand: "Acme", name: "Road" },
        })))}
        onApply={onApply}
      />,
    );

    await user.upload(
      screen.getByTestId("universal-import-file"),
      new File(["PN,Make,Model,Tire Size,QOH\nABC-1,Acme,Road,225/45R18,3\n"], "boss.csv", {
        type: "text/csv",
      }),
    );
    await screen.findByText("Matched 1 of 1 automatically");
    expect(onApply).not.toHaveBeenCalled();
    expect(saveMapping).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("import-apply"));
    await screen.findByText("Applied 1. Needs Review 0. Rejected 0.");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(saveMapping).toHaveBeenCalledTimes(1);
  });

  it("shows manual selectors for nonsense headers", async () => {
    const user = userEvent.setup();
    render(
      <UniversalImportPanel
        loadMapping={vi.fn(async () => null)}
        saveMapping={vi.fn(async () => undefined)}
        matchRows={vi.fn(async () => [])}
        onApply={vi.fn(async () => ({ applied: 0, queuedForReview: 0, rejected: 0 }))}
      />,
    );
    await user.upload(
      screen.getByTestId("universal-import-file"),
      new File(["aaa,bbb,ccc\nABC-1,4,Acme\n"], "unknown.csv", { type: "text/csv" }),
    );
    expect(await screen.findByTestId("column-mapping")).toBeVisible();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npx vitest run src/components/UniversalImportPanel.test.tsx

Expected: FAIL with Cannot find module '@/components/UniversalImportPanel'.

- [ ] **Step 3: Create the complete panel**

~~~tsx
// src/components/UniversalImportPanel.tsx
"use client";

import { useState } from "react";
import { inferColumnMapping, validateManualMapping } from "@/services/columnIntelligence";
import {
  IMPORT_FIELD_ORDER,
  type ColumnMapping,
  type ImportPreview,
  type ImportPreviewRow,
  type MappedImportRow,
  type MappingSource,
  type UniversalImportApplySummary,
  type UniversalSheet,
} from "@/services/importSchema";
import {
  buildImportPreview,
  mapUniversalRows,
  type PreviewMatchResult,
} from "@/services/universalImportPreview";
import { readUniversalFile } from "@/services/universalFileReader";

export interface UniversalImportPanelProps {
  loadMapping(sourceSignature: string): Promise<ColumnMapping | null>;
  saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void>;
  matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]>;
  onApply(rows: ImportPreviewRow[]): Promise<UniversalImportApplySummary>;
}

export function UniversalImportPanel(props: UniversalImportPanelProps) {
  const [sheet, setSheet] = useState<UniversalSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [manual, setManual] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [summary, setSummary] = useState<UniversalImportApplySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function previewRows(
    nextSheet: UniversalSheet,
    nextMapping: ColumnMapping,
    source: MappingSource,
  ): Promise<void> {
    const valid = validateManualMapping(nextSheet.headers, nextMapping);
    if (!valid.ok) {
      setError(valid.errors.join(" "));
      return;
    }
    const mapped = mapUniversalRows(nextSheet, nextMapping);
    const matches = await props.matchRows(mapped.rows);
    setPreview(buildImportPreview(mapped, matches, source));
    setError("");
  }

  async function chooseFile(file: File): Promise<void> {
    setBusy(true);
    setError("");
    setPreview(null);
    setSummary(null);
    try {
      const nextSheet = await readUniversalFile(file);
      const inferred = inferColumnMapping([nextSheet.headers, ...nextSheet.rows]);
      const remembered = await props.loadMapping(nextSheet.sourceSignature);
      const nextMapping = remembered ?? inferred.mapping;
      const source: MappingSource = remembered ? "remembered" : inferred.source;
      setSheet(nextSheet);
      setMapping(nextMapping);
      setManual(!remembered && inferred.confidence === "low");
      if (remembered || inferred.confidence === "high") {
        await previewRows(nextSheet, nextMapping, source);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the file.");
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    if (!sheet || !preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await props.onApply(preview.rows);
      await props.saveMapping(sheet.sourceSignature, mapping);
      setSummary(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not apply the import.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4" data-testid="universal-import-panel">
      <div>
        <h2 className="text-lg font-semibold">Universal inventory import</h2>
        <p className="text-sm text-zinc-600">Upload, verify the preview, then apply.</p>
      </div>

      <input
        data-testid="universal-import-file"
        type="file"
        accept=".csv,.tsv,.xlsx,.xls"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void chooseFile(file);
        }}
      />

      {manual && sheet && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="column-mapping">
          {IMPORT_FIELD_ORDER.map((field) => (
            <label key={field} className="grid gap-1 text-sm">
              <span>{field}</span>
              <select
                value={mapping[field] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setMapping((current) => ({
                    ...current,
                    [field]: value === "" ? undefined : Number(value),
                  }));
                }}
              >
                <option value="">Not mapped</option>
                {sheet.headers.map((header, index) => (
                  <option key={header + index} value={index}>{header || "Column " + (index + 1)}</option>
                ))}
              </select>
            </label>
          ))}
          <button
            type="button"
            className="min-h-[44px] rounded-lg bg-zinc-900 px-4 text-white"
            onClick={() => void previewRows(sheet, mapping, "manual")}
          >
            Preview mapped rows
          </button>
        </div>
      )}

      {preview && (
        <div className="space-y-3" data-testid="import-preview">
          <div className="rounded-lg bg-blue-50 p-3">
            <p className="font-semibold" data-testid="import-headline">{preview.headline}</p>
            <p className="text-sm">
              Exact {preview.exact}. Fuzzy {preview.fuzzy}. Needs Review {preview.review}. Rejected {preview.reject}.
            </p>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead><tr><th>Line</th><th>Status</th><th>Reason</th><th>Qty</th></tr></thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.line} className="border-t">
                    <td>{row.line}</td>
                    <td>{row.status}</td>
                    <td>{row.reason}</td>
                    <td>{row.source?.quantity ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!summary && (
            <button
              type="button"
              data-testid="import-apply"
              disabled={busy}
              onClick={() => void apply()}
              className="min-h-[44px] rounded-lg bg-blue-600 px-4 text-white disabled:opacity-50"
            >
              Apply {preview.total} rows
            </button>
          )}
        </div>
      )}

      {summary && (
        <p className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm" data-testid="import-summary">
          Applied {summary.applied}. Needs Review {summary.queuedForReview}. Rejected {summary.rejected}.
        </p>
      )}
      {error && <p className="text-sm text-red-700" data-testid="import-error">{error}</p>}
      {busy && <p className="text-sm text-zinc-600">Working...</p>}
    </section>
  );
}
~~~

- [ ] **Step 4: Run the component test**

Run: npx vitest run src/components/UniversalImportPanel.test.tsx

Expected: PASS, 2 tests. Before Apply, onApply and saveMapping each have zero calls. Nonsense headers display explicit selectors.

---






## Task 10: Unify all three import paths and pin Stage A performance

**Stage:** A

**Parallel boundary:** Run after Tasks 1 through 4 and 7, in parallel with Tasks 5, 6, 8, and 9. This task alone owns legacy adapters and import service fixtures.

**Design ruling encoded:** Delete the D9 four-string list. All three import paths consume shared column intelligence. Time read, inference, row mapping, matcher-result shaping, and preview for 5,000 rows.

**Files:**

- Modify: src/services/columnIntelligence.ts
- Modify: src/services/csvImport.ts
- Modify: src/services/reconcile/shopwareCsvAdapter.ts
- Test: src/services/csvImport.test.ts
- Test: src/services/reconcile/shopwareCsvAdapter.test.ts
- Create: src/services/fixtures/import/shopware.csv
- Create: src/services/fixtures/import/reordered-renamed.tsv
- Create: src/services/fixtures/import/nonsense-headers.csv
- Create: src/services/fixtures/import/missing-columns.csv
- Create: src/services/fixtures/import/unit-rows.csv
- Create: src/services/universalImport.stageA.test.ts
- Create: src/services/universalImport.performance.test.ts

**Interfaces:**

- Consumes: HEADER_SYNONYMS, normalizeImportHeader, sanitizeCell, readUniversalFile, inferColumnMapping, mapUniversalRows, and buildImportPreview.
- Produces: importFieldForHeader(value: string): ImportField | undefined, pickImportedField(row: Record<string, string>, field: ImportField): string, a Shop-Ware adapter without SHOPWARE_COLUMN_MAP.partNumber, and the 10-second guard.

- [ ] **Step 1: Create the complete fixtures**

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

~~~csv
# src/services/fixtures/import/missing-columns.csv
Make,Model,QOH
Acme,Road,2
~~~

~~~csv
# src/services/fixtures/import/unit-rows.csv
PN,Make,Model,QOH,UOM
BOX-1,Acme,Fastener,2,box
~~~

- [ ] **Step 2: Write the complete performance test**

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
    const startedAt = performance.now();
    const sheet = await readUniversalFile({
      name: "five-thousand.csv",
      type: "text/csv",
      text: async () => csv,
      arrayBuffer: async () => new TextEncoder().encode(csv).buffer,
    });
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    const mapped = mapUniversalRows(sheet, inferred.mapping);
    const matches: PreviewMatchResult[] = mapped.rows.map((row) => ({
      row: row.expected,
      status: "matched",
      reason: "Part number hit.",
      confidence: 1,
      matchBasis: "part_number_exact",
      candidate: { uid: "candidate-" + row.line, brand: row.brand, name: row.model },
    }));
    const preview = buildImportPreview(mapped, matches, inferred.source);
    expect(preview.total).toBe(5_000);
    expect(preview.exact).toBe(5_000);
    expect(preview.headline).toBe("Matched 5000 of 5000 automatically");
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  }, 12_000);
});
~~~

~~~typescript
// src/services/universalImport.stageA.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferColumnMapping } from "@/services/columnIntelligence";
import type { ColumnMapping, UniversalSheet } from "@/services/importSchema";
import {
  buildImportPreview,
  mapUniversalRows,
  type PreviewMatchResult,
} from "@/services/universalImportPreview";
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

function exactPreview(sheet: UniversalSheet, mapping: ColumnMapping) {
  const mapped = mapUniversalRows(sheet, mapping);
  const matches: PreviewMatchResult[] = mapped.rows.map((row) => ({
    row: row.expected,
    status: "matched",
    reason: "Part number hit.",
    confidence: 1,
    matchBasis: "part_number_exact",
    candidate: { uid: "candidate-" + row.line, brand: row.brand, name: row.model },
  }));
  return buildImportPreview(mapped, matches, "header");
}

describe("Stage A adapter fixtures", () => {
  it("maps Shop-Ware PN, Make, Model, Tire Size, QOH, and UOM", async () => {
    const sheet = await readUniversalFile(fixture("shopware.csv", "text/csv"));
    const mapping = inferColumnMapping([sheet.headers, ...sheet.rows]).mapping;
    expect(mapping).toMatchObject({
      partNumber: 0,
      brand: 1,
      model: 2,
      size: 3,
      quantity: 4,
      uom: 5,
    });
    expect(sheet.rows[2][1]).toBe("'=Formula Brand");
    expect(exactPreview(sheet, mapping)).toMatchObject({ exact: 3, review: 0, reject: 0 });
  });

  it("maps reordered TSV and ignores the extra column", async () => {
    const sheet = await readUniversalFile(fixture("reordered-renamed.tsv", "text/tab-separated-values"));
    const mapping = inferColumnMapping([sheet.headers, ...sheet.rows]).mapping;
    expect(mapping).toMatchObject({
      quantity: 1,
      size: 2,
      model: 3,
      brand: 4,
      partNumber: 5,
    });
    expect(exactPreview(sheet, mapping)).toMatchObject({ exact: 2, review: 0, reject: 0 });
  });

  it("keeps nonsense headers low-confidence", async () => {
    const sheet = await readUniversalFile(fixture("nonsense-headers.csv", "text/csv"));
    expect(inferColumnMapping([sheet.headers, ...sheet.rows]).confidence).toBe("low");
    expect(exactPreview(sheet, { partNumber: 0, brand: 1, model: 2, quantity: 3 })).toMatchObject({
      exact: 1,
      review: 0,
      reject: 0,
    });
  });

  it("routes non-each unit rows to review", async () => {
    const sheet = await readUniversalFile(fixture("unit-rows.csv", "text/csv"));
    const inferred = inferColumnMapping([sheet.headers, ...sheet.rows]);
    const mapped = mapUniversalRows(sheet, inferred.mapping);
    expect(mapped.rows).toEqual([]);
    expect(mapped.heldForReview).toHaveLength(1);
    expect(mapped.heldForReview[0].status).toBe("review");
    expect(buildImportPreview(mapped, [], inferred.source)).toMatchObject({ exact: 0, review: 1, reject: 0 });
  });

  it("rejects a row when every identity column is missing", async () => {
    const sheet = await readUniversalFile(fixture("missing-columns.csv", "text/csv"));
    const mapped = mapUniversalRows(sheet, { brand: 0, model: 1, quantity: 2 });
    expect(buildImportPreview(mapped, [], "manual")).toMatchObject({ exact: 0, review: 0, reject: 1 });
  });
});
~~~

- [ ] **Step 3: Run the tests and verify the expected failures**

Run: npx vitest run src/services/universalImport.stageA.test.ts src/services/universalImport.performance.test.ts

Expected: FAIL because the shared header helpers are not exported and the legacy adapters do not consume them.

- [ ] **Step 4: Apply the complete shared-header patch**

~~~diff
*** Begin Patch
*** Update File: src/services/columnIntelligence.ts
@@
-function fieldForHeader(value: string): ImportField | undefined {
+export function importFieldForHeader(value: string): ImportField | undefined {
@@
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
-  partNumber: ["part_number", "part number", "part_no", "sku"],
@@
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

- [ ] **Step 5: Run focused and adjacent tests**

Run: npx vitest run src/services/universalImport.stageA.test.ts src/services/universalImport.performance.test.ts src/services/csvImport.test.ts src/services/csvImport.trustGate.test.ts src/services/reconcile/shopwareCsvAdapter.test.ts

Expected: PASS. The D9 list is gone, all paths share core headers, every Shop-Ware cell is sanitized, and 5,000 rows preview in less than 10,000 ms.

---

## Task 11: Add the quantity-aware import resolution variant and wire Apply

**Stage:** A

**Depends on:** Tasks 1 through 10.

**Monolith warning:** This is the only Stage A task that edits src/stores/scanStore.ts. It runs after pure and server tracks and contains no unrelated refactor.

**Design rulings encoded:** Exact human rows preserve approved: true. Fuzzy and ambiguous rows create Needs Review without count or alias. resolveImportReview is distinct from reconcile confirm-link because imports carry quantity. UnknownCodeReview.importQuantity is persisted under scanStoreMigrate at src/stores/scanStore.ts:5685. The version 8 no-inject rule at line 5703 and version declaration at line 5733 are preserved while bumping to 9.

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

- Consumes: ImportPreviewRow[], resolveUnknown(reviewId: string, action: ResolveUnknownAction, payload: ResolveUnknownPayload): void, processScan(rawCode: string): void, reopenNeedsReview(cleanCode: string, reason: string): string | null, and snapshotCount(label: string): CountSnapshot.
- Produces: UnknownCodeReview.importQuantity?: number, reopenNeedsReview(cleanCode: string, reason: string, importContext?: ImportReviewContext): string | null, resolveImportReview(reviewId: string, action: "create_new" | "link_existing", payload: ResolveUnknownPayload): void, and applyUniversalImport(rows: ImportPreviewRow[]): UniversalImportApplySummary.

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

  it("applies an exact row with approved alias and full quantity", () => {
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

Expected: FAIL because importQuantity and the two import actions do not exist.

- [ ] **Step 3: Apply the complete persisted-field and action patch**

~~~diff
*** Begin Patch
*** Update File: src/types.ts
@@
 export interface UnknownCodeReview {
@@
   provisionalProductId?: string | null;
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
+import type {
+  ImportPreviewRow,
+  ImportReviewContext,
+  UniversalImportApplySummary,
+} from "@/services/importSchema";
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
+                    suggestedProductName: importContext?.suggestion?.name ?? "",
+                    suggestedBrand: importContext?.suggestion?.brand ?? "",
+                    suggestedCategory: importContext?.suggestion?.category ?? "",
+                    suggestedSpecsShort: importContext?.suggestion?.specsShort ?? "",
+                    suggestedPrimarySku: importContext?.suggestion?.primarySku ?? "",
+                    suggestedPrimaryBarcode: importContext?.suggestion?.primaryBarcode ?? "",
+                    hasSuggestion: Boolean(importContext?.suggestion),
                   }
@@
           idempotencyKey: buildIdempotencyKey(state.businessId, state.sessionId, id, "SAVE_UNKNOWN_SCAN"),
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
+          review.importQuantity < 0
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
+          const reviewId = get().reopenNeedsReview(code, preview.reason, {
+            importQuantity: source.quantity,
+            suggestion: {
+              name: preview.retailCatalogMatch?.productName || preview.candidate?.name || source.expected.name || code,
+              brand: preview.retailCatalogMatch?.brand || preview.candidate?.brand || source.brand,
+              category: preview.retailCatalogMatch?.category || source.category,
+              specsShort: [source.model, source.size].filter(Boolean).join(" "),
+              primarySku: source.partNumber,
+              primaryBarcode: source.barcode,
+            },
+          });
+          if (!reviewId) {
+            summary.rejected += 1;
+            continue;
+          }
+          if (preview.status !== "exact") {
+            summary.queuedForReview += 1;
+            continue;
+          }
+          const suggestion = get().needsReviewQueue.find((item) => item.id === reviewId);
+          get().resolveImportReview(reviewId, "create_new", {
+            origin: "human",
+            applyToCount: false,
+            newProduct: {
+              name: suggestion?.suggestedProductName || code,
+              brand: suggestion?.suggestedBrand || source.brand,
+              category: suggestion?.suggestedCategory || source.category,
+              specsShort: suggestion?.suggestedSpecsShort || source.size,
+              primarySku: source.partNumber,
+              primaryBarcode: source.barcode || code,
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

- [ ] **Step 4: Route import confirmations through the distinct variant**

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
-              onClick={() => resolveUnknown(review.id, "link_existing", { productId: linkId, applyToCount, selectedAliasCodes: selectedCodes })}
+              onClick={() => resolveReview("link_existing", { productId: linkId, applyToCount, selectedAliasCodes: selectedCodes })}
*** End Patch
~~~

- [ ] **Step 5: Create the complete container and mount it**

~~~tsx
// src/components/UniversalImportPanelContainer.tsx
"use client";

import { UniversalImportPanel } from "@/components/UniversalImportPanel";
import { getSession } from "@/lib/auth";
import type { ColumnMapping, MappedImportRow } from "@/services/importSchema";
import { isLiveAuth } from "@/services/auth/authMode";
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
    const query = new URLSearchParams({ businessId, sourceSignature });
    const response = await fetch("/api/import-mapping?" + query.toString(), {
      cache: "no-store",
      headers: idToken ? { Authorization: "Bearer " + idToken } : {},
    });
    if (!response.ok) return null;
    return ((await response.json()) as { mapping: ColumnMapping | null }).mapping;
  }

  async function saveMapping(sourceSignature: string, mapping: ColumnMapping): Promise<void> {
    const idToken = await token();
    const response = await fetch("/api/import-mapping", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { Authorization: "Bearer " + idToken } : {}),
      },
      body: JSON.stringify({ businessId, sourceSignature, mapping }),
    });
    if (!response.ok) throw new Error("Import applied, but its mapping was not remembered.");
  }

  async function matchRows(rows: MappedImportRow[]): Promise<PreviewMatchResult[]> {
    const response = await fetch("/api/reconcile/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: rows.map((row) => row.expected) }),
    });
    const body = (await response.json()) as { error?: string; matches?: PreviewMatchResult[] };
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

Expected: PASS. Preview data causes zero writes. Exact Apply approves and counts. Fuzzy Apply creates only an open review. resolveImportReview applies stored quantity. Partial v8 blobs gain no absent keys.

---

## Task 12: Prove Stage A ships independently at both viewports

**Stage:** A ship gate

**Depends on:** Tasks 1 through 11. Task 13 cannot start until this task passes.

**Files:**

- Create: e2e/phase4-universal-import.spec.ts
- Create: e2e/phase4-universal-import.visual.spec.ts

**Interfaces:**

- Consumes: UniversalImportPanelContainer, POST /api/reconcile/match, GET and PUT /api/import-mapping, applyUniversalImport, the /scan variance view, and /report Boss Report.
- Produces: no production symbols. Produces the exact 380 of 400 demo proof at 1280 by 800 and 390 by 844.

- [ ] **Step 1: Write the complete functional proof**

~~~typescript
// e2e/phase4-universal-import.spec.ts
import { expect, test } from "./fixtures";

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

function uploadCsv(): string {
  const rows = Array.from({ length: 400 }, (_, index) =>
    ["PN-" + index, "Acme", "Road " + index, "225/45R18", "1"].join(","),
  );
  return ["PN,Make,Model,Tire Size,QOH", ...rows].join("\n");
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
                  reason: "Part number hit.",
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
  test("Phase 4 import is readable at " + item.name, async ({ page }) => {
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

Expected: PASS at desktop and phone. There are zero writes before Apply, the headline is exact, one mapping write happens after Apply, 380 rows apply, 20 rows enter review, both snapshots appear, and variance and Boss Report are visible.

- [ ] **Step 4: Run the complete Stage A gate**

Run: npm run test

Expected: PASS for all Vitest projects.

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

Expected: PASS with the route and Products panel.

Run: npm run qa:revision

Expected: PASS after intentional review of desktop and phone images.

---

## Task 13: Implement the net-new character-level edit-distance primitive

**Stage:** B

**Hard ordering:** Start only after Task 12 passes.

**Files:**

- Create: src/services/reconcile/normalizedEditDistance.ts
- Test: src/services/reconcile/normalizedEditDistance.test.ts

**Interfaces:**

- Consumes: two untrusted strings.
- Produces: normalizedEditSimilarity(left: string, right: string): number from 0 through 1.

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

  it("scores a one-character typo at or above 0.75", () => {
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

**Design rulings encoded:** IDENTITY_JACCARD_THRESHOLD = 0.75 plus nameTokens and jaccard from src/services/catalog/identityMerge.ts are canonical. crossCheckEngine.ts and siblingGuard.ts remain untouched because their empty-set behavior differs. Every fuzzy result is review-only. Scores below 0.75 are review. Multiple qualifying candidates are ambiguous. prefixBrandConflict is a negative non-tire veto, never positive proof.

**Files:**

- Modify: src/services/catalog/identityMerge.ts (add the `FUZZY_BRAND_MIN` named export - the sanctioned threshold home)
- Create: src/services/reconcile/importFuzzyMatcher.ts
- Test: src/services/reconcile/importFuzzyMatcher.test.ts

**Interfaces:**

- Consumes: ExpectedInventoryRow, CorpusCandidate[], IDENTITY_JACCARD_THRESHOLD, FUZZY_BRAND_MIN, nameTokens(value: string): string[], jaccard(a: string[], b: string[]): number, plusGenerationDiff(a: string[], b: string[]): boolean, normalizedEditSimilarity(left: string, right: string): number, tireSizeToken(r: IdentityText | null | undefined): string, sameBrandFamily(a: string, b: string): boolean, and prefixBrandConflict(code: string | undefined, brand: string | undefined): boolean.
- Produces: FuzzyCandidateScore, FuzzyImportDecision, scoreImportCandidate(row: ExpectedInventoryRow, candidate: CorpusCandidate): FuzzyCandidateScore | null, and matchImportFuzzy(row: ExpectedInventoryRow, candidates: CorpusCandidate[]): FuzzyImportDecision.

- [ ] **Step 0: Add the FUZZY_BRAND_MIN threshold export to the canonical threshold home**

In `src/services/catalog/identityMerge.ts`, immediately after the existing `export const IDENTITY_JACCARD_THRESHOLD = 0.75;` (around line 85), add a second named export. Do NOT add a bare numeric literal in the matcher (scout landmine: all identity thresholds live here as named exports).

~~~typescript
/**
 * Stage B ONLY. Minimum normalized brand edit-similarity for a typo-tolerant brand match
 * when the two brands are NOT the same curated corporate family. Deliberately higher than
 * IDENTITY_JACCARD_THRESHOLD: brand identity is load-bearing, so a distinct real brand that
 * merely looks similar ("Kelly" vs "Kelso") must fall below this and route to review, while a
 * genuine single-char typo in a normal-length brand ("Micheln" vs "Michelin" = 0.875) clears it.
 * Never used to auto-count - fuzzy matches are review-only.
 */
export const FUZZY_BRAND_MIN = 0.8;
~~~

Note: this is an additive export - it does NOT change `findIdentityMerge` (the scan-time consumer), so the shared-symbol dual-call-site risk does not apply.

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
    expect(result.autoApprove).toBe(false);
  });

  it("normalizes tire notation and rejects a size mismatch", () => {
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

  it("returns ambiguous for two qualifying candidates", () => {
    const result = matchImportFuzzy(row(), [
      candidate({ uid: "one" }),
      candidate({ uid: "two", name: "Defender TH" }),
    ]);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    expect(result.autoApprove).toBe(false);
  });

  it("vetoes a genuine plus-generation pair (R8 vs R8+) to review, never a match", () => {
    // nameTokens keeps the trailing "+", so plusGenerationDiff fires and the candidate is
    // dropped - nothing qualifies -> review. Exercises the real veto, not a below-threshold miss.
    const result = matchImportFuzzy(
      row({ brand: "Acme", model: "Grabber R8" }),
      [candidate({ brand: "Acme", name: "Grabber R8+" })],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });

  it("routes a distinct look-alike brand to review, never fuzzy", () => {
    // Different real brands that merely look similar must NOT bridge via edit distance:
    // "Kelso" vs "Kelly" (~0.6) is below FUZZY_BRAND_MIN even though the model matches exactly.
    const result = matchImportFuzzy(
      row({ brand: "Kelso", model: "Defender T H", sizeText: "225/65R17" }),
      [candidate({ brand: "Kelly", name: "Defender T H" })],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
  });

  it("routes a sizeless row to review, never fuzzy (size is a hard gate)", () => {
    const result = matchImportFuzzy(
      row({ sizeText: "", specs: "", model: "Defender T H" }),
      [candidate()],
    );
    expect(result.status).toBe("review");
    expect(result.autoApprove).toBe(false);
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
  FUZZY_BRAND_MIN,
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

// Notation normalization (owner-ratified "size-notation normalization"): the corpus size
// token is canonical NNN/NNRNN, but shop exports arrive as "225 65 17" or "225-65-17".
// This reformats any-separator width/aspect/rim into the canonical slash-R form so
// tireSizeToken can parse it. SAME-numbers-different-separator (identical tire), NOT fuzzy
// tolerance on size - a genuinely different or typo'd size still fails the exact gate.
export function normalizeImportSize(raw: string): string {
  if (!raw) return raw;
  const m = raw.match(/\b(LT|P|ST)?\s*(\d{3})[\s\-/](\d{2})[\s\-/](\d{2})\b/i);
  if (!m) return raw;
  const prefix = m[1] ? m[1].toUpperCase() : "";
  return raw.replace(m[0], `${prefix}${m[2]}/${m[3]}R${m[4]}`);
}

function sizeOf(value: string, brand?: string): string {
  // Canonical parse first (handles slash notation embedded in a name), then fall back to
  // notation-normalized so dash/space imports resolve to the SAME exact token.
  const direct = tireSizeToken({ productName: value, brand });
  return direct || tireSizeToken({ productName: normalizeImportSize(value), brand });
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

  // Size is a HARD gate, never fuzzy - mirrors identityMatcher Step 2's `if (rowSize)`.
  // A row with no parseable size may NOT fuzzy-match a specific-size candidate on name
  // alone (a size typo changes the physical product). Exact canonical-token equality only;
  // field concat order matches identityMatcher.rowSizeToken ([sizeText, specs, model]).
  const expectedSize = sizeOf([row.sizeText, row.specs, row.model].filter(Boolean).join(" "), row.brand);
  if (!expectedSize) return null;
  const candidateSize = sizeOf([candidate.sizeToken, candidate.name].filter(Boolean).join(" "), candidate.brand);
  if (expectedSize !== candidateSize) return null;

  // Sanctioned brand-conflict veto, unconditional: a known GS1-prefix-to-brand conflict
  // kills the match. prefixBrandConflict is a negative veto, never positive proof.
  const code = row.barcode || row.partNumbers[0] || "";
  if (prefixBrandConflict(code, row.brand)) return null;

  // Brand corroboration: same curated corporate family (preserves the Dunlop carve-out) OR
  // a BOUNDED typo-tolerance floor. Brand edit-distance is NOT a general similarity notion -
  // it must clear FUZZY_BRAND_MIN so distinct real brands that merely look alike route to
  // review, never surface as a fuzzy suggestion. (Keeps "Micheln"->"Michelin" working.)
  const sameFamily = !!row.brand && !!candidate.brand && sameBrandFamily(row.brand, candidate.brand);
  const brandEdit = row.brand && candidate.brand
    ? normalizedEditSimilarity(row.brand, candidate.brand)
    : 0;
  if (row.brand && candidate.brand && !sameFamily && brandEdit < FUZZY_BRAND_MIN) return null;
  const brandScore = sameFamily ? 1 : brandEdit;

  const nameScore = Math.max(
    jaccard(expectedTokens, candidateTokens),
    normalizedEditSimilarity(expectedName, candidateName),
  );
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

Expected: PASS, 7 tests. Unique typo, size mismatch, below-threshold, ambiguity, plus-generation, distinct look-alike brand, and sizeless-row outcomes all resolve to fuzzy/ambiguous/review and never auto-approve.

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

- Consumes: matchImportFuzzy(row: ExpectedInventoryRow, candidates: CorpusCandidate[]): FuzzyImportDecision, candidatesBySizeToken(sizeToken: string): Promise<TireKnowledgeRow[]>, buildImportPreview, applyUniversalImport, resolveImportReview, Needs Review, variance, and Boss Report.
- Produces: MatcherDeps.candidatesForFuzzy?(sizeToken: string): CorpusCandidate[], MatchResult.matchBasis extended with "identity_fuzzy", and proof that fuzzy rows never receive approved: true or quantity before confirmation.

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
  return { externalId: "row", partNumbers: [], qty: 1, raw: {}, ...overrides };
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

> **MANUAL PLACEMENT (not a mechanical `git apply`):** the `identityMatcher.ts` hunk anchors (`if (rowSize) { ... }`) are not unique in the file. Insert the new `if (rowSize && deps.candidatesForFuzzy) { ... }` fallback block AFTER the closing brace of the existing `if (rowSize) {...}` identity-jaccard block (which ends right before the `// --- Step 3 / 4` comment) and BEFORE that Step 3/4 comment - i.e. the fuzzy tier is a fallback that runs only when the exact-token identity-jaccard tier found zero survivors and fell through. Verify by reading the current file; do not blind-apply.

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
+  it("never promotes identity_fuzzy to exact", () => {
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

- [ ] **Step 4: Write the complete fuzzy review E2E proof**

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

Expected: PASS. Stage A stays green at both viewports. Fuzzy quantity is zero before confirm and four after confirm.

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

Expected: PASS after desktop and phone screenshot review.

---

## Self-Review Pass

### Acceptance criteria coverage

- [ ] AC1, universal supported formats and no four-name list: Tasks 2, 3, 4, 7, 9, 10, and 12. Task 10 deletes SHOPWARE_COLUMN_MAP.partNumber.
- [ ] AC2, exact fixture counts and zero low-confidence automatic merges: Tasks 7, 11, 13, 14, and 15. T is exactly 0.75. Jaccard, affix-core, character-fuzzy, below-threshold, and ambiguous rows are review-only.
- [ ] AC3, nonsense-header manual mapping remembered: Tasks 3, 5, 6, 9, 10, and 12. Mapping writes only after Apply.
- [ ] AC4, 5,000 rows under 10 seconds: Task 10 times file read, inference, map, matcher-result shaping, and preview together.
- [ ] AC5, upload through preview, Apply, variance, Boss Report, both viewports, and polish: Tasks 9, 11, 12, and 15.

### Parallel and file-boundary audit

- [ ] Tasks 1 through 4 are the sequential foundation.
- [ ] Tasks 5 and 6 own mapping persistence, Task 8 owns the Stage A route, Task 9 owns the panel, and Task 10 owns legacy adapters and performance fixtures. Their parallel production boundaries are disjoint.
- [ ] Task 7 publishes types before Tasks 8 through 10 consume them.
- [ ] Task 11 is the only Stage A scanStore task and runs after parallel tracks.
- [ ] Task 12 blocks Stage B and proves Stage A independently shippable.
- [ ] Tasks 13, 14, and 15 are sequential after Task 12. Stage B tuning cannot delay Stage A.
- [ ] Task 15 reopens Task 7 route and matcher files only after Stage A is complete.

### Binding design-ruling audit

- [ ] Resolver trust invariant 3: Task 7 routes non-exact evidence to fuzzy or review. Tasks 11 and 15 prove no fuzzy alias or count before confirmation. Exact human-upload rows retain origin: "human" and approved: true.
- [ ] Preview-before-apply: Tasks 9, 11, and 12 keep preview in React state and assert zero store, DB, mapping, or localStorage writes before Apply.
- [ ] Sanitizer: Tasks 2 and 4 apply stripControlChars, cap 500, then defuseFormulaInjection to every cell. Task 2 closes the Shop-Ware gap.
- [ ] ExcelJS read: Task 4 adds the first workbook.xlsx.load path.
- [ ] Monolith: Task 11 is the only Stage A scanStore edit and is ordered last.
- [ ] Migration: Task 11 cites scanStoreMigrate and changes version 8 to 9 without injecting absent keys.
- [ ] Canonical Jaccard: Tasks 7 and 14 use identityMerge.ts nameTokens and jaccard at 0.75. crossCheckEngine.ts and siblingGuard.ts remain the divergent landmine and are not unified.
- [ ] Mapping seam: Tasks 5 and 6 choose businessId-namespaced Turso LadderStorage KV. It works in mock and live. localStorage is device-only. Firestore would split this feature across the second DB and lacks the scout's mock seam. A dedicated table can later replace the implementation behind the same interface.
- [ ] Quantity review: Task 11 adds resolveImportReview and leaves ReconcilePanel confirm-link applyToCount: false unchanged.
- [ ] Non-tire corroboration: Task 14 uses prefixBrandConflict only as a veto. Task 8 uses exact retail barcode lookup as positive evidence.
- [ ] Performance: Task 10 enforces the complete 5,000-row target under 10 seconds.
- [ ] Stage order: character edit distance exists only in Tasks 13 through 15 after Stage A.
- [ ] Typography and safety: the plan contains no em dash or en dash, invokes no paid script, and contains no plan-time source mutation.

### Flagged unknowns carried into execution

- [ ] ExcelJS 4.4.0 reads OOXML XLSX but not legacy BIFF .xls. The plan accepts OOXML bytes named .xls and rejects true BIFF with actionable copy. Literal BIFF support needs an owner-approved parser and is not grounded in installed code.
- [ ] The scouts contain no real customer Boss Report export. Fixtures use the binding PN, Make, Model, Tire Size, and QOH vocabulary. Validate the first real export without reintroducing per-format code.
