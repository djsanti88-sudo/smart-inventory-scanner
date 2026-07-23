import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ArchivedSessionScans } from "@/components/ArchivedSessionScans";
import type { SessionHistoryEntry } from "@/services/sessions/sessionHistory";

// Owner feature (2026-07-22): the archived per-session scan spreadsheet - the auto-saved trace a
// past session leaves behind, shown when the live data source has no timeline for it.

function entry(over: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    sessionId: "s1",
    startedAt: "2026-07-22T09:00:00.000Z",
    endedAt: "2026-07-22T10:00:00.000Z",
    scanRows: [
      { time: "2026-07-22T09:05:00.000Z", code: "086699205636", productName: "Michelin Defender LTX M/S", quantityDelta: 2 },
      { time: "2026-07-22T09:06:00.000Z", code: "999888777666", productName: "Unidentified item", quantityDelta: 1 },
    ],
    totalScans: 2,
    totalUnits: 3,
    ...over,
  };
}

afterEach(() => {
  cleanup();
});

describe("ArchivedSessionScans", () => {
  it("renders one row per archived scan with barcode, product name, and qty", () => {
    render(<ArchivedSessionScans entry={entry()} />);
    expect(screen.getByTestId("session-archived-scans")).toBeInTheDocument();
    expect(screen.getByText("086699205636")).toBeInTheDocument();
    expect(screen.getByText("Michelin Defender LTX M/S")).toBeInTheDocument();
    // The unidentified scan still appears as its own honest row (every scan leaves a trace).
    expect(screen.getByText("999888777666")).toBeInTheDocument();
    expect(screen.getByText("Unidentified item")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^archived-scan-row-/)).toHaveLength(2);
  });

  it("shows the scans/units summary line", () => {
    render(<ArchivedSessionScans entry={entry()} />);
    expect(screen.getByText(/2 scans, 3 units/)).toBeInTheDocument();
  });

  it("shows the empty message for an entry with zero rows", () => {
    render(<ArchivedSessionScans entry={entry({ scanRows: [], totalScans: 0, totalUnits: 0 })} />);
    expect(screen.getByText("No scans recorded for this session.")).toBeInTheDocument();
  });
});
