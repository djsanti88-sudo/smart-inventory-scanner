import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  push: vi.fn(),
  accessLevel: "platform" as "platform" | "business",
  downloadCsv: vi.fn(),
  getSessionCounts: vi.fn(() => [] as Array<{ businessId: string; sessionId: string; productId: string; quantity: number; scanEventIds: string[]; appliedIdempotencyKeys: string[] }>),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

vi.mock("@/stores/scanStore", () => ({
  useScanStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.storeState),
}));

vi.mock("@/services/security/useAccessLevel", () => ({
  useAccessLevel: () => mocks.accessLevel,
}));

vi.mock("@/services/mockDb", () => ({
  getMockDb: () => ({ getSessionCounts: mocks.getSessionCounts }),
}));

vi.mock("@/services/exportFormats", () => ({
  downloadCsv: (...args: unknown[]) => mocks.downloadCsv(...args),
}));

// exportSessionCounts is NOT mocked - the CSV-content assertions below exercise the real function
// so the test proves the actual header row and cell values, not a stand-in.
import HistoryPage from "./page";

function session(over: Record<string, unknown>) {
  return {
    id: "s1",
    businessId: "b1",
    name: "Session 1",
    location: "Front",
    status: "active",
    startedAt: "2026-07-20T15:30:00.000Z",
    completedAt: null,
    createdBy: "u1",
    notes: "",
    syncStatus: "synced",
    ...over,
  };
}

beforeEach(() => {
  mocks.accessLevel = "platform";
  mocks.push.mockClear();
  mocks.downloadCsv.mockClear();
  mocks.getSessionCounts.mockReset();
  mocks.getSessionCounts.mockReturnValue([]);
  delete process.env.NEXT_PUBLIC_FIREBASE_BACKEND;
});

afterEach(() => {
  cleanup();
});

describe("HistoryPage", () => {
  it("shows the empty state when there are no sessions", () => {
    mocks.storeState = {
      businessId: "b1",
      currentSession: null,
      sessions: [],
      listSessions: () => [],
      finalCounts: [],
      products: [],
    };
    render(<HistoryPage />);
    expect(screen.getByTestId("history-empty")).toBeInTheDocument();
  });

  it("renders newest-first with date/hour/units/products/status for the active session using live finalCounts", () => {
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-21T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1, s2],
      finalCounts: [
        { sessionId: "s1", productId: "p1", quantity: 2 },
        { sessionId: "s1", productId: "p2", quantity: 1 },
      ],
      products: [],
    };
    mocks.getSessionCounts.mockReturnValue([
      { businessId: "b1", sessionId: "s2", productId: "p3", quantity: 5, scanEventIds: [], appliedIdempotencyKeys: [] },
    ]);
    render(<HistoryPage />);

    const rows = screen.getAllByTestId(/^history-row-/);
    expect(rows[0]).toHaveAttribute("data-testid", "history-row-s2"); // newest first (later startedAt)
    expect(rows[1]).toHaveAttribute("data-testid", "history-row-s1");

    // Active session numbers come from live finalCounts: units 3, distinct 2.
    expect(screen.getByTestId("history-units-s1")).toHaveTextContent("3");
    expect(screen.getByTestId("history-products-s1")).toHaveTextContent("2");
  });

  it("clicking a row (not the download button) navigates to the session detail page", () => {
    const s1 = session({ id: "s1" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1],
      finalCounts: [],
      products: [],
    };
    render(<HistoryPage />);
    fireEvent.click(screen.getByTestId("history-row-s1"));
    expect(mocks.push).toHaveBeenCalledWith("/sessions/s1");
  });

  const resolvedProduct = {
    id: "p1",
    name: "Michelin Defender T+H",
    brand: "Michelin",
    category: "Tire",
    specsShort: "205/55R16",
    specsFull: "205/55R16",
    primarySku: "MICH-DEF-2055516",
    primaryBarcode: "086699998538",
    location: "Bay A",
    verified: true,
    provisional: false,
  } as unknown as import("@/types").Product;

  it("downloads a CSV with the full home-table column set, in order, for the platform role", () => {
    const s1 = session({ id: "s1" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1],
      finalCounts: [
        { sessionId: "s1", productId: "p1", quantity: 3, aliasesSeen: [], lastScannedAt: "2026-07-20T10:00:00.000Z" },
        // Unresolvable row: no matching product (e.g. orphaned/deleted). Its scanned code is the
        // only honest identity available, via aliasesSeen.
        { sessionId: "s1", productId: "ghost", quantity: 1, aliasesSeen: ["UNKNOWN999"], lastScannedAt: "2026-07-20T10:05:00.000Z" },
      ],
      products: [resolvedProduct],
    };
    mocks.accessLevel = "platform";
    render(<HistoryPage />);
    fireEvent.click(screen.getByTestId("history-download-s1"));

    expect(mocks.downloadCsv).toHaveBeenCalledTimes(1);
    const [csv, filenameBase] = mocks.downloadCsv.mock.calls[0] as [string, string];
    expect(filenameBase).toBe("session-s1-counts");
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("qty,product,brand,model,category,specs,size,sku,barcode,location,last_scanned,status");
    expect(lines[1]).toBe("3,Michelin Defender T+H,Michelin,,Tire,205/55R16,205/55R16,MICH-DEF-2055516,086699998538,Bay A,2026-07-20T10:00:00.000Z,verified");
    // Unresolvable row: product/barcode fall back to the scanned code; everything else blank.
    expect(lines[2]).toBe("1,UNKNOWN999,,,,,,,UNKNOWN999,,2026-07-20T10:05:00.000Z,");

    // Row click must not have also fired from the download button click.
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("uses 'part_number' instead of 'sku' in the header at business access (matches the home table's isPlatform switch)", () => {
    const s1 = session({ id: "s1" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1],
      finalCounts: [{ sessionId: "s1", productId: "p1", quantity: 1, aliasesSeen: [], lastScannedAt: "" }],
      products: [resolvedProduct],
    };
    mocks.accessLevel = "business";
    render(<HistoryPage />);
    fireEvent.click(screen.getByTestId("history-download-s1"));
    const [csv] = mocks.downloadCsv.mock.calls[0] as [string, string];
    const header = csv.replace(/^﻿/, "").split("\r\n")[0];
    expect(header).toBe("qty,product,brand,model,category,specs,size,part_number,barcode,location,last_scanned,status");
  });

  it("disables the download button when a session has zero counted rows", () => {
    const s1 = session({ id: "s1" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1],
      finalCounts: [],
      products: [],
    };
    render(<HistoryPage />);
    expect(screen.getByTestId("history-download-s1")).toBeDisabled();
  });

  it("shows n/a for a past mock session before its counts have loaded, then resolves to real numbers (never a fake 0 while still loading)", async () => {
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-19T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1, s2],
      finalCounts: [],
      products: [],
    };
    mocks.getSessionCounts.mockReturnValue([
      { businessId: "b1", sessionId: "s2", productId: "p3", quantity: 5, scanEventIds: [], appliedIdempotencyKeys: [] },
    ]);
    render(<HistoryPage />);
    // Synchronously (before the effect's async fetch resolves), the honest state is n/a, not 0.
    expect(screen.getByTestId("history-units-s2")).toHaveTextContent("n/a");
    // Once the mock fetch resolves, the real number replaces it.
    await screen.findByText("5");
    expect(screen.getByTestId("history-units-s2")).toHaveTextContent("5");
  });

  it("cloud backend: past-session counts read from the store's refreshed finalCounts (n/a only if truly never refreshed)", () => {
    process.env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-19T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [s1, s2],
      listSessions: () => [s1, s2],
      finalCounts: [{ sessionId: "s2", productId: "p9", quantity: 4 }],
      products: [],
    };
    render(<HistoryPage />);
    expect(screen.getByTestId("history-units-s2")).toHaveTextContent("4");
  });
});
