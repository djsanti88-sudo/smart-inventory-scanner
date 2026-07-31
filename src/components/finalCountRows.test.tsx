import { describe, expect, it } from "vitest";
import {
  createFinalCountRowSelector,
  filterFinalCountRows,
} from "@/components/finalCountRows";
import type { InventoryCount, Product } from "@/types";

const baseProduct: Product = {
  id: "product-0", businessId: "business-1", name: "Widget 0", brand: "Acme", category: "Tools",
  specsShort: "", specsFull: "", primarySku: "SKU-0", primaryBarcode: "000", gtin: "", upc: "", ean: "",
  vendorCodes: [], aliases: ["000"], imageUrl: "", productUrl: "", location: "", notes: "",
  status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};

function makeCount(index: number): InventoryCount {
  return {
    id: `count-${index}`, businessId: "business-1", sessionId: "session-1", productId: `product-${index}`,
    quantity: 250 - index, lastScannedAt: "", aliasesSeen: [], scanEventIds: [], createdAt: "", updatedAt: "",
    syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
  };
}

describe("FinalCountTable row derivation performance", () => {
  it("reuses the 250-row model for unrelated updates and empty-filter reveals", () => {
    const products = Array.from({ length: 250 }, (_, index) => ({
      ...baseProduct,
      id: `product-${index}`,
      name: `Widget ${index}`,
    }));
    const finalCounts = Array.from({ length: 250 }, (_, index) => makeCount(index));
    const selectRows = createFinalCountRowSelector();
    const inputs = { finalCounts, products, currentSessionId: "session-1" };

    const rows = selectRows(inputs);
    expect(rows).toHaveLength(250);
    expect(rows[0]?.count.quantity).toBe(250);
    expect(rows[249]?.count.quantity).toBe(1);
    expect(selectRows.getBuildCount()).toBe(1);

    // A store update to a state field this table does not read leaves its derivation inputs stable.
    expect(selectRows(inputs)).toBe(rows);
    expect(selectRows.getBuildCount()).toBe(1);

    // Showing more rows with an empty query only slices the model at render time; it must not filter
    // or rebuild all 250 rows.
    expect(filterFinalCountRows(rows, "")).toBe(rows);
    expect(filterFinalCountRows(rows, "   ")).toBe(rows);
    expect(selectRows.getBuildCount()).toBe(1);
  });
});
