import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionCountsTable, type SessionCountRow } from "@/sessions/SessionCountsTable";
import { countsFromTimeline } from "@/sessions/history/countsFromTimeline";
import type { Product, ScanEvent } from "@/types";

function makeProduct(over: Partial<Product>): Product {
  return {
    id: "p1", businessId: "b", name: "Michelin Defender LTX M/S", brand: "Michelin", category: "Tires",
    specsShort: "245/70R16 107T", specsFull: "", primarySku: "MICH-DEF-2457016", primaryBarcode: "086699205636",
    gtin: "", upc: "", ean: "", vendorCodes: [], aliases: [], imageUrl: "", productUrl: "",
    location: "Bay A", notes: "", status: "active", source: "human_review", confidence: 1, verified: true,
    createdAt: "", updatedAt: "", createdBy: "human", updatedBy: "human",
    ...over,
  } as Product;
}

const resolvedRow: SessionCountRow = {
  id: "r1",
  code: "086699205636",
  quantity: 3,
  product: makeProduct({}),
  location: "Bay A",
  lastScannedAt: "2026-07-22T10:00:00.000Z",
};

const unresolvedRow: SessionCountRow = {
  id: "r2",
  code: "999888777666",
  quantity: 5,
};

const rows: SessionCountRow[] = [resolvedRow, unresolvedRow];

afterEach(() => {
  cleanup();
  delete process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER;
});

describe("SessionCountsTable columns (owner: same spreadsheet as Your Counts, read-only)", () => {
  it("renders the FinalCountTable column set in order, minus Sync and Actions", () => {
    render(<SessionCountsTable rows={rows} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual([
      "Qty", "Product", "Brand", "Model", "Category", "Specs", "Size",
      "Part number", "Barcode", "Location", "Last scanned", "Status",
    ]);
    expect(screen.queryByText("Sync")).toBeNull();
    expect(screen.queryByText("Actions")).toBeNull();
  });

  it("switches the Part number header to SKU for the platformOwner and shows Other codes scanned only when alias data exists", () => {
    process.env.NEXT_PUBLIC_E2E_PLATFORM_OWNER = "1";
    // No row carries aliasesSeen (past-session shape): the alias column must be omitted entirely.
    render(<SessionCountsTable rows={rows} />);
    expect(screen.getByText("SKU")).not.toBeNull();
    expect(screen.queryByText("Part number")).toBeNull();
    expect(screen.queryByText("Other codes scanned")).toBeNull();

    cleanup();

    // Current-session shape carries aliasesSeen: the column renders with its data.
    render(
      <SessionCountsTable rows={[{ ...resolvedRow, aliasesSeen: ["086699205636", "ALT-CODE-9"] }]} />,
    );
    expect(screen.getByText("Other codes scanned")).not.toBeNull();
    expect(screen.getAllByText(/ALT-CODE-9/).length).toBeGreaterThan(0);
  });
});

describe("SessionCountsTable rows", () => {
  it("renders a resolvable row's product fields, quantity, and the total units summary", () => {
    render(<SessionCountsTable rows={rows} />);

    expect(screen.getByText("Michelin Defender LTX M/S")).not.toBeNull();
    expect(screen.getByTestId("session-count-qty-r1").textContent).toBe("3");
    expect(screen.getByTestId("session-count-brand-r1").textContent).toBe("Michelin");
    expect(screen.getByTestId("session-count-size-r1").textContent?.trim()).toBe("245/70R16");
    expect(screen.getByTestId("session-count-barcode-r1").textContent).toBe("086699205636");
    const row = screen.getByTestId("session-count-row-r1");
    expect(row.textContent).toMatch(/Tires/);
    expect(row.textContent).toMatch(/MICH-DEF-2457016/);
    expect(row.textContent).toMatch(/Bay A/);
    // Status badge for a verified product
    expect(row.querySelector('[data-testid="decode-row-status"]')?.textContent).toBe("Verified match");
    // Total units summary: 3 + 5 = 8
    expect(screen.getByTestId("session-counts-total").textContent).toMatch(/^8 total units/);
  });

  it("shows the clean code in Product/Barcode and honest '-' cells for an unresolvable row", () => {
    render(<SessionCountsTable rows={rows} />);

    const row = screen.getByTestId("session-count-row-r2");
    // Product cell falls back to the scanned clean code; Barcode shows it too.
    expect(row.textContent).toContain("999888777666");
    expect(screen.getByTestId("session-count-barcode-r2").textContent).toBe("999888777666");
    // Honest empty cells for the product-derived columns - no fabricated values.
    expect(screen.getByTestId("session-count-brand-r2").textContent).toBe("-");
    expect(screen.getByTestId("session-count-model-r2").textContent).toBe("-");
    expect(screen.getByTestId("session-count-size-r2").textContent?.trim()).toBe("-");
    expect(row.querySelector('[data-testid="decode-row-status"]')).toBeNull();
    expect(screen.getByTestId("session-count-qty-r2").textContent).toBe("5");
  });
});

describe("SessionCountsTable search", () => {
  it("filters rows by product name substring, case-insensitively", () => {
    render(<SessionCountsTable rows={rows} />);

    fireEvent.change(screen.getByTestId("session-counts-filter"), { target: { value: "michelin" } });

    expect(screen.queryByTestId("session-count-row-r1")).not.toBeNull();
    expect(screen.queryByTestId("session-count-row-r2")).toBeNull();
  });

  it("filters rows by code substring, case-insensitively", () => {
    render(<SessionCountsTable rows={rows} />);

    fireEvent.change(screen.getByTestId("session-counts-filter"), { target: { value: "999888" } });

    expect(screen.queryByTestId("session-count-row-r1")).toBeNull();
    expect(screen.queryByTestId("session-count-row-r2")).not.toBeNull();
  });

  it("shows an honest empty state when there are no counts in the session", () => {
    render(<SessionCountsTable rows={[]} />);

    expect(screen.getByText("No counts in this session.")).not.toBeNull();
  });

  it("shows a distinct message when a search matches nothing", () => {
    render(<SessionCountsTable rows={rows} />);

    fireEvent.change(screen.getByTestId("session-counts-filter"), { target: { value: "zzz-no-match" } });

    expect(screen.getByText("No products match this search.")).not.toBeNull();
  });
});

// Past-session rows are derived from the timeline (SyncTarget has no counts read). When an event's
// matchedProductId resolves via the store's getProduct, the row must carry the full product; only
// an unresolvable product falls back to the event's cleanCode alone.
describe("countsFromTimeline product join", () => {
  const knownEvent = (over: Partial<ScanEvent>): ScanEvent =>
    ({
      id: "e", businessId: "b", sessionId: "s", rawCode: "111", cleanCode: "111",
      normalizedCandidates: [], matchedProductId: null, matchType: "barcode", status: "known",
      resolverStatus: "known", codeType: "upc", reason: "", quantityDelta: 1, quantityAfterScan: 1,
      createdAt: "2026-07-22T10:00:00.000Z", source: "scan", notes: "", syncStatus: "synced",
      ...over,
    }) as ScanEvent;

  it("attaches the store product when matchedProductId resolves, and leaves it undefined when it does not", () => {
    const storeProduct = makeProduct({ id: "p1" });
    const getProduct = (id: string | null) => (id === "p1" ? storeProduct : undefined);

    const rowsOut = countsFromTimeline(
      [
        knownEvent({ id: "e1", cleanCode: "086699205636", matchedProductId: "p1", quantityAfterScan: 4 }),
        knownEvent({ id: "e2", cleanCode: "999888777666", matchedProductId: "p-gone", quantityAfterScan: 2 }),
      ],
      getProduct,
    );

    const resolved = rowsOut.find((r) => r.id === "p1");
    expect(resolved?.product?.name).toBe("Michelin Defender LTX M/S");
    expect(resolved?.code).toBe("086699205636");
    expect(resolved?.quantity).toBe(4);

    const unresolved = rowsOut.find((r) => r.id === "p-gone");
    expect(unresolved?.product).toBeUndefined(); // honest: no fabricated identity
    expect(unresolved?.code).toBe("999888777666");
    expect(unresolved?.quantity).toBe(2);
  });

  it("keeps human-resolved scan events in past-session timeline counts", () => {
    const storeProduct = makeProduct({ id: "p1" });
    const getProduct = (id: string | null) => (id === "p1" ? storeProduct : undefined);

    const rowsOut = countsFromTimeline(
      [
        knownEvent({
          id: "e1",
          cleanCode: "086699205636",
          matchedProductId: "p1",
          quantityAfterScan: 1,
          createdAt: "2026-07-22T10:00:00.000Z",
        }),
        knownEvent({
          id: "e2",
          cleanCode: "086699205636",
          matchedProductId: "p1",
          status: "resolved",
          quantityAfterScan: 2,
          createdAt: "2026-07-22T10:01:00.000Z",
        }),
      ],
      getProduct,
    );

    expect(rowsOut).toHaveLength(1);
    expect(rowsOut[0]?.id).toBe("p1");
    expect(rowsOut[0]?.quantity).toBe(2);
    expect(rowsOut[0]?.product?.name).toBe("Michelin Defender LTX M/S");
  });

  it("counts unresolved historical events by their latest quantityAfterScan", () => {
    const getProduct = () => undefined;

    const rowsOut = countsFromTimeline(
      [
        knownEvent({
          id: "unknown-old",
          cleanCode: "UNKNOWN-ROW",
          status: "unknown",
          resolverStatus: "needs_review",
          matchedProductId: null,
          quantityAfterScan: 1,
          createdAt: "2026-07-22T10:00:00.000Z",
        }),
        knownEvent({
          id: "unknown-latest",
          cleanCode: "UNKNOWN-ROW",
          status: "unknown",
          resolverStatus: "needs_review",
          matchedProductId: null,
          quantityAfterScan: 3,
          createdAt: "2026-07-22T10:01:00.000Z",
        }),
        knownEvent({
          id: "needs-review",
          cleanCode: "NEEDS-REVIEW-ROW",
          status: "needs_review",
          resolverStatus: "needs_review",
          matchedProductId: null,
          quantityAfterScan: 4,
        }),
        knownEvent({
          id: "suggested-inline",
          cleanCode: "SUGGESTED-ROW",
          status: "needs_review",
          resolverStatus: "suggested",
          decodeStatus: "suggested",
          suggestion: { productName: "Suggested item", brand: "Suggested", confidence: 0.72, status: "pending" },
          matchedProductId: null,
          quantityAfterScan: 2,
        }),
        knownEvent({
          id: "missing-product",
          cleanCode: "MISSING-PRODUCT-ROW",
          matchedProductId: "p-missing",
          quantityAfterScan: 7,
        }),
      ],
      getProduct,
    );

    expect(rowsOut).toHaveLength(4);
    expect(rowsOut.find((r) => r.id === "UNKNOWN-ROW")?.quantity).toBe(3);
    expect(rowsOut.find((r) => r.id === "NEEDS-REVIEW-ROW")?.quantity).toBe(4);
    expect(rowsOut.find((r) => r.id === "SUGGESTED-ROW")?.quantity).toBe(2);
    expect(rowsOut.find((r) => r.id === "p-missing")?.quantity).toBe(7);
    expect(rowsOut.find((r) => r.id === "p-missing")?.product).toBeUndefined();
  });

  // PR #43 review defect: removing the status filter let stale backend docs pollute archived-session
  // tables. Two classes stay excluded: (1) "conflict" events - the alias-conflict orphan machinery
  // transfers their full quantity onto the chosen product, so rendering them double-counts; (2) events
  // with no finite quantityAfterScan - they cannot assert a running total and would emit or override
  // rows with 0/undefined. Unknown/needs_review rows keep counting (the fix this PR shipped).
  it("excludes conflict events and events without a finite quantityAfterScan", () => {
    const getProduct = () => undefined;

    const rowsOut = countsFromTimeline(
      [
        knownEvent({
          id: "good-old",
          cleanCode: "CODE-A",
          matchedProductId: null,
          status: "needs_review",
          quantityAfterScan: 2,
          createdAt: "2026-07-22T10:00:00.000Z",
        }),
        // Later conflict marking of the same key must not override the good running count.
        knownEvent({
          id: "conflict-late",
          cleanCode: "CODE-A",
          matchedProductId: null,
          status: "conflict",
          quantityAfterScan: 5,
          createdAt: "2026-07-22T10:05:00.000Z",
        }),
        // A conflict-only key emits no row at all (its quantity lives on the transfer target).
        knownEvent({
          id: "conflict-only",
          cleanCode: "CODE-B",
          matchedProductId: "p-orphan",
          status: "conflict",
          quantityAfterScan: 3,
          createdAt: "2026-07-22T10:06:00.000Z",
        }),
        // A stale doc with no quantityAfterScan must not override the older good row with undefined.
        knownEvent({
          id: "no-quantity-late",
          cleanCode: "CODE-C",
          matchedProductId: null,
          status: "needs_review",
          quantityAfterScan: undefined as unknown as number,
          createdAt: "2026-07-22T10:07:00.000Z",
        }),
        knownEvent({
          id: "good-c",
          cleanCode: "CODE-C",
          matchedProductId: null,
          status: "unknown",
          quantityAfterScan: 4,
          createdAt: "2026-07-22T10:02:00.000Z",
        }),
      ],
      getProduct,
    );

    expect(rowsOut.find((r) => r.id === "CODE-A")?.quantity).toBe(2);
    expect(rowsOut.find((r) => r.id === "p-orphan")).toBeUndefined();
    expect(rowsOut.find((r) => r.id === "CODE-C")?.quantity).toBe(4);
    expect(rowsOut).toHaveLength(2);
  });

  it("rendering timeline-derived rows shows the resolved product name and the cleanCode fallback for the unresolved one", () => {
    const storeProduct = makeProduct({ id: "p1" });
    const getProduct = (id: string | null) => (id === "p1" ? storeProduct : undefined);
    const rowsOut = countsFromTimeline(
      [
        knownEvent({ id: "e1", cleanCode: "086699205636", matchedProductId: "p1", quantityAfterScan: 4 }),
        knownEvent({ id: "e2", cleanCode: "999888777666", matchedProductId: "p-gone", quantityAfterScan: 2 }),
      ],
      getProduct,
    );
    render(<SessionCountsTable rows={rowsOut} />);

    expect(screen.getByText("Michelin Defender LTX M/S")).not.toBeNull();
    expect(screen.getByTestId("session-count-brand-p1").textContent).toBe("Michelin");
    expect(screen.getByTestId("session-count-barcode-p-gone").textContent).toBe("999888777666");
    expect(screen.getByTestId("session-count-brand-p-gone").textContent).toBe("-");
  });
});
