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
};
vi.mock("@/stores/scanStore", () => ({
  useScanStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));
vi.mock("@/stores/reconcileStore", () => ({
  useReconcileStore: { getState: () => ({ clearLocalCache: vi.fn() }) },
}));
vi.mock("@/services/security/useAccessLevel", () => ({ useIsPlatformOwner: () => false }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("@/components/CleanupRecommendations", () => ({ CleanupRecommendations: () => null }));
vi.mock("@/components/OwnerPinSettings", () => ({ OwnerPinSettings: () => null }));
vi.mock("@/components/GptLadderPanel", () => ({ GptLadderPanel: () => null }));
vi.mock("@/components/GeminiStatusRow", () => ({ GeminiStatusRow: () => null }));

import SettingsPage from "@/app/(app)/settings/page";

beforeEach(() => {
  verifyOwnerPin.mockReset();
  clearLocalCache.mockReset();
  storeState.settings.ownerPinHash = "hash";
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
