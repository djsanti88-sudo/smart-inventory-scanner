import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { FinalCountTable, COUNTS_RENDER_WINDOW, COUNTS_RENDER_CHUNK } from "@/components/FinalCountTable";
import type { InventoryCount, Product } from "@/types";

// DEFECT #29/#37 residual (live-reproduced 2026-08-05/06, canelo round 2): after the Map-lookup fix,
// a fresh-device restore with ~1,800 count rows still mounts them ALL into the DOM synchronously,
// contributing to the ~30s renderer freeze. This suite proves the counts table windows its render the
// same way the feed does: a bounded number of rows mount (sorted as today, by quantity descending),
// an honest summary row states the hidden-row count, "Show more" expands it, and the header total
// ("N of M products") always reflects the FULL filtered set, never the rendered window.
function makeRowsFixtures(n: number): { products: Product[]; counts: InventoryCount[] } {
  const products: Product[] = Array.from({ length: n }, (_, i) => ({
    id: `p-${i}`,
    businessId: "b",
    name: `Widget ${i}`,
    brand: "Acme",
    category: "Tools",
    specsShort: "",
    specsFull: "",
    primarySku: `SKU-${i}`,
    primaryBarcode: `${1000000000000 + i}`,
    gtin: "",
    upc: "",
    ean: "",
    vendorCodes: [],
    aliases: [],
    imageUrl: "",
    productUrl: "",
    location: "",
    notes: "",
    status: "active",
    source: "human_review",
    confidence: 1,
    verified: true,
    createdAt: "",
    updatedAt: "",
    createdBy: "human",
    updatedBy: "human",
  })) as unknown as Product[];
  const counts: InventoryCount[] = products.map((p, i) => ({
    id: `c-${i}`,
    businessId: "b",
    sessionId: "session-1",
    productId: p.id,
    quantity: n - i, // distinct quantities so sort order is deterministic
    lastScannedAt: "",
    aliasesSeen: [],
    scanEventIds: [],
    createdAt: "",
    updatedAt: "",
    syncStatus: "synced",
    syncError: null,
    appliedIdempotencyKeys: [],
  }));
  return { products, counts };
}

afterEach(() => {
  cleanup();
  useScanStore.setState({ products: [], finalCounts: [], currentSession: null });
});

describe("FinalCountTable windowing (defect #29/#37 residual, ~1,800-row freeze)", () => {
  it("mounts only a bounded window of DOM rows even when there are 1,000 count rows", () => {
    const { products, counts } = makeRowsFixtures(1000);
    useScanStore.setState({ products, finalCounts: counts });

    render(<FinalCountTable />);

    const body = screen.getByTestId("final-count-body");
    const dataRows = within(body).getAllByTestId(/^count-row-/);
    expect(dataRows.length).toBeLessThanOrEqual(COUNTS_RENDER_WINDOW);
    expect(dataRows.length).toBeGreaterThan(0);
  });

  it("the header total still reflects ALL filtered rows, not just the rendered window", () => {
    const n = 1000;
    const { products, counts } = makeRowsFixtures(n);
    useScanStore.setState({ products, finalCounts: counts });

    render(<FinalCountTable />);

    expect(screen.getByText(`${n} of ${n} products`)).toBeInTheDocument();
  });

  it("shows an honest hidden-row count in the summary row", () => {
    const n = 1000;
    const { products, counts } = makeRowsFixtures(n);
    useScanStore.setState({ products, finalCounts: counts });

    render(<FinalCountTable />);

    const summary = screen.getByTestId("counts-hidden-summary");
    expect(summary.textContent).toContain(String(n - COUNTS_RENDER_WINDOW));
  });

  it("keeps sort order (highest quantity first) among the rendered window", () => {
    const { products, counts } = makeRowsFixtures(1000);
    useScanStore.setState({ products, finalCounts: counts });

    render(<FinalCountTable />);

    // Highest quantity is p-0 (quantity n), so it must be the first rendered row.
    expect(screen.getByTestId("qty-p-0")).toBeInTheDocument();
    expect(screen.queryByTestId(`qty-p-${COUNTS_RENDER_WINDOW}`)).not.toBeInTheDocument();
  });

  it("Show more expands the window by COUNTS_RENDER_CHUNK and shrinks the hidden count", () => {
    const n = 1000;
    const { products, counts } = makeRowsFixtures(n);
    useScanStore.setState({ products, finalCounts: counts });

    render(<FinalCountTable />);

    fireEvent.click(screen.getByTestId("counts-show-more"));

    const body = screen.getByTestId("final-count-body");
    const dataRows = within(body).getAllByTestId(/^count-row-/);
    expect(dataRows.length).toBe(COUNTS_RENDER_WINDOW + COUNTS_RENDER_CHUNK);

    const summary = screen.getByTestId("counts-hidden-summary");
    expect(summary.textContent).toContain(String(n - (COUNTS_RENDER_WINDOW + COUNTS_RENDER_CHUNK)));
  });

  it("does not render the summary row when the filtered set fits inside the window", () => {
    const { products, counts } = makeRowsFixtures(10);
    useScanStore.setState({ products, finalCounts: counts });

    render(<FinalCountTable />);

    expect(screen.queryByTestId("counts-hidden-summary")).not.toBeInTheDocument();
  });
});
