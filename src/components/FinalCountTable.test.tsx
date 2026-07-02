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
  it("hides Barcode + Other codes scanned (and the raw codes) from a business/customer role", () => {
    delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER; // business / customer
    seed();
    render(<FinalCountTable />);
    expect(screen.getByText("Test Widget")).toBeTruthy(); // product IS visible
    expect(screen.queryByText("Barcode")).toBeNull();
    expect(screen.queryByText("Other codes scanned")).toBeNull();
    expect(screen.queryAllByText(/111222333444/).length).toBe(0); // raw barcode not leaked
    expect(screen.queryAllByText(/ALT-CODE-9/).length).toBe(0); // alias DB not leaked
    // Mark wrong (destructive alias repair) is platformOwner-only
    expect(screen.queryByTestId("mark-wrong-p1")).toBeNull();
    // product-facing correction controls remain available
    expect(screen.queryByTestId("correct-p1")).not.toBeNull();
    expect(screen.queryByTestId("remove-count-p1")).not.toBeNull();
  });

  it("removes the Image column and shows a plain-number Size column for a tire (owner request)", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    const tire: Product = { ...product, id: "p2", name: "Michelin Latitude Tour HP", specsShort: "255/55R19 111 V" };
    const tcount: InventoryCount = { ...count, id: "c2", productId: "p2" };
    useScanStore.setState({ products: [tire], finalCounts: [tcount] });
    render(<FinalCountTable />);
    expect(screen.queryByText("Image")).toBeNull(); // image column removed
    expect(screen.queryByText("Size")).not.toBeNull(); // plain-number size column present
    expect(screen.getByTestId("size-p2").textContent?.trim()).toBe("2555519"); // size only, no letters/slashes/spaces
  });

  it("shows Barcode + Other codes scanned to the platformOwner (Mark wrong hidden for now)", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1"; // platformOwner
    seed();
    render(<FinalCountTable />);
    expect(screen.queryByText("Barcode")).not.toBeNull();
    expect(screen.queryByText("Other codes scanned")).not.toBeNull();
    expect(screen.queryAllByText(/111222333444/).length).toBeGreaterThan(0);
    // Owner request: row is simplified to Modify + Delete; Mark wrong + hard product-delete are hidden
    // behind SHOW_ADVANCED_ACTIONS (code kept). The two core controls remain.
    expect(screen.queryByTestId("mark-wrong-p1")).toBeNull();
    expect(screen.queryByTestId("correct-p1")).not.toBeNull(); // Modify
    expect(screen.queryByTestId("remove-count-p1")).not.toBeNull(); // Delete
  });
});
