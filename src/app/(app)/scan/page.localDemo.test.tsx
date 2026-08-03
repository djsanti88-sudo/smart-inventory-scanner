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

    // Each physical scan yields before the next one starts, so an aisle paste never
    // monopolizes the browser before the operator can see feedback or stop it.
    expect(processScan).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("bulk-scan-progress")).toHaveTextContent("1 of 101");
    expect(screen.getByTestId("stop-bulk-scan")).toHaveAttribute("type", "button");
    expect(screen.getByTestId("start-session")).toBeDisabled();
    expect(screen.getByTestId("finish-session")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear session" })).toBeDisabled();

    await act(async () => {
      for (let index = 0; index < 100; index += 1) {
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
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    processScan.mockImplementation((code: string) => {
      if (code === "cancel-0") throw new Error("not added");
      return { cleanCode: code };
    });

    render(<ScanPage />);
    if (!mocks.scannerOnScan) throw new Error("scanner callback was not mounted");

    let cancelled!: Promise<unknown>;
    await act(async () => {
      cancelled = mocks.scannerOnScan!(Array.from({ length: 101 }, (_, index) => `cancel-${index}`).join(" ")) as Promise<unknown>;
      await Promise.resolve();
    });
    expect(processScan).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop remaining" }));
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
      await cancelled;
    });

    expect(screen.getByTestId("bulk-scan-outcome")).toHaveTextContent(
      "Stopped after 1 of 101 scans. 0 were added, 1 failed, and 100 remaining scans were not added.",
    );
    expect(screen.queryByTestId("bulk-scan-progress")).toBeNull();

    let next!: Promise<unknown>;
    await act(async () => {
      next = mocks.scannerOnScan!(Array.from({ length: 21 }, (_, index) => `next-${index}`).join(" ")) as Promise<unknown>;
      await Promise.resolve();
    });
    expect(screen.queryByTestId("bulk-scan-outcome")).toBeNull();
    expect(screen.getByTestId("bulk-scan-progress")).toHaveTextContent("1 of 21");

    fireEvent.click(screen.getByRole("button", { name: "Stop remaining" }));
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await vi.advanceTimersToNextTimerAsync();
      await next;
    });
    report.mockRestore();
  });

  it("announces the exact added and failed totals after a completed bulk", async () => {
    vi.useFakeTimers();
    const processScan = mocks.storeState.processScan as ReturnType<typeof vi.fn>;
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    processScan.mockReset();
    processScan.mockImplementation((code: string) => {
      if (code === "failed") throw new Error("not added");
      return { cleanCode: code };
    });

    render(<ScanPage />);
    if (!mocks.scannerOnScan) throw new Error("scanner callback was not mounted");
    let completion!: Promise<unknown>;
    await act(async () => {
      completion = mocks.scannerOnScan!([...Array.from({ length: 20 }, (_, index) => `ok-${index}`), "failed"].join(" ")) as Promise<unknown>;
      for (let index = 0; index < 20; index += 1) await vi.advanceTimersToNextTimerAsync();
      await completion;
    });

    expect(screen.getByTestId("bulk-scan-outcome")).toHaveTextContent(
      "Added 20 of 21 scans. 1 scan failed and was not added.",
    );
    report.mockRestore();
  });
});
