import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { FinalCountTable } from "@/components/FinalCountTable";
import type { InventoryCount, Product } from "@/types";

const product: Product = {
  id: "p1", businessId: "b", name: "Test Widget", brand: "Acme", category: "Tools",
  specsShort: "", specsFull: "", primarySku: "SKU1", primaryBarcode: "111222333444", gtin: "", upc: "", ean: "",
  vendorCodes: [], aliases: ["111222333444"], imageUrl: "", productUrl: "", location: "A1", notes: "",
  status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};
const count: InventoryCount = {
  id: "c1", businessId: "b", sessionId: "s", productId: "p1", quantity: 5, lastScannedAt: "",
  aliasesSeen: ["111222333444", "ALT-CODE-9"], scanEventIds: [], createdAt: "", updatedAt: "",
  syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
};

function seed() {
  useScanStore.setState({ products: [product], finalCounts: [count] });
}

afterEach(() => {
  cleanup();
  delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
});

describe("FinalCountTable role gating (Phase 6)", () => {
  it("hides Primary barcode + Aliases (and the raw codes) from a business/customer role", () => {
    delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER; // business / customer
    seed();
    render(<FinalCountTable />);
    expect(screen.getByText("Test Widget")).toBeTruthy(); // product IS visible
    expect(screen.queryByText("Primary barcode")).toBeNull();
    expect(screen.queryByText("Aliases")).toBeNull();
    expect(screen.queryAllByText(/111222333444/).length).toBe(0); // raw barcode not leaked
    expect(screen.queryAllByText(/ALT-CODE-9/).length).toBe(0); // alias DB not leaked
    // Mark wrong (destructive alias repair) is platformOwner-only
    expect(screen.queryByTestId("mark-wrong-p1")).toBeNull();
    // product-facing correction controls remain available
    expect(screen.queryByTestId("correct-p1")).not.toBeNull();
    expect(screen.queryByTestId("remove-count-p1")).not.toBeNull();
  });

  it("shows Primary barcode + Aliases + Mark wrong to the platformOwner", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1"; // platformOwner
    seed();
    render(<FinalCountTable />);
    expect(screen.queryByText("Primary barcode")).not.toBeNull();
    expect(screen.queryByText("Aliases")).not.toBeNull();
    expect(screen.queryAllByText(/111222333444/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("mark-wrong-p1")).not.toBeNull();
  });
});
