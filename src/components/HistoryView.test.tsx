import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useScanStore } from "@/stores/scanStore";
import { HistoryView } from "@/components/HistoryView";
import type { ScanEvent, InventorySession } from "@/types";

afterEach(() => cleanup());

function session(over: Partial<InventorySession>): InventorySession {
  return {
    id: "s1", businessId: "b", name: "Morning Count", location: "Main", status: "active",
    startedAt: "2026-07-22T09:00:00.000Z", completedAt: null, createdBy: "demo", notes: "",
    syncStatus: "synced", ...over,
  };
}

function scanEvent(over: Partial<ScanEvent>): ScanEvent {
  return {
    id: "e1", businessId: "b", sessionId: "s1", rawCode: "111", cleanCode: "111",
    normalizedCandidates: [], matchedProductId: null, matchType: "unknown", status: "known",
    resolverStatus: "known", codeType: "upc", reason: "", quantityDelta: 1, quantityAfterScan: 1,
    createdAt: "2026-07-22T10:00:00.000Z", syncStatus: "synced",
    ...over,
  } as ScanEvent;
}

describe("HistoryView", () => {
  it("lists past sessions with date, started, ended, scans, and units", () => {
    useScanStore.setState({
      sessionHistory: [
        {
          sessionId: "past-1",
          startedAt: "2026-07-21T09:00:00.000Z",
          endedAt: "2026-07-21T10:00:00.000Z",
          scanRows: [{ time: "2026-07-21T09:05:00.000Z", code: "111", productName: "Falken Wildpeak", quantityDelta: 1 }],
          totalScans: 1,
          totalUnits: 1,
        },
      ],
      currentSession: session({ id: "current-1" }),
      scanFeed: [],
    });
    render(<HistoryView />);
    expect(screen.getByTestId("history-session-past-1")).toBeInTheDocument();
    expect(screen.getByTestId("history-session-past-1")).toHaveTextContent("1"); // scans
  });

  it("shows the current live session at the top, labeled, linking to /scan", () => {
    useScanStore.setState({
      sessionHistory: [],
      currentSession: session({ id: "current-1" }),
      scanFeed: [scanEvent({ id: "e1" })],
    });
    render(<HistoryView />);
    const currentRow = screen.getByTestId("history-current-session");
    expect(within(currentRow).getByText(/current session/i)).toBeInTheDocument();
    expect(within(currentRow).getByRole("link")).toHaveAttribute("href", "/scan");
  });

  it("clicking a past session shows its scan rows (time, barcode, product, qty)", async () => {
    const user = userEvent.setup();
    useScanStore.setState({
      sessionHistory: [
        {
          sessionId: "past-1",
          startedAt: "2026-07-21T09:00:00.000Z",
          endedAt: "2026-07-21T10:00:00.000Z",
          scanRows: [{ time: "2026-07-21T09:05:00.000Z", code: "086699998538", productName: "Falken Wildpeak", quantityDelta: 2 }],
          totalScans: 1,
          totalUnits: 2,
        },
      ],
      currentSession: null,
      scanFeed: [],
    });
    render(<HistoryView />);
    await user.click(screen.getByTestId("history-session-past-1"));
    expect(screen.getByTestId("history-detail-past-1")).toBeInTheDocument();
    expect(screen.getByText("086699998538")).toBeInTheDocument();
    expect(screen.getByText("Falken Wildpeak")).toBeInTheDocument();
  });

  it("shows an empty state when there is no history and no current session activity", () => {
    useScanStore.setState({ sessionHistory: [], currentSession: null, scanFeed: [] });
    render(<HistoryView />);
    expect(screen.getByText(/no past sessions yet/i)).toBeInTheDocument();
  });
});
