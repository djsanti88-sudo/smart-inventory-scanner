import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// D2 (Phase 6): Danger-zone "Delete account and all data" UI. Mirrors the mock shape of
// settingsClearCache.pin.test.tsx (PIN gate) and settingsAccount.test.tsx (auth state).

const verifyOwnerPin = vi.fn();
const clearLocalCache = vi.fn();

const storeState = {
  settings: { ownerPinHash: "" } as Record<string, unknown>,
  updateSettings: vi.fn(),
  businessId: "biz-1",
  clearLocalCache: () => clearLocalCache(),
  aiStatus: null,
  refreshAiStatus: vi.fn().mockResolvedValue(undefined),
  setEmergencyStop: vi.fn(),
  catalog: [] as unknown[],
  verifyOwnerPin: (p: string) => verifyOwnerPin(p),
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
vi.mock("@/decoding/panel/GptDecodePanel", () => ({ GptDecodePanel: () => null }));

const getIdToken = vi.fn().mockResolvedValue("id-token-123");
const getSession = vi.fn();
vi.mock("@/authentication/auth", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
  onAuthChange: () => () => {},
  signOut: vi.fn(),
}));

import SettingsPage from "@/app/(app)/settings/page";

const fetchMock = vi.fn();

beforeEach(() => {
  verifyOwnerPin.mockReset();
  clearLocalCache.mockReset();
  getIdToken.mockClear();
  storeState.settings.ownerPinHash = "";
  storeState.businessId = "biz-1";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Danger zone: delete account gate", () => {
  it("the delete button is disabled and shows a sign-in note when signed out", async () => {
    getSession.mockResolvedValue(null);
    render(<SettingsPage />);
    const btn = await screen.findByTestId("delete-account");
    expect(btn).toBeDisabled();
    expect(screen.getByTestId("delete-account-signin-required")).toBeInTheDocument();
  });

  it("requires the exact typed confirm phrase before calling the API", async () => {
    getSession.mockResolvedValue({ email: "owner@example.com", getIdToken });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByTestId("delete-account"));
    const phraseInput = await screen.findByTestId("delete-account-phrase");
    fireEvent.change(phraseInput, { target: { value: "delete my account" } }); // wrong case
    fireEvent.click(screen.getByTestId("delete-account-confirm"));
    const err = await screen.findByTestId("delete-account-error");
    expect(err.textContent).toMatch(/DELETE MY ACCOUNT/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on a correct phrase, POSTs to /api/account/delete with idToken + businessId + confirmPhrase", async () => {
    getSession.mockResolvedValue({ email: "owner@example.com", getIdToken });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ deleted: true, businessId: "biz-1" }),
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByTestId("delete-account"));
    const phraseInput = await screen.findByTestId("delete-account-phrase");
    fireEvent.change(phraseInput, { target: { value: "DELETE MY ACCOUNT" } });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/account/delete");
    const parsedBody = JSON.parse(opts.body as string);
    expect(parsedBody).toEqual({
      businessId: "biz-1",
      idToken: "id-token-123",
      confirmPhrase: "DELETE MY ACCOUNT",
    });
  });

  it("surfaces the server's honest error message and does not navigate away on failure", async () => {
    getSession.mockResolvedValue({ email: "owner@example.com", getIdToken });
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Only the business owner can delete this account." }),
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByTestId("delete-account"));
    const phraseInput = await screen.findByTestId("delete-account-phrase");
    fireEvent.change(phraseInput, { target: { value: "DELETE MY ACCOUNT" } });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    const err = await screen.findByTestId("delete-account-error");
    expect(err).toHaveTextContent("Only the business owner can delete this account.");
  });

  it("requires the owner PIN when one is set, before the phrase check succeeds", async () => {
    storeState.settings.ownerPinHash = "hash";
    verifyOwnerPin.mockResolvedValue(false);
    getSession.mockResolvedValue({ email: "owner@example.com", getIdToken });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByTestId("delete-account"));
    const phraseInput = await screen.findByTestId("delete-account-phrase");
    fireEvent.change(phraseInput, { target: { value: "DELETE MY ACCOUNT" } });
    const pinInput = await screen.findByTestId("delete-account-pin");
    fireEvent.change(pinInput, { target: { value: "0000" } });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => expect(verifyOwnerPin).toHaveBeenCalledWith("0000"));
    const err = await screen.findByTestId("delete-account-error");
    expect(err).toHaveTextContent("Wrong PIN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("links the eye toward Export first via the export-first nudge copy", async () => {
    getSession.mockResolvedValue({ email: "owner@example.com", getIdToken });
    render(<SettingsPage />);
    expect(screen.getByText(/Export your data first\. Deletion is permanent\./)).toBeInTheDocument();
  });
});
