import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// The settings page selects many slices; the mock state must cover every selector it uses.
const storeState = {
  settings: { ownerPinHash: "" } as Record<string, unknown>,
  updateSettings: vi.fn(),
  businessId: "demo-business",
  clearLocalCache: vi.fn(),
  aiStatus: null,
  refreshAiStatus: vi.fn().mockResolvedValue(undefined),
  setEmergencyStop: vi.fn(),
  catalog: [] as unknown[],
  verifyOwnerPin: vi.fn(),
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

const getSession = vi.fn();
const signOut = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
  onAuthChange: () => () => {},
  signOut: (...args: unknown[]) => signOut(...args),
}));

import SettingsPage from "@/app/(app)/settings/page";

beforeEach(() => {
  getSession.mockReset();
  signOut.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("settings Account section", () => {
  it("signed-in state renders the email and Sign out calls signOut", async () => {
    getSession.mockResolvedValue({ email: "owner@example.com" });
    render(<SettingsPage />);
    expect(await screen.findByTestId("account-email")).toHaveTextContent("owner@example.com");
    expect(screen.queryByTestId("account-local-mode")).toBeNull();
    fireEvent.click(screen.getByTestId("sign-out"));
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
  });

  it("no-user state renders 'Local mode (no account)' and no Sign out button", async () => {
    getSession.mockResolvedValue(null);
    render(<SettingsPage />);
    expect(await screen.findByTestId("account-local-mode")).toHaveTextContent("Local mode (no account)");
    expect(screen.queryByTestId("sign-out")).toBeNull();
    expect(screen.queryByTestId("account-email")).toBeNull();
  });
});
