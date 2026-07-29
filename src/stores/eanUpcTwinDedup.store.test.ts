import { describe, it, expect } from "vitest";
import { createTestScanStore } from "@/stores/scanStore";
import { MockDb } from "@/services/mockDb";
import { sanitizeCatalogEntry } from "@/services/catalog/sanitizeCatalog";
import type { CatalogEntry } from "@/services/catalog/catalogTypes";

// RUNTIME CONTRACT (owner law, db-blank-filler skill polish, 2026-07-28): every data class the
// db-blank-filler skill adds to the tire corpus must ship an app-level test proving real scan
// behavior. This is the flagship contract for the EAN-13/UPC-A "twin" barcode class the skill's
// twin_complete.mjs stage materializes (SKILL.md stage 2): scanning a tire's EAN-13 code and then
// its UPC-A twin (same physical tire, two GS1 encodings) must yield ONE product row with quantity
// 2 - never a second product - and the UI-facing product identity must never display both codes
// glued together (single primaryBarcode, single aliases entry per distinct code).
//
// Mechanism under test: canonicalGtin (src/services/upc/gtin.ts) strips leading zeros then re-pads
// to 14 digits, so a 12-digit UPC-A and its 0-prefixed EAN-13 twin collapse to the same canonical
// key. That canonical key is what the catalog-first lookup keys on (sanitizeCatalogEntry normalizes
// normalizedBarcode the same way product identity resolution does), so a second scan of the twin
// code resolves to the SAME catalog entry / product as the first, mirroring exactly what
// twin_complete.mjs proves at the corpus level (is_primary_form: 1 on the UPC-A, 0 on the EAN-13).
const NOW = "2026-07-28T00:00:00.000Z";

// A real tire UPC-A (12 digits, valid GS1 check digit) and its EAN-13 twin (0-prefixed).
const UPC_A = "042494845729"; // 12-digit UPC-A, valid check digit
const EAN_13 = "0" + UPC_A; // 0042494845723 - the leading-zero EAN-13 twin, same physical tire

function verifiedTireEntry(code: string, name: string): CatalogEntry {
  return sanitizeCatalogEntry(
    { barcode: code, normalizedBarcode: code, name, brand: "Cooper", category: "Tire", confidence: 0.95 },
    { now: NOW, verificationStatus: "verified", verifiedBy: "owner", by: "owner" },
  );
}

describe("EAN-13 / UPC-A twin dedup (db-blank-filler runtime contract)", () => {
  it("scanning the EAN-13 then its UPC-A twin of the SAME tire yields ONE product row with quantity 2", () => {
    const store = createTestScanStore({ db: new MockDb() });
    // Seed a verified catalog entry keyed by the UPC-A (the primary form per twin_complete.mjs
    // owner policy: is_primary_form=1 on the 12-digit UPC-A).
    store.setState({ catalog: [verifiedTireEntry(UPC_A, "Cooper Discoverer A/T3 LT245/75R16 120R")] });

    // First scan: the EAN-13 twin (0-prefixed).
    store.getState().processScan(EAN_13);
    const afterFirst = store.getState().products.filter(
      (p) => p.name === "Cooper Discoverer A/T3 LT245/75R16 120R",
    );
    expect(afterFirst.length, "first scan (EAN-13) mints exactly one product row").toBe(1);
    const product = afterFirst[0];
    expect(store.getState().finalCounts.find((c) => c.productId === product.id)?.quantity).toBe(1);

    // Second scan: the UPC-A twin of the SAME physical tire.
    store.getState().processScan(UPC_A);

    const allMatchingRows = store.getState().products.filter(
      (p) => p.name === "Cooper Discoverer A/T3 LT245/75R16 120R",
    );
    expect(allMatchingRows.length, "the UPC-A twin scan reuses the SAME product row - never a second product").toBe(1);
    expect(allMatchingRows[0].id).toBe(product.id);

    const finalCount = store.getState().finalCounts.find((c) => c.productId === product.id);
    expect(finalCount?.quantity, "quantity aggregates across both encodings (1 + 1 = 2)").toBe(2);

    // The UI-facing product identity never displays "dual codes": exactly one primaryBarcode string
    // (not a concatenation/join of both scanned forms), and the code is one of the two valid forms.
    expect(typeof product.primaryBarcode).toBe("string");
    expect(product.primaryBarcode).not.toContain(",");
    expect(product.primaryBarcode).not.toMatch(/\s/);
    expect([UPC_A, EAN_13]).toContain(store.getState().products.find((p) => p.id === product.id)!.primaryBarcode);

    // Only ONE counted row total for this tire - no orphaned second row anywhere in state.
    const countedRowsForThisTire = store.getState().products.filter(
      (p) => (store.getState().finalCounts.find((c) => c.productId === p.id)?.quantity ?? 0) > 0
        && p.name === "Cooper Discoverer A/T3 LT245/75R16 120R",
    );
    expect(countedRowsForThisTire).toHaveLength(1);
  });

  it("reversed order (UPC-A scanned first, then its EAN-13 twin) still merges into one row", () => {
    const store = createTestScanStore({ db: new MockDb() });
    store.setState({ catalog: [verifiedTireEntry(UPC_A, "Cooper Discoverer A/T3 LT245/75R16 120R")] });

    store.getState().processScan(UPC_A);
    const first = store.getState().products.filter((p) => p.name === "Cooper Discoverer A/T3 LT245/75R16 120R");
    expect(first.length).toBe(1);

    store.getState().processScan(EAN_13);
    const rows = store.getState().products.filter((p) => p.name === "Cooper Discoverer A/T3 LT245/75R16 120R");
    expect(rows.length, "still exactly one product row regardless of scan order").toBe(1);
    expect(rows[0].id).toBe(first[0].id);
    expect(store.getState().finalCounts.find((c) => c.productId === first[0].id)?.quantity).toBe(2);
  });
});
