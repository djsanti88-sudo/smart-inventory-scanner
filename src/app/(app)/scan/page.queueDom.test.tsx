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
vi.mock("@/components/LiveScanFeed", () => ({
  LiveScanFeed: () => <div data-testid="queue-feed-probe">{(mocks.storeState.scanFeed as ScanEvent[]).map((event) => `${event.notes}:${event.cleanCode}`).join(",")}</div>,
}));
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
  it("admits a hardware Enter through the current scan handler after the page re-renders", async () => {
    resetStore();
    const view = render(<ScanPage />);
    const staleProcessScan = mocks.storeState.processScan as ReturnType<typeof vi.fn>;
    const currentProcessScan = vi.fn((code: string) => {
      const event = eventFor(code, 1);
      mocks.storeState.scanFeed = [event];
      return event;
    });
    mocks.storeState.processScan = currentProcessScan;
    view.rerender(<ScanPage />);

    const input = screen.getByTestId("scanner-input") as HTMLInputElement;
    // A hardware wedge writes its complete value in one input event, then sends Enter.
    fireEvent.input(input, { target: { value: "6419440485331" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(staleProcessScan).not.toHaveBeenCalled();
    expect(currentProcessScan).toHaveBeenCalledWith("6419440485331");
    expect(document.activeElement).toBe(input);

    await act(async () => { await Promise.resolve(); });
    view.rerender(<ScanPage />);
    expect(screen.getByTestId("queue-feed-probe")).toHaveTextContent("6419440485331");
  });

  it("keeps delayed accepted work on its admission handler and sends later Enter work to the new handler", async () => {
    vi.useFakeTimers();
    resetStore();
    const routeTo = (context: "old" | "new") => vi.fn((code: string) => {
      const event = { ...eventFor(code, 1), notes: context };
      mocks.storeState.scanFeed = [...(mocks.storeState.scanFeed as ScanEvent[]), event];
      return event;
    });
    const oldProcessScan = routeTo("old");
    mocks.storeState.processScan = oldProcessScan;
    const view = render(<ScanPage />);
    const oldCodes = Array.from({ length: 21 }, (_, index) => `old-${index + 1}`);

    const input = submitPaste(oldCodes);
    expect(oldProcessScan).toHaveBeenCalledTimes(20);
    expect(document.activeElement).toBe(input);

    const newProcessScan = routeTo("new");
    mocks.storeState.processScan = newProcessScan;
    view.rerender(<ScanPage />);
    await releaseNextChunk();
    submitPaste(["new-1"]);
    await act(async () => { await Promise.resolve(); });
    view.rerender(<ScanPage />);

    expect(screen.getByTestId("queue-feed-probe")).toHaveTextContent([
      ...oldCodes.map((code) => `old:${code}`),
      "new:new-1",
    ].join(","));
    expect(oldProcessScan).toHaveBeenCalledTimes(21);
    expect(newProcessScan).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });

  it("keeps the actual scanner input live and serializes hardware and camera scans at separate chunk boundaries", async () => {
    vi.useFakeTimers();
    const processScan = resetStore();
    const codes = Array.from({ length: 101 }, (_, index) => `bulk-${index + 1}`);
    render(<ScanPage />);

    const input = submitPaste(codes);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(processScan).toHaveBeenCalledTimes(20);
    expect(screen.getByTestId("bulk-scan-progress")).toHaveTextContent("20 of 101");

    fireEvent.change(input, { target: { value: "hardware-1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).not.toBeDisabled();
    expect(input).toHaveAttribute("aria-busy", "false");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByTestId("camera-queue-probe"));
    expect(processScan).toHaveBeenCalledTimes(20);

    await releaseNextChunk();
    expect(processScan.mock.calls.map(([code]) => code)).toEqual([
      ...codes.slice(0, 20), "hardware-1", ...codes.slice(20, 40),
    ]);
    for (let release = 0; processScan.mock.calls.length < 103 && release < 5; release += 1) {
      await releaseNextChunk();
    }
    expect(processScan.mock.calls.map(([code]) => code)).toEqual([
      ...codes.slice(0, 20), "hardware-1", ...codes.slice(20, 40), "camera-1", ...codes.slice(40),
    ]);
    expect(processScan).toHaveBeenCalledTimes(103);
    expect(new Set(processScan.mock.calls.map(([code]) => code)).size).toBe(103);
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
