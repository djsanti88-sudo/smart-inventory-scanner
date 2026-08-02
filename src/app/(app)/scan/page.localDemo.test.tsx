import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  suspendSearchParams: false,
  pendingSearchParams: new Promise<never>(() => {}),
  storeState: {
    processScan: vi.fn(), products: [], aliases: [], businessId: "local-demo", startSession: vi.fn(),
    finishSession: vi.fn(), clearSession: vi.fn(), currentSession: null, settings: {
      scannerSubmitMode: "enter", scannerDebounceMs: 0, aiLookupEnabled: false, dailyLookupCount: 0, dailyLookupLimit: 0,
    },
    aiStatus: { geminiConfigured: false, openaiConfigured: false, autoDecodeOnScan: false, liveEnabled: false, emergencyStop: false },
    refreshAiStatus: vi.fn(), updateSettings: vi.fn(), lastCategoryWarning: null, clearCategoryWarning: vi.fn(),
    location: "", setLocation: vi.fn(), recentLocations: [], ensureAutoSession: vi.fn(), businessContextReady: true,
    businessDataLoaded: true, scanFeed: [], firstScanAt: null,
  } as Record<string, unknown>,
  scannerOnScan: null as null | ((raw: string) => unknown),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (mocks.suspendSearchParams) throw mocks.pendingSearchParams;
    return mocks.searchParams;
  },
}));
vi.mock("@/stores/scanStore", () => ({ useScanStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.storeState) }));
vi.mock("@/services/security/useAccessLevel", () => ({ useIsPlatformOwner: () => false }));
vi.mock("@/services/resolver", () => ({ resolveRawScan: () => ({ resolverStatus: "unknown" }) }));
vi.mock("@/services/moatStats", () => ({ computeMoatStats: () => ({ identified: 0, total: 0 }) }));
vi.mock("@/components/ScannerInput", () => ({
  ScannerInput: ({ onScan }: { onScan: (raw: string) => unknown }) => {
    mocks.scannerOnScan = onScan;
    return <div />;
  },
}));
vi.mock("@/components/CameraScanButton", () => ({ CameraScanButton: () => <div /> }));
vi.mock("@/components/LiveScanFeed", () => ({ LiveScanFeed: () => <div /> }));
vi.mock("@/components/FinalCountTable", () => ({ FinalCountTable: () => <div /> }));
vi.mock("@/components/SyncStatusBar", () => ({ SyncStatusBar: () => <div /> }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => <div /> }));
vi.mock("@/components/VarianceReport", () => ({ VarianceReport: () => <div /> }));
vi.mock("@/components/SessionLockControl", () => ({ SessionLockControl: () => <div /> }));
vi.mock("@/components/SessionsList", () => ({ SessionsList: () => <div /> }));
vi.mock("@/components/BusinessContextGate", () => ({ BusinessContextGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import ScanPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.searchParams = new URLSearchParams();
  mocks.suspendSearchParams = false;
  mocks.scannerOnScan = null;
  vi.useRealTimers();
});

describe("ScanPage local demo proof batch", () => {
  it("shows a scanner loading boundary while search params suspend during prerendering", () => {
    mocks.suspendSearchParams = true;

    render(<ScanPage />);

    expect(screen.getByTestId("scan-page-loading")).toHaveTextContent("Loading scanner");
  });

  it("shows the canonical proof batch marker for an active local demo proof run", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    mocks.searchParams = new URLSearchParams("proofBatch=01");

    render(<ScanPage />);

    expect(screen.getByTestId("local-demo-proof-batch")).toHaveTextContent("01");
  });

  it.each(["1", "00", "31", "01x", ""]) ("does not show a marker for non-canonical batch %j", (proofBatch) => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    mocks.searchParams = new URLSearchParams({ proofBatch });

    render(<ScanPage />);

    expect(screen.queryByTestId("local-demo-proof-batch")).toBeNull();
  });

  it("processes a 101-code paste in responsive chunks and reports progress", async () => {
    vi.useFakeTimers();
    const codes = Array.from({ length: 101 }, (_, index) => `bulk-${index + 1}`);
    const processScan = mocks.storeState.processScan as ReturnType<typeof vi.fn>;
    processScan.mockImplementation((code: string) => ({ cleanCode: code }));

    render(<ScanPage />);
    if (!mocks.scannerOnScan) throw new Error("scanner callback was not mounted");

    let completion!: Promise<unknown>;
    await act(async () => {
      completion = mocks.scannerOnScan!(codes.join(" ")) as Promise<unknown>;
      await Promise.resolve();
    });

    expect(processScan).toHaveBeenCalledTimes(20);
    expect(screen.getByTestId("bulk-scan-progress")).toHaveTextContent("20 of 101");
    expect(screen.getByTestId("stop-bulk-scan")).toHaveAttribute("type", "button");
    expect(screen.getByTestId("start-session")).toBeDisabled();
    expect(screen.getByTestId("finish-session")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear session" })).toBeDisabled();

    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        await vi.advanceTimersToNextTimerAsync();
      }
      await completion;
    });

    expect(processScan).toHaveBeenCalledTimes(101);
    expect(processScan.mock.calls.map(([code]) => code)).toEqual(codes);
    expect(screen.queryByTestId("bulk-scan-progress")).toBeNull();
    expect(screen.getByTestId("bulk-scan-outcome")).toHaveTextContent("Completed 101 scans.");
    expect(screen.getByTestId("bulk-scan-outcome")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("start-session")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear session" })).not.toBeDisabled();
  });

  it("persists an exact cancellation announcement and clears it when the next bulk starts", async () => {
    vi.useFakeTimers();
    const processScan = mocks.storeState.processScan as ReturnType<typeof vi.fn>;
    processScan.mockReset();
    processScan.mockImplementation((code: string) => ({ cleanCode: code }));

    render(<ScanPage />);
    if (!mocks.scannerOnScan) throw new Error("scanner callback was not mounted");

    let cancelled!: Promise<unknown>;
    await act(async () => {
      cancelled = mocks.scannerOnScan!(Array.from({ length: 101 }, (_, index) => `cancel-${index}`).join(" ")) as Promise<unknown>;
      await Promise.resolve();
    });
    expect(processScan).toHaveBeenCalledTimes(20);
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining" }));
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
      await cancelled;
    });

    expect(screen.getByTestId("bulk-scan-outcome")).toHaveTextContent(
      "Stopped after 20 of 101 scans. 81 remaining scans were not added.",
    );
    expect(screen.queryByTestId("bulk-scan-progress")).toBeNull();

    let next!: Promise<unknown>;
    await act(async () => {
      next = mocks.scannerOnScan!(Array.from({ length: 21 }, (_, index) => `next-${index}`).join(" ")) as Promise<unknown>;
      await Promise.resolve();
    });
    expect(screen.queryByTestId("bulk-scan-outcome")).toBeNull();
    expect(screen.getByTestId("bulk-scan-progress")).toHaveTextContent("20 of 21");

    fireEvent.click(screen.getByRole("button", { name: "Stop remaining" }));
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
      await next;
    });
  });
});
