import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { toImportCsv, type TireRecord } from "./tireCatalog";
import { parseCsv, buildProductImport } from "@/services/csvImport";
import { resolveRawScan } from "@/services/resolver";

// Stage 7 INTEGRATION CHECK: prove the GENERATED tire catalog flows through the app's real import +
// resolver path in an isolated namespace (businessId "biz-tire-itest"). Pure + deterministic (no
// production Firebase). The emulator persistence path for tire data is already proven end-to-end in
// the Stage 2 controlled pilot; here we prove catalog -> products+aliases -> a scan resolves Known.

const CATALOG = resolve(process.cwd(), "data/tire-catalog/tire_catalog_100.jsonl");
const BIZ = "biz-tire-itest";

function loadRecords(): TireRecord[] {
  const text = readFileSync(CATALOG, "utf8").trim();
  return text ? text.split("\n").map((l) => JSON.parse(l) as TireRecord) : [];
}

describe("Stage 7 tire catalog integration check", () => {
  let records: TireRecord[];
  let importCsv: string;
  let importableCount: number;

  beforeAll(() => {
    records = loadRecords();
    importCsv = toImportCsv(records);
    // importable = non-conflicted records with at least one code
    importableCount = records.filter((r) => r.status !== "conflicted" && (r.upcGtin || r.vendorSku || r.partNumber || r.mfrPartNumber)).length;
  });

  it("the 100-stage catalog file exists with records", () => {
    expect(existsSync(CATALOG)).toBe(true);
    expect(records.length).toBeGreaterThan(0);
  });

  it("import builds products + APPROVED aliases for records that carry a code", () => {
    const rows = parseCsv(importCsv).rows;
    let seq = 0;
    const plan = buildProductImport({
      rows,
      existingProducts: [],
      existingAliases: [],
      businessId: BIZ,
      idFactory: () => `itest-${++seq}`,
      now: () => "2026-06-15T00:00:00.000Z",
    });
    expect(plan.products.length).toBe(importableCount);
    expect(plan.products.length).toBeGreaterThan(0);
    expect(plan.aliases.length).toBeGreaterThan(0);
    expect(plan.aliases.every((a) => a.approved && a.businessId === BIZ)).toBe(true);
  });

  it("a scan of an imported code resolves Known to the imported product", () => {
    const rows = parseCsv(importCsv).rows;
    let seq = 0;
    const plan = buildProductImport({
      rows,
      existingProducts: [],
      existingAliases: [],
      businessId: BIZ,
      idFactory: () => `itest-${++seq}`,
      now: () => "2026-06-15T00:00:00.000Z",
    });
    // pick the first imported alias code and scan it
    const code = plan.aliases[0].cleanCode;
    const res = resolveRawScan(code, plan.products, plan.aliases, BIZ);
    expect(res.resolverStatus).toBe("known");
    expect(res.productId).toBe(plan.aliases[0].productId);
  });

  it("re-importing the same catalog is idempotent (codes already mapped -> conflicts, no new products)", () => {
    const rows = parseCsv(importCsv).rows;
    let seq = 0;
    const first = buildProductImport({ rows, existingProducts: [], existingAliases: [], businessId: BIZ, idFactory: () => `a-${++seq}`, now: () => "t" });
    let seq2 = 0;
    const second = buildProductImport({
      rows,
      existingProducts: first.products,
      existingAliases: first.aliases, // already-approved codes
      businessId: BIZ,
      idFactory: () => `b-${++seq2}`,
      now: () => "t",
    });
    expect(second.products.length).toBe(0); // every code already maps -> no duplicate products
    expect(second.conflicts.length).toBeGreaterThan(0); // codes already mapped are reported as conflicts
  });

  it("spec-only records (no scannable code) are NOT in the import-ready CSV (honest)", () => {
    const specOnly = records.filter((r) => r.scannable === "spec_only");
    for (const r of specOnly) {
      const name = `${r.brand} ${r.model}`.trim();
      // a spec-only record with no code must not appear as an importable row
      if (!(r.upcGtin || r.vendorSku || r.partNumber || r.mfrPartNumber)) {
        expect(importCsv.includes(name)).toBe(false);
      }
    }
  });

  it("writes the integration check summary", () => {
    const rows = parseCsv(importCsv).rows;
    let seq = 0;
    const plan = buildProductImport({ rows, existingProducts: [], existingAliases: [], businessId: BIZ, idFactory: () => `s-${++seq}`, now: () => "t" });
    const sampleCode = plan.aliases[0]?.cleanCode ?? "";
    mkdirSync(resolve(process.cwd(), "reports/tire-db"), { recursive: true });
    writeFileSync(
      resolve(process.cwd(), "reports/tire-db/integration_check_summary.md"),
      `# Tire Catalog Integration Check (Stage 7)

Isolated namespace: \`${BIZ}\` (no production Firebase). Emulator persistence for tire data is proven
end-to-end in the Stage 2 controlled pilot; this check proves the GENERATED 100-stage catalog flows
through the app's real CSV import + deterministic resolver.

- Catalog records: **${records.length}**
- Importable (has a scannable code, non-conflicted): **${importableCount}**
- Products created on import: **${plan.products.length}**
- Approved aliases created: **${plan.aliases.length}**
- Sample imported code that resolves **Known**: \`${sampleCode}\` -> product \`${plan.aliases[0]?.productId ?? ""}\`
- Re-import is idempotent (already-mapped codes -> conflicts, **0** new products).
- Spec-only records (no code) are correctly EXCLUDED from the import-ready CSV.

> Honest note: the importable codes here are retailer **product/tire codes** (candidate, not verified
> UPC/GTIN barcodes), because no free source published scannable tire barcodes (see source_inventory.md).
> The mechanism is proven: any record carrying a code imports and resolves on scan. The moment a real
> shop/vendor CSV (with true barcodes) is supplied, the same path yields verified-scannable records.

Proof type: automated unit/integration (pure, deterministic). \$0 spend.
`,
    );
    expect(existsSync(resolve(process.cwd(), "reports/tire-db/integration_check_summary.md"))).toBe(true);
  });
});
