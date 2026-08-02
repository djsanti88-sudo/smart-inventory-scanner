import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScanEvent } from "@/types";

const mocks = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  cameraOnScan: null as null | ((raw: string) => unknown),
}));

function eventFor(code: string, quantity: number): ScanEvent {
  return {
    id: `event-${quantity}`, businessId: "local-demo", sessionId: "session", rawCode: code, cleanCode: code,
    normalizedCandidates: [code], matchedProductId: null, matchType: "unknown", status: "unknown",
    resolverStatus: "needs_review", codeType: "messy", reason: "", quantityDelta: 1, quantityAfterScan: quantity,
    createdAt: "2026-08-02T00:00:00.000Z", source: "scan", notes: "", syncStatus: "pending",
    syncError: null, idempotencyKey: `key-${quantity}`,
  };
}

function resetStore() {
  const processScan = vi.fn((code: string) => eventFor(code, processScan.mock.calls.length + 1));
  mocks.storeState = {
    processScan, products: [], aliases: [], businessId: "local-demo", startSession: vi.fn(), finishSession: vi.fn(),
    clearSession: vi.fn(), currentSession: null,
    settings: { scannerSubmitMode: "enter", scannerDebounceMs: 0, aiLookupEnabled: false, dailyLookupCount: 0, dailyLookupLimit: 0 },
    aiStatus: { geminiConfigured: false, openaiConfigured: false, autoDecodeOnScan: false, liveEnabled: false, emergencyStop: false },
    refreshAiStatus: vi.fn(), updateSettings: vi.fn(), lastCategoryWarning: null, clearCategoryWarning: vi.fn(),
    location: "", setLocation: vi.fn(), recentLocations: [], ensureAutoSession: vi.fn(), businessContextReady: true,
    businessDataLoaded: true, scanFeed: [], firstScanAt: null, getProduct: vi.fn(),
  };
  mocks.cameraOnScan = null;
  return processScan;
}

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/stores/scanStore", () => ({ useScanStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.storeState) }));
vi.mock("@/services/security/useAccessLevel", () => ({ useIsPlatformOwner: () => false }));
vi.mock("@/services/resolver", () => ({ resolveRawScan: () => ({ resolverStatus: "unknown" }) }));
vi.mock("@/services/moatStats", () => ({ computeMoatStats: () => ({ identified: 0, total: 0 }) }));
// This deliberately leaves ScannerInput real. The camera shell is thin because camera media access
// is external; invoking its supplied callback proves it joins the same page-owned queue.
vi.mock("@/components/CameraScanButton", () => ({
  CameraScanButton: ({ onScan }: { onScan: (raw: string) => unknown }) => {
    mocks.cameraOnScan = onScan;
    return <button type="button" data-testid="camera-queue-probe" onClick={() => void onScan("camera-1")}>Camera probe</button>;
  },
}));
vi.mock("@/components/LiveScanFeed", () => ({ LiveScanFeed: () => <div /> }));
vi.mock("@/components/FinalCountTable", () => ({ FinalCountTable: () => <div /> }));
vi.mock("@/components/SyncStatusBar", () => ({ SyncStatusBar: () => <div /> }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => <div /> }));
vi.mock("@/components/VarianceReport", () => ({ VarianceReport: () => <div /> }));
vi.mock("@/components/SessionLockControl", () => ({ SessionLockControl: () => <div /> }));
vi.mock("@/components/SessionsList", () => ({ SessionsList: () => <div /> }));
vi.mock("@/components/BusinessContextGate", () => ({ BusinessContextGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import ScanPage from "./page";

function submitPaste(codes: readonly string[]) {
  const input = screen.getByTestId("scanner-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: codes.join(" ") } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input;
}

async function releaseNextChunk() {
  await act(async () => {
    await vi.advanceTimersToNextTimerAsync();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ScanPage queued scanner DOM proof", () => {
  it("uses the actual scanner input, serializes a camera scan at a chunk boundary, and counts all 101 pasted codes", async () => {
    vi.useFakeTimers();
    const processScan = resetStore();
    const codes = Array.from({ length: 101 }, (_, index) => `bulk-${index + 1}`);
    render(<ScanPage />);

    const input = submitPaste(codes);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(processScan).toHaveBeenCalledTimes(20);
    expect(screen.getByTestId("bulk-scan-progress")).toHaveTextContent("20 of 101");

    fireEvent.click(screen.getByTestId("camera-queue-probe"));
    expect(processScan).toHaveBeenCalledTimes(20);
    await releaseNextChunk();
    expect(processScan.mock.calls.map(([code]) => code)).toEqual([
      ...codes.slice(0, 20), "camera-1", ...codes.slice(20, 40),
    ]);

    for (let batch = 0; batch < 4; batch += 1) await releaseNextChunk();
    expect(processScan.mock.calls.map(([code]) => code)).toEqual([...codes.slice(0, 20), "camera-1", ...codes.slice(20)]);
    expect(processScan).toHaveBeenCalledTimes(102);
    expect(new Set(processScan.mock.calls.map(([code]) => code)).size).toBe(102);
    expect(screen.queryByTestId("bulk-scan-progress")).toBeNull();
  });

  it("stops at the accepted chunk boundary without rolling back the 40 physical scans already accepted", async () => {
    vi.useFakeTimers();
    const processScan = resetStore();
    render(<ScanPage />);
    submitPaste(Array.from({ length: 101 }, (_, index) => `stop-${index + 1}`));
    await releaseNextChunk();
    expect(processScan).toHaveBeenCalledTimes(40);

    fireEvent.click(screen.getByTestId("stop-bulk-scan"));
    await releaseNextChunk();

    expect(processScan).toHaveBeenCalledTimes(40);
    expect(processScan.mock.calls.map(([code]) => code)).toEqual(Array.from({ length: 40 }, (_, index) => `stop-${index + 1}`));
    expect(screen.queryByTestId("bulk-scan-progress")).toBeNull();
  });

  it("drains already accepted work after page unmount without a React state-update warning", async () => {
    vi.useFakeTimers();
    const processScan = resetStore();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const codes = Array.from({ length: 101 }, (_, index) => `unmount-${index + 1}`);
    const view = render(<ScanPage />);
    submitPaste(codes);
    expect(processScan).toHaveBeenCalledTimes(20);

    view.unmount();
    for (let batch = 0; batch < 5; batch += 1) await releaseNextChunk();

    expect(processScan.mock.calls.map(([code]) => code)).toEqual(codes);
    expect(consoleError.mock.calls.join(" ")).not.toMatch(/state update on an unmounted|not wrapped in act/i);
  });
});
