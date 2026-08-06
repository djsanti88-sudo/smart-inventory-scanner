import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  push: vi.fn(),
  accessLevel: "platform" as "platform" | "business",
  liveAuth: false,
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

vi.mock("@/services/auth/authMode", () => ({
  isLiveAuth: () => mocks.liveAuth,
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
  mocks.liveAuth = false;
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

  // Owner feature (2026-07-22): sessions auto-save. A past session's numbers come from its archived
  // sessionHistory entry - synchronously, no data-source fetch, surviving a mock-DB reset.
  it("a past session with an auto-saved archive shows the archive's units/products immediately (no n/a, no mock fetch)", () => {
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-19T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1, s2],
      finalCounts: [],
      products: [],
      sessionHistory: [
        {
          sessionId: "s2",
          startedAt: "2026-07-19T10:00:00.000Z",
          endedAt: "2026-07-19T11:00:00.000Z",
          scanRows: [
            { time: "2026-07-19T10:01:00.000Z", code: "111", productName: "Michelin Defender", quantityDelta: 2 },
            { time: "2026-07-19T10:02:00.000Z", code: "222", productName: "Falken Wildpeak", quantityDelta: 1 },
          ],
          totalScans: 2,
          totalUnits: 3,
        },
      ],
    };
    render(<HistoryPage />);
    // Synchronous, from the archive - never "n/a" and never dependent on the mock DB read.
    expect(screen.getByTestId("history-units-s2")).toHaveTextContent("3");
    expect(screen.getByTestId("history-products-s2")).toHaveTextContent("2");
    expect(mocks.getSessionCounts).not.toHaveBeenCalledWith("s2");
  });

  // Owner requirement (2026-08-05 10k campaign): a past session's counts must stay downloadable on the
  // cloud backend. finalCounts only contains a past session's rows after a refreshFromCloud merge
  // (additive cross-session - see refreshFromCloud.store.test.ts); a tab that finished the session and
  // rotated to a new one has no local rows for it, so History must trigger the merge itself instead of
  // leaving the download button permanently disabled while the cloud holds every row.
  it("cloud backend: triggers refreshFromCloud when a past session has no local finalCounts rows", () => {
    process.env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    const refreshFromCloud = vi.fn(() => Promise.resolve());
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-19T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1, s2],
      finalCounts: [{ sessionId: "s1", productId: "p1", quantity: 1 }], // s2 has NO local rows
      products: [],
      refreshFromCloud,
    };
    render(<HistoryPage />);
    expect(refreshFromCloud).toHaveBeenCalledTimes(1);
  });

  // Superseded by the fresh-device fix below: refreshFromCloud is now fired unconditionally once per
  // ready mount (idempotent + generation-guarded, so a redundant call when everything is already
  // synced is harmless) rather than only when a locally-known past session looks incomplete. Kept as
  // a "still fires" case rather than deleted, so a future regression that removes the call entirely
  // is still caught here.
  it("cloud backend: still fires refreshFromCloud once even when every locally-known past session already has local rows", () => {
    process.env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    const refreshFromCloud = vi.fn(() => Promise.resolve());
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-19T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1, s2],
      finalCounts: [
        { sessionId: "s1", productId: "p1", quantity: 1 },
        { sessionId: "s2", productId: "p2", quantity: 3 },
      ],
      products: [],
      refreshFromCloud,
    };
    render(<HistoryPage />);
    expect(refreshFromCloud).toHaveBeenCalledTimes(1);
  });

  // LIVE-REPRODUCED DEFECT (2026-08-06): a Firestore emulator held SIX completed sessions, but after
  // clearing local browser state and reloading, History showed only the freshly auto-created current
  // session. Root cause: the old trigger only fired when a session it ALREADY knew about (via
  // listSessions()/sessionHistory) looked like it was missing local rows. On a truly fresh device,
  // both are empty (or only contain the brand-new current session) BEFORE the very refresh that would
  // populate them - so pastIds was always empty and refreshFromCloud never ran. The full session list
  // never made it into `sessions`, and History was permanently stuck at one row.
  it("cloud backend: fires refreshFromCloud on a totally fresh device with zero known past sessions (restores full cloud history)", () => {
    process.env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    const refreshFromCloud = vi.fn(() => Promise.resolve());
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-08-06T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [], // fresh device: refreshFromCloud has never populated this yet
      listSessions: () => [s1], // fresh device: only the brand-new auto-created session is known locally
      finalCounts: [],
      products: [],
      refreshFromCloud,
      sessionHistory: [], // fresh device: no local archive of any past session either
    };
    render(<HistoryPage />);
    expect(refreshFromCloud).toHaveBeenCalledTimes(1);
  });

  // Archive-only variant (the live-caught residual): a finished-and-rotated session may exist ONLY in
  // sessionHistory (listSessions no longer returns it) - exactly the session whose counts live only in
  // the cloud. The trigger must consider archive entries too, or those rows stay download-disabled.
  it("cloud backend: triggers refreshFromCloud for an archive-only past session missing local rows", () => {
    process.env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    const refreshFromCloud = vi.fn(() => Promise.resolve());
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1], // the archived session is NOT in the data-source list
      finalCounts: [{ sessionId: "s1", productId: "p1", quantity: 1 }],
      products: [],
      refreshFromCloud,
      sessionHistory: [
        {
          sessionId: "gone-2",
          startedAt: "2026-07-18T09:00:00.000Z",
          endedAt: "2026-07-18T09:30:00.000Z",
          scanRows: [{ time: "2026-07-18T09:05:00.000Z", code: "444", productName: "Tire", quantityDelta: 1 }],
          totalScans: 1,
          totalUnits: 1,
        },
      ],
    };
    render(<HistoryPage />);
    expect(refreshFromCloud).toHaveBeenCalledTimes(1);
  });

  // The live-auth regression the first version of this fix shipped with: on a fresh page load the
  // effect fired on mount, BEFORE BusinessContextGate resolved businessContextReady, and
  // refreshFromCloud silently no-opped - the download stayed disabled. The trigger must wait for
  // readiness and fire when it lands.
  it("cloud backend + live auth: waits for businessContextReady, then fires refreshFromCloud on the re-render where it turns true", () => {
    process.env.NEXT_PUBLIC_FIREBASE_BACKEND = "1";
    mocks.liveAuth = true;
    const refreshFromCloud = vi.fn(() => Promise.resolve());
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-19T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      businessContextReady: false,
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1, s2],
      finalCounts: [],
      products: [],
      refreshFromCloud,
    };
    const view = render(<HistoryPage />);
    expect(refreshFromCloud).not.toHaveBeenCalled(); // context not ready yet - firing now would no-op

    mocks.storeState = { ...mocks.storeState, businessContextReady: true };
    view.rerender(<HistoryPage />);
    expect(refreshFromCloud).toHaveBeenCalledTimes(1);
  });

  it("mock backend: never triggers refreshFromCloud (mock is already the source of truth)", () => {
    const refreshFromCloud = vi.fn(() => Promise.resolve());
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    const s2 = session({ id: "s2", status: "completed", startedAt: "2026-07-19T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1, s2],
      finalCounts: [],
      products: [],
      refreshFromCloud,
    };
    render(<HistoryPage />);
    expect(refreshFromCloud).not.toHaveBeenCalled();
  });

  it("an archived session the data source no longer knows about still gets a row (auto-saved trace) and navigates on click", () => {
    const s1 = session({ id: "s1", status: "active", startedAt: "2026-07-20T10:00:00.000Z" });
    mocks.storeState = {
      businessId: "b1",
      currentSession: s1,
      sessions: [],
      listSessions: () => [s1], // the archived session is NOT returned by the data source
      finalCounts: [],
      products: [],
      sessionHistory: [
        {
          sessionId: "gone-1",
          startedAt: "2026-07-18T09:00:00.000Z",
          endedAt: "2026-07-18T09:30:00.000Z",
          scanRows: [{ time: "2026-07-18T09:05:00.000Z", code: "333", productName: "Unidentified item", quantityDelta: 1 }],
          totalScans: 1,
          totalUnits: 1,
        },
      ],
    };
    render(<HistoryPage />);
    expect(screen.getByTestId("history-row-gone-1")).toBeInTheDocument();
    expect(screen.getByTestId("history-units-gone-1")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("history-row-gone-1"));
    expect(mocks.push).toHaveBeenCalledWith("/sessions/gone-1");
  });
});
