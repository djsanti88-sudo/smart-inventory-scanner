import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { ExportMenu } from "@/components/ExportMenu";
import type { InventoryCount, Product } from "@/types";

vi.mock("@/services/exportFormats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/exportFormats")>();
  return { ...actual, downloadCsv: vi.fn() };
});
import { downloadCsv } from "@/services/exportFormats";

// M2 regression (Phase 3 follow-up): same leak class as F2 (FinalCountTable). refreshFromCloud
// intentionally does an ADDITIVE cross-session merge into the store's finalCounts (a tested
// cross-device sync path - see refreshFromCloud.store.test.ts). ExportMenu must export only the
// CURRENT session's counts, not every session's counts merged into the store.

const product: Product = {
  id: "p1", businessId: "b", name: "Test Widget", brand: "Acme", category: "Tools",
  specsShort: "", specsFull: "", primarySku: "SKU1", primaryBarcode: "111222333444", gtin: "", upc: "", ean: "",
  vendorCodes: [], aliases: ["111222333444"], imageUrl: "", productUrl: "", location: "A1", notes: "",
  status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};
// sessionId matches the scanStore's default currentSession.id ("session-1", see scanStore.ts) so this
// fixture represents a count in the CURRENT session; the other-session fixture below proves exclusion.
const count: InventoryCount = {
  id: "c1", businessId: "b", sessionId: "session-1", productId: "p1", quantity: 5, lastScannedAt: "",
  aliasesSeen: ["111222333444"], scanEventIds: [], createdAt: "", updatedAt: "",
  syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
};

afterEach(() => {
  cleanup();
  delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
});

describe("ExportMenu session scoping (M2, same leak class as F2)", () => {
  it("exports only the current session's counts after a simulated cross-session merge", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1"; // platform role exposes exportFinalCounts (has session/barcode detail)
    const otherSessionProduct: Product = { ...product, id: "pOther", name: "Other Session Widget", primaryBarcode: "999888777666" };
    const otherSessionCount: InventoryCount = {
      ...count,
      id: "cOther",
      sessionId: "other-session-id", // merged in from another device's session by refreshFromCloud
      productId: "pOther",
      quantity: 7,
    };
    useScanStore.setState({
      products: [product, otherSessionProduct],
      finalCounts: [count, otherSessionCount],
      currentSession: {
        id: "session-1",
        businessId: "b",
        name: "Default Session",
        location: "Main",
        status: "active",
        startedAt: "",
        completedAt: null,
        createdBy: "demo",
        notes: "",
        syncStatus: "synced",
      },
    });

    render(<ExportMenu />);
    fireEvent.click(screen.getByTestId("export-menu-trigger"));
    // Dataset row count reflects only the current session's counts, not the merged total (2).
    const label = screen.getByText("Final counts").closest("span[title]");
    expect(label?.getAttribute("title")).toBe("Final counts (1)");

    // The exported CSV itself must also exclude the other-session row.
    fireEvent.click(screen.getByTestId("export-final-counts"));
    const csv = vi.mocked(downloadCsv).mock.calls[0][0];
    expect(csv).toContain("Test Widget");
    expect(csv).not.toContain("Other Session Widget");
  });
});
