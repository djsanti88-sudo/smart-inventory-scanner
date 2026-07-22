import { describe, it, expect } from "vitest";
import { scanStoreMigrate } from "@/stores/scanStore";
import type { Product } from "@/types";

// Task 2 (owner-reported live bug, 2026-07-20): rows saved BEFORE the enrichProductIdentity fix
// live in localStorage with blank brand/category/specsShort/specsFull/structuredModel even though
// their name is cleanly parseable (e.g. "Falken Azenis RT660 P 245 /40 R18 97W XL BSW"). This is a
// ONE-TIME (per persist version) backfill that runs inside scanStoreMigrate on rehydrate: for every
// counted product row whose structured fields are empty but whose name parses, fill the empty
// fields via the SAME shared enrichProductIdentity helper the live apply sites use. Must be safe:
// never overwrite a non-empty field, never touch quantities/ledger/other session state, never drop
// rows, and never re-run on a row already structured (idempotent).

function product(over: Partial<Product> & { id: string }): Product {
  return {
    businessId: "b1", name: "X", brand: "", category: "", specsShort: "", specsFull: "",
    primarySku: "", primaryBarcode: "", gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [],
    imageUrl: "", productUrl: "", location: "", notes: "", status: "active", source: "manual",
    confidence: 1, verified: true, createdAt: "t", updatedAt: "t", createdBy: "seed", updatedBy: "seed",
    ...over,
  };
}

describe("scanStoreMigrate - Task 2 identity backfill (Falken bug legacy rows)", () => {
  it("fills empty brand/specsShort/structuredModel on a legacy row whose name parses, on rehydrate", () => {
    const legacyFalkenRow = product({
      id: "p-falken-legacy",
      name: "Falken Azenis RT660 P 245 /40 R18 97W XL BSW",
      // Exactly the owner's live bug shape: brand/category/specsShort/specsFull all blank despite a
      // fully parseable name.
      brand: "", category: "", specsShort: "", specsFull: "",
    });

    const persisted = { businessId: "b1", products: [legacyFalkenRow] };
    const migrated = scanStoreMigrate(persisted, 9) as unknown as { products: Product[] };

    const migratedRow = migrated.products.find((p) => p.id === "p-falken-legacy")!;
    expect(migratedRow.brand, "Brand column backfilled").toBe("Falken");
    // Group B owner mandate (2026-07-21): specsShort includes the parsed load/speed + sidewall when
    // parseable, not just the bare size.
    expect(migratedRow.specsShort, "Specs/Size column backfilled").toBe("P245/40R18 97W XL BSW");
    expect(migratedRow.structuredModel ?? "", "Model column backfilled").toContain("Azenis RT660");
  });

  it("never overwrites a non-empty (human-entered or already-decoded) field during backfill", () => {
    const humanEditedRow = product({
      id: "p-human-edited",
      name: "Falken Azenis RT660 P 245 /40 R18 97W XL BSW",
      brand: "HumanCorrectedBrand",
      specsShort: "HUMAN-SIZE",
      category: "HumanCategory",
    });

    const persisted = { businessId: "b1", products: [humanEditedRow] };
    const migrated = scanStoreMigrate(persisted, 9) as unknown as { products: Product[] };

    const migratedRow = migrated.products.find((p) => p.id === "p-human-edited")!;
    expect(migratedRow.brand).toBe("HumanCorrectedBrand");
    expect(migratedRow.specsShort).toBe("HUMAN-SIZE");
    expect(migratedRow.category).toBe("HumanCategory");
  });

  it("never drops a row and never touches unrelated session/sync state during backfill", () => {
    const legacyRow = product({ id: "p-legacy", name: "Falken Azenis RT660 245/40R18" });
    const aliases = [{ id: "keep-me" }];
    const finalCounts = [{ id: "keep-count", productId: "p-legacy", quantity: 4 }];
    const persisted = { businessId: "b1", products: [legacyRow], aliases, finalCounts };

    const migrated = scanStoreMigrate(persisted, 9) as unknown as {
      products: Product[];
      aliases: unknown[];
      finalCounts: Array<{ quantity: number }>;
    };

    expect(migrated.products).toHaveLength(1);
    expect(migrated.aliases).toEqual(aliases);
    expect(migrated.finalCounts).toEqual(finalCounts);
    expect(migrated.finalCounts[0].quantity).toBe(4);
  });

  it("is idempotent: running the backfill twice on an already-filled row changes nothing further", () => {
    const persisted = {
      businessId: "b1",
      products: [product({ id: "p-once", name: "Falken Azenis RT660 245/40R18" })],
    };
    const once = scanStoreMigrate(persisted, 9) as unknown as { products: Product[] };
    const twice = scanStoreMigrate(once, 9) as unknown as { products: Product[] };

    expect(twice.products.find((p) => p.id === "p-once")).toEqual(once.products.find((p) => p.id === "p-once"));
  });

  it("skips a row already stamped structuredBy human (never overrides a human correction)", () => {
    const persisted = {
      businessId: "b1",
      products: [
        product({
          id: "p-locked",
          name: "Falken Azenis RT660 245/40R18",
          structuredBy: "human",
          structuredModel: "Custom Human Model",
        }),
      ],
    };
    const migrated = scanStoreMigrate(persisted, 9) as unknown as { products: Product[] };
    const row = migrated.products.find((p) => p.id === "p-locked")!;
    expect(row.structuredModel).toBe("Custom Human Model");
  });
});
