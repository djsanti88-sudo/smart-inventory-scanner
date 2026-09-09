import { describe, it, expect } from "vitest";
import {
  buildSessionHistoryEntry,
  appendSessionHistory,
  SESSION_HISTORY_CAP,
  SESSION_HISTORY_ROWS_CAP,
  type SessionHistoryEntry,
} from "@/sessions/history/sessionHistory";
import type { ScanEvent } from "@/types";

function scanEvent(over: Partial<ScanEvent>): ScanEvent {
  return {
    id: "e1", businessId: "b", sessionId: "s1", rawCode: "111", cleanCode: "111",
    normalizedCandidates: [], matchedProductId: null, matchType: "unknown", status: "known",
    resolverStatus: "known", codeType: "upc", reason: "", quantityDelta: 1, quantityAfterScan: 1,
    createdAt: "2026-07-22T10:00:00.000Z", syncStatus: "synced",
    ...over,
  } as ScanEvent;
}

describe("buildSessionHistoryEntry", () => {
  it("returns null for a session with zero scans (empty sessions are not recorded)", () => {
    const entry = buildSessionHistoryEntry(
      { id: "s1", startedAt: "2026-07-22T09:00:00.000Z" },
      [],
      () => "-",
      "2026-07-22T10:00:00.000Z",
    );
    expect(entry).toBeNull();
  });

  it("builds an entry with rows in chronological order and correct totals", () => {
    const feed: ScanEvent[] = [
      scanEvent({ id: "e2", cleanCode: "222", quantityDelta: 2, createdAt: "2026-07-22T10:05:00.000Z" }),
      scanEvent({ id: "e1", cleanCode: "111", quantityDelta: 1, createdAt: "2026-07-22T10:00:00.000Z" }),
    ]; // newest-first, as the store's scanFeed is
    const getProductName = (id: string | null) => (id === "p1" ? "Falken Wildpeak" : "Unidentified item");
    const entry = buildSessionHistoryEntry(
      { id: "s1", startedAt: "2026-07-22T09:00:00.000Z" },
      feed,
      getProductName,
      "2026-07-22T10:10:00.000Z",
    );
    expect(entry).not.toBeNull();
    expect(entry!.sessionId).toBe("s1");
    expect(entry!.startedAt).toBe("2026-07-22T09:00:00.000Z");
    expect(entry!.endedAt).toBe("2026-07-22T10:10:00.000Z");
    // chronological: oldest (111) first, newest (222) last
    expect(entry!.scanRows.map((r) => r.code)).toEqual(["111", "222"]);
    expect(entry!.totalScans).toBe(2);
    expect(entry!.totalUnits).toBe(3);
  });

  it("keeps a physical scan with quantityDelta zero in the row log and scan total", () => {
    const entry = buildSessionHistoryEntry(
      { id: "s1", startedAt: "2026-07-22T09:00:00.000Z" },
      [scanEvent({ id: "e-zero", cleanCode: "ZERO", quantityDelta: 0 })],
      () => "Unidentified item",
      "2026-07-22T10:10:00.000Z",
    );

    expect(entry!.scanRows).toHaveLength(1);
    expect(entry!.scanRows[0]?.quantityDelta).toBe(0);
    expect(entry!.totalScans).toBe(1);
    expect(entry!.totalUnits).toBe(0);
  });

  it("caps rows at SESSION_HISTORY_ROWS_CAP, keeping the most recent rows", () => {
    const feed: ScanEvent[] = Array.from({ length: SESSION_HISTORY_ROWS_CAP + 10 }, (_, i) =>
      scanEvent({ id: `e${i}`, cleanCode: String(i), createdAt: `2026-07-22T10:${String(i % 60).padStart(2, "0")}:00.000Z` }),
    );
    const entry = buildSessionHistoryEntry(
      { id: "s1", startedAt: "2026-07-22T09:00:00.000Z" },
      feed,
      () => "-",
      "2026-07-22T10:10:00.000Z",
    );
    expect(entry!.scanRows.length).toBe(SESSION_HISTORY_ROWS_CAP);
  });

  it("keeps whole-session totals when the archived row display is capped", () => {
    const feed: ScanEvent[] = Array.from({ length: SESSION_HISTORY_ROWS_CAP + 2 }, (_, index) =>
      scanEvent({ id: `e${index}`, cleanCode: String(index), quantityDelta: 2 }),
    );
    const entry = buildSessionHistoryEntry(
      { id: "s1", startedAt: "2026-07-22T09:00:00.000Z" },
      feed,
      () => "-",
      "2026-07-22T10:10:00.000Z",
    );

    expect(entry!.scanRows).toHaveLength(SESSION_HISTORY_ROWS_CAP);
    expect(entry!.totalScans).toBe(SESSION_HISTORY_ROWS_CAP + 2);
    expect(entry!.totalUnits).toBe((SESSION_HISTORY_ROWS_CAP + 2) * 2);
    expect(entry!.displayedScanCount).toBe(SESSION_HISTORY_ROWS_CAP);
    expect(entry!.scanRowsCapped).toBe(true);
  });
});

describe("appendSessionHistory", () => {
  function entry(id: string): SessionHistoryEntry {
    return {
      sessionId: id,
      startedAt: "",
      endedAt: "",
      scanRows: [],
      displayedScanCount: 0,
      scanRowsCapped: false,
      totalScans: 1,
      totalUnits: 1,
    };
  }

  it("prepends the new entry (newest-first)", () => {
    const existing = [entry("older")];
    const next = appendSessionHistory(existing, entry("newer"));
    expect(next.map((e) => e.sessionId)).toEqual(["newer", "older"]);
  });

  it("caps at SESSION_HISTORY_CAP, dropping the oldest", () => {
    const existing = Array.from({ length: SESSION_HISTORY_CAP }, (_, i) => entry(`s${i}`));
    const next = appendSessionHistory(existing, entry("newest"));
    expect(next.length).toBe(SESSION_HISTORY_CAP);
    expect(next[0].sessionId).toBe("newest");
    // existing[] is oldest-first by construction (s0 built first ... s49 built last, appended in that
    // order), so the array's last element (s49) is the true oldest and must be the one dropped.
    expect(next.find((e) => e.sessionId === `s${SESSION_HISTORY_CAP - 1}`)).toBeUndefined();
  });
});
