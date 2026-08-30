import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Spec 2 (M1, kill-switch visibility): Settings must render the KillSwitchBanner when the server
// reports killSwitchOn: true (platformOwner-only section, same as the rest of "Live AI status"). This
// test uses isPlatform: true (unlike settingsClearCache.pin.test.tsx / settingsAccount.test.tsx, which
// keep it false and never reach this section) and a FULL aiStatus object, since the real page reads
// many aiStatus.* fields once that section renders.
const storeState = {
  settings: { ownerPinHash: "", dailyLookupCount: 0, dailyLookupLimit: 200 } as Record<string, unknown>,
  updateSettings: () => {},
  businessId: "demo-business",
  clearLocalCache: () => {},
  aiStatus: {
    mode: "aggressive",
    autoDecodeOnScan: true,
    openaiConfigured: true,
    lastAttemptAt: null,
    lastProvider: "",
    lastFailureReason: "",
    emergencyStop: false,
    missingKeys: [] as string[],
    killSwitchOn: false,
  },
  refreshAiStatus: async () => {},
  setEmergencyStop: () => {},
  catalog: [] as unknown[],
  verifyOwnerPin: async () => true,
  pendingCount: () => 0,
};
vi.mock("@/stores/scanStore", () => ({
  useScanStore: (sel: (s: typeof storeState) => unknown) => sel(storeState),
}));
vi.mock("@/stores/reconcileStore", () => ({
  useReconcileStore: { getState: () => ({ clearLocalCache: () => {} }) },
}));
vi.mock("@/users-businesses/roles/useAccessLevel", () => ({ useIsPlatformOwner: () => true }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("@/inventory/cleanup/CleanupRecommendations", () => ({ CleanupRecommendations: () => null }));
vi.mock("@/sessions/lock/OwnerPinSettings", () => ({ OwnerPinSettings: () => null }));
vi.mock("@/components/GptDecodePanel", () => ({ GptDecodePanel: () => null }));

import SettingsPage from "@/app/(app)/settings/page";

afterEach(() => cleanup());

describe("Settings: kill-switch banner (Spec 2)", () => {
  it("does not render the banner when killSwitchOn is false", () => {
    storeState.aiStatus.killSwitchOn = false;
    render(<SettingsPage />);
    expect(screen.queryByTestId("kill-switch-banner")).toBeNull();
  });

  it("renders the banner when aiStatus.killSwitchOn is true", () => {
    storeState.aiStatus.killSwitchOn = true;
    render(<SettingsPage />);
    expect(screen.getByTestId("kill-switch-banner")).toBeInTheDocument();
  });
});
