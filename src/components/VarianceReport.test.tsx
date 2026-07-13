import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useScanStore } from "@/stores/scanStore";
import { VarianceReport } from "@/components/VarianceReport";
import type { CountSnapshot } from "@/services/reports/varianceReport";
import type { Product, InventoryCount } from "@/types";

// SDD Task 3.5: "Save count snapshot" button + compare view (two dropdowns, variance table, CSV
// export). Product-facing fields only (name + quantities) - no barcode/cleanCode/matchType/provider
// columns, matching the customer-data-firewall convention already used by FinalCountTable/ExportMenu.

vi.mock("@/services/exportFormats", () => ({
  downloadCsv: vi.fn(),
}));

import { downloadCsv } from "@/services/exportFormats";

const product: Product = {
  id: "p1", businessId: "b", name: "Test Widget", brand: "Acme", category: "Tools",
  specsShort: "", specsFull: "", primarySku: "SKU1", primaryBarcode: "111222333444", gtin: "", upc: "", ean: "",
  vendorCodes: [], aliases: ["111222333444"], imageUrl: "", productUrl: "", location: "A1", notes: "",
  status: "active", source: "human_review", confidence: 1, verified: true,
  createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
};
const finalCount: InventoryCount = {
  id: "c1", businessId: "b", sessionId: "s", productId: "p1", quantity: 5, lastScannedAt: "",
  aliasesSeen: ["111222333444"], scanEventIds: [], createdAt: "", updatedAt: "",
  syncStatus: "synced", syncError: null, appliedIdempotencyKeys: [],
};

const snapA: CountSnapshot = {
  id: "snap-a", label: "Morning count", takenAt: "2026-07-12T08:00:00.000Z",
  lines: [{ productId: "p1", name: "Test Widget", qty: 10 }],
};
const snapB: CountSnapshot = {
  id: "snap-b", label: "Evening count", takenAt: "2026-07-12T18:00:00.000Z",
  lines: [{ productId: "p1", name: "Test Widget", qty: 7 }],
};

function seed(overrides: Partial<ReturnType<typeof useScanStore.getState>> = {}) {
  useScanStore.setState({
    products: [product],
    finalCounts: [finalCount],
    countSnapshots: [],
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
});

describe("VarianceReport - Save count snapshot", () => {
  it("renders a Save count snapshot button", () => {
    seed();
    render(<VarianceReport />);
    expect(screen.getByTestId("save-count-snapshot")).toBeInTheDocument();
  });

  it("clicking Save count snapshot calls snapshotCount and adds a snapshot", () => {
    seed();
    render(<VarianceReport />);
    fireEvent.click(screen.getByTestId("save-count-snapshot"));
    expect(useScanStore.getState().countSnapshots).toHaveLength(1);
    expect(useScanStore.getState().countSnapshots[0].lines).toEqual([
      { productId: "p1", name: "Test Widget", qty: 5 },
    ]);
  });
});

describe("VarianceReport - empty state", () => {
  it("shows a sensible message when fewer than 2 snapshots exist", () => {
    seed({ countSnapshots: [snapA] });
    render(<VarianceReport />);
    expect(screen.getByTestId("variance-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("variance-table")).not.toBeInTheDocument();
  });

  it("shows the empty state with zero snapshots too", () => {
    seed({ countSnapshots: [] });
    render(<VarianceReport />);
    expect(screen.getByTestId("variance-empty-state")).toBeInTheDocument();
  });
});

describe("VarianceReport - compare view", () => {
  it("populates both dropdowns from countSnapshots and renders variance rows once two are selected", () => {
    seed({ countSnapshots: [snapA, snapB] });
    render(<VarianceReport />);

    fireEvent.change(screen.getByLabelText(/compare from/i), { target: { value: "snap-a" } });
    fireEvent.change(screen.getByLabelText(/compare to/i), { target: { value: "snap-b" } });

    const table = screen.getByTestId("variance-table");
    expect(table).toBeInTheDocument();
    expect(screen.getByText("Test Widget")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument(); // previous qty
    expect(screen.getByText("7")).toBeInTheDocument(); // current qty
    expect(screen.getByText("-3")).toBeInTheDocument(); // signed delta
  });

  it("shows a positive delta with a leading plus sign", () => {
    seed({ countSnapshots: [snapB, snapA] }); // reversed order: from evening(7) to morning(10)
    render(<VarianceReport />);
    fireEvent.change(screen.getByLabelText(/compare from/i), { target: { value: "snap-b" } });
    fireEvent.change(screen.getByLabelText(/compare to/i), { target: { value: "snap-a" } });
    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("does not render barcode, cleanCode, matchType, or provider columns (customer data firewall)", () => {
    seed({ countSnapshots: [snapA, snapB] });
    render(<VarianceReport />);
    fireEvent.change(screen.getByLabelText(/compare from/i), { target: { value: "snap-a" } });
    fireEvent.change(screen.getByLabelText(/compare to/i), { target: { value: "snap-b" } });
    const table = screen.getByTestId("variance-table");
    expect(table.textContent).not.toMatch(/111222333444/);
    for (const forbidden of ["Barcode", "Clean code", "Match type", "Provider"]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }
  });
});

describe("VarianceReport - CSV export", () => {
  it("triggers CSV download when both snapshots are selected and export is clicked", () => {
    seed({ countSnapshots: [snapA, snapB] });
    render(<VarianceReport />);
    fireEvent.change(screen.getByLabelText(/compare from/i), { target: { value: "snap-a" } });
    fireEvent.change(screen.getByLabelText(/compare to/i), { target: { value: "snap-b" } });
    fireEvent.click(screen.getByTestId("export-variance-csv"));
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [csv, filenameBase] = vi.mocked(downloadCsv).mock.calls[0];
    expect(csv).toContain("Test Widget");
    expect(typeof filenameBase).toBe("string");
  });

  it("export button is disabled until two snapshots are selected", () => {
    seed({ countSnapshots: [snapA, snapB] });
    render(<VarianceReport />);
    expect(screen.getByTestId("export-variance-csv")).toBeDisabled();
  });
});
