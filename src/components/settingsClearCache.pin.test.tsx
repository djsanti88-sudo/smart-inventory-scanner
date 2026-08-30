import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const verifyOwnerPin = vi.fn();
const clearLocalCache = vi.fn();

// The settings page selects many slices; the mock state must cover every selector it uses.
const storeState = {
  settings: { ownerPinHash: "hash" } as Record<string, unknown>,
  updateSettings: vi.fn(),
  businessId: "demo-business",
  clearLocalCache: () => clearLocalCache(),
  aiStatus: null,
  refreshAiStatus: vi.fn().mockResolvedValue(undefined),
  setEmergencyStop: vi.fn(),
  catalog: [] as unknown[],
  verifyOwnerPin: (p: string) => verifyOwnerPin(p),
  // Spec 3 (M1, clear-cache guard): the page reads pendingCount() to decide which confirm copy to
  // show. Mutable per-test via storeState.pendingCount (same pattern as settings.ownerPinHash above).
  pendingCount: () => 0,
};
vi.mock("@/stores/scanStore", () => ({
  useScanStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));
vi.mock("@/stores/reconcileStore", () => ({
  useReconcileStore: { getState: () => ({ clearLocalCache: vi.fn() }) },
}));
vi.mock("@/users-businesses/roles/useAccessLevel", () => ({ useIsPlatformOwner: () => false }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("@/inventory/cleanup/CleanupRecommendations", () => ({ CleanupRecommendations: () => null }));
vi.mock("@/sessions/lock/OwnerPinSettings", () => ({ OwnerPinSettings: () => null }));
vi.mock("@/components/GptDecodePanel", () => ({ GptDecodePanel: () => null }));

import SettingsPage from "@/app/(app)/settings/page";

beforeEach(() => {
  verifyOwnerPin.mockReset();
  clearLocalCache.mockReset();
  storeState.settings.ownerPinHash = "hash";
  storeState.pendingCount = () => 0;
});

// This test file (unlike the brief's inline listing) is run under a jsdom project without `globals:
// true`, so React Testing Library's automatic afterEach(cleanup) never registers. Without an explicit
// cleanup, the previous test's rendered SettingsPage stays mounted and "clear-cache" resolves to two
// elements in the second test. Added per repo convention (see FinalCountTable.test.tsx's afterEach);
// no assertion in either `it` block was changed.
afterEach(() => {
  cleanup();
});

describe("clear cache PIN gate", () => {
  it("requires a correct PIN, then clears, shows the message, and schedules the AM-R9 reload", async () => {
    verifyOwnerPin.mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    const pinInput = await screen.findByTestId("clear-cache-pin");
    fireEvent.change(pinInput, { target: { value: "1234" } });
    fireEvent.click(screen.getByTestId("clear-cache-confirm"));
    await waitFor(() => expect(verifyOwnerPin).toHaveBeenCalledWith("1234"));
    await waitFor(() => expect(clearLocalCache).toHaveBeenCalledOnce());
    expect(await screen.findByTestId("clear-cache-message")).toBeInTheDocument(); // cacheMsg preserved
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1400); // AM-R9 reload preserved
  });

  it("keeps today's confirm-only path when no PIN is set", async () => {
    storeState.settings.ownerPinHash = "";
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    await waitFor(() => expect(clearLocalCache).toHaveBeenCalledOnce()); // no PIN prompt, direct clear
  });

  it("rejects a WRONG PIN: does NOT clear, and shows the visible 'Wrong PIN' error (F3)", async () => {
    verifyOwnerPin.mockResolvedValue(false); // owner PIN check fails
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    const pinInput = await screen.findByTestId("clear-cache-pin");
    fireEvent.change(pinInput, { target: { value: "0000" } });
    fireEvent.click(screen.getByTestId("clear-cache-confirm"));
    await waitFor(() => expect(verifyOwnerPin).toHaveBeenCalledWith("0000"));
    const err = await screen.findByTestId("clear-cache-pin-error");
    expect(err).toHaveTextContent("Wrong PIN");
    expect(clearLocalCache).not.toHaveBeenCalled(); // a wrong PIN must NEVER wipe local data
  });
});

// Spec 3 (M1): a shop owner clicking "Clear local cache" with unsynced scans in the queue currently
// sees the SAME generic wording as one with nothing at risk - no exact count, no differentiation.
// Regression protection: this failed before the fix (generic message shown regardless of count).
describe("clear cache pending-count guard (Spec 3)", () => {
  it("with pendingCount > 0: the confirm message NAMES the exact count", async () => {
    storeState.settings.ownerPinHash = ""; // no-PIN path: confirm() is the only gate
    storeState.pendingCount = () => 3;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const message = confirmSpy.mock.calls.at(-1)?.[0] ?? "";
    expect(message).toContain("3");
    expect(message.toLowerCase()).toContain("not yet synced");
  });

  it("with pendingCount === 1: singular wording (not '1 scans')", async () => {
    storeState.settings.ownerPinHash = "";
    storeState.pendingCount = () => 1;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const message = confirmSpy.mock.calls.at(-1)?.[0] ?? "";
    expect(message).toContain("1 scan");
    expect(message).not.toContain("1 scans");
  });

  it("with pendingCount === 0: the generic message is used (no digit-count phrasing)", async () => {
    storeState.settings.ownerPinHash = "";
    storeState.pendingCount = () => 0;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const message = confirmSpy.mock.calls.at(-1)?.[0] ?? "";
    expect(message).not.toMatch(/\d+ scans?/);
    expect(message.toLowerCase()).not.toContain("not yet synced");
  });

  it("declining the harder pendingCount > 0 confirm does NOT clear (cancel aborts entirely)", async () => {
    storeState.settings.ownerPinHash = "";
    storeState.pendingCount = () => 5;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    await new Promise((r) => setTimeout(r, 0));
    expect(clearLocalCache).not.toHaveBeenCalled();
  });

  it("uses plain punctuation only, no em dash or en dash (copy rule)", async () => {
    storeState.settings.ownerPinHash = "";
    storeState.pendingCount = () => 7;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("clear-cache"));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const message = confirmSpy.mock.calls.at(-1)?.[0] ?? "";
    expect(message).not.toMatch(/[–—]/);
  });
});
