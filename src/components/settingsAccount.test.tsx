import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// The shared sign-out flow reaches for these via useScanStore.getState(); the button/deletion handlers
// must route through them (full tenant wipe + real signOut) so the next user sees no prior-tenant residue.
const prepareSignOut = vi.fn().mockResolvedValue(0);
const resetForSignOut = vi.fn();

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
  prepareSignOut,
  resetForSignOut,
  pendingCount: () => 0,
};
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (sel: (s: typeof storeState) => unknown) => sel(storeState),
    { getState: () => storeState },
  ),
}));
vi.mock("@/stores/reconcileStore", () => ({
  useReconcileStore: { getState: () => ({ clearLocalCache: vi.fn() }) },
}));
vi.mock("@/services/security/useAccessLevel", () => ({ useIsPlatformOwner: () => false }));
vi.mock("@/components/ExportMenu", () => ({ ExportMenu: () => null }));
vi.mock("@/components/CleanupRecommendations", () => ({ CleanupRecommendations: () => null }));
vi.mock("@/components/OwnerPinSettings", () => ({ OwnerPinSettings: () => null }));
vi.mock("@/components/GptDecodePanel", () => ({ GptDecodePanel: () => null }));

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
  signOut.mockReset().mockResolvedValue(undefined);
  prepareSignOut.mockReset().mockResolvedValue(0);
  resetForSignOut.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("settings Account section", () => {
  it("signed-in state renders the email and Sign out runs the FULL shared flow (wipe THEN signOut)", async () => {
    // C1 fix: the button must not bypass the tenant wipe - resetForSignOut must run before signOut, or
    // the next user on this browser inherits the prior tenant's data from localStorage.
    getSession.mockResolvedValue({ email: "owner@example.com" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const order: string[] = [];
    resetForSignOut.mockImplementation(() => order.push("reset"));
    signOut.mockImplementation(async () => {
      order.push("signOut");
    });

    render(<SettingsPage />);
    expect(await screen.findByTestId("account-email")).toHaveTextContent("owner@example.com");
    expect(screen.queryByTestId("account-local-mode")).toBeNull();
    fireEvent.click(screen.getByTestId("sign-out"));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(resetForSignOut).toHaveBeenCalledOnce();
    expect(order).toEqual(["reset", "signOut"]);
  });

  it("Sign out warns HONESTLY about queued changes across businesses, and cancel aborts entirely", async () => {
    getSession.mockResolvedValue({ email: "owner@example.com" });
    prepareSignOut.mockResolvedValue(2);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<SettingsPage />);
    await screen.findByTestId("account-email");
    fireEvent.click(screen.getByTestId("sign-out"));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const warning = confirmSpy.mock.calls[0]?.[0] ?? "";
    expect(warning).toContain("2 queued changes could not sync");
    expect(warning).toContain("across your businesses");
    // cancel: no wipe, no signOut
    expect(resetForSignOut).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("no-user state renders 'Local mode (no account)' and no Sign out button", async () => {
    getSession.mockResolvedValue(null);
    render(<SettingsPage />);
    expect(await screen.findByTestId("account-local-mode")).toHaveTextContent("Local mode (no account)");
    expect(screen.queryByTestId("sign-out")).toBeNull();
    expect(screen.queryByTestId("account-email")).toBeNull();
  });
});

describe("settings account deletion purges local tenant state (F2)", () => {
  it("on successful deletion: resetForSignOut runs, then redirect to /login", async () => {
    getSession.mockResolvedValue({
      email: "owner@example.com",
      getIdToken: vi.fn().mockResolvedValue("id-token"),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const hrefSet = vi.fn();
    // window.location.href assignment -> capture without navigating.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { set href(v: string) { hrefSet(v); }, get href() { return "http://localhost/"; } },
    });

    render(<SettingsPage />);
    await screen.findByTestId("account-email");
    fireEvent.click(screen.getByTestId("delete-account"));
    fireEvent.change(await screen.findByTestId("delete-account-phrase"), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    // F2: local tenant state MUST be wiped so the deleted business does not ghost into the next session.
    await waitFor(() => expect(resetForSignOut).toHaveBeenCalledOnce());
    expect(signOut).toHaveBeenCalledOnce();
    expect(hrefSet).toHaveBeenCalledWith("/login");
  });
});
