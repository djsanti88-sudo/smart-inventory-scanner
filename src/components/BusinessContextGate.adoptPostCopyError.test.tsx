// src/components/BusinessContextGate.adoptPostCopyError.test.tsx
// Task 1 (B4, product honesty): adoptLegacyLocalData's migrate step copies the anon blob to the
// per-uid key AND DELETES the legacy blob, then rehydrateForUid/setBusinessContext run. If a throw
// happens AFTER the copy stage, the anon blob is GONE and the per-uid key already holds the adopted
// data - showing "your local data is still safe" and still offering "Start fresh" would let the owner
// pick start-fresh and silently get the just-adopted inventory anyway (start fresh re-points persist
// at the SAME per-uid key, which is no longer empty). scanStore tags such a failure with
// `postCopyAdoptFailure: true` on the thrown Error; the gate must render an accurate message and hide
// "Start fresh" only in that state, while a PRE-copy failure keeps the existing honest message + both
// options (covered by BusinessContextGate.adoptError.test.tsx, unchanged).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listMemberships: vi.fn(),
  setBusinessContext: vi.fn(),
  rehydrateForUid: vi.fn(),
  adoptLegacyLocalData: vi.fn(),
}));

vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  SELECTED_BUSINESS_CHANGED_EVENT: "sis:selected-business-changed",
  getSelectedBusinessId: () => "biz-1",
  isFirebaseBackend: () => true,
}));
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasMeaningfulLegacyBlobAsync: async () => true,
  hasPersistedBlobAsync: async () => false,
  persistKeyForUid: () => "sis-scan-user",
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) =>
      select({
        businessContextReady: false,
        businessDataLoaded: false,
        setBusinessContext: mocks.setBusinessContext,
      }),
    {
      getState: () => ({
        rehydrateForUid: mocks.rehydrateForUid,
        adoptLegacyLocalData: mocks.adoptLegacyLocalData,
      }),
    },
  ),
}));

import { BusinessContextGate } from "./BusinessContextGate";

function postCopyError(message: string): Error {
  const err = new Error(message) as Error & { postCopyAdoptFailure?: true };
  err.postCopyAdoptFailure = true;
  return err;
}

afterEach(() => {
  cleanup();
  mocks.getSession.mockReset();
  mocks.listMemberships.mockReset();
  mocks.setBusinessContext.mockReset();
  mocks.rehydrateForUid.mockReset();
  mocks.adoptLegacyLocalData.mockReset();
});

const membership = [{
  id: "active_user-1",
  businessId: "biz-1",
  businessName: "Adopt Shop",
  userId: "user-1",
  role: "owner",
}];

describe("BusinessContextGate post-copy adopt failure (B4)", () => {
  it("shows the accurate post-copy message and hides Start fresh; retry completes adoption", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue(membership);
    mocks.adoptLegacyLocalData
      .mockRejectedValueOnce(postCopyError("rehydrate blew up"))
      .mockResolvedValueOnce(undefined);

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("adopt-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("adopt-data"));

    // Accurate post-copy message, NOT the "still safe on this device" pre-copy message.
    expect(await screen.findByTestId("adopt-error-postcopy")).toBeInTheDocument();
    expect(screen.queryByTestId("adopt-error")).toBeNull();
    expect(screen.getByTestId("adopt-error-postcopy").textContent).toMatch(
      /copied to your account but finishing setup failed/i,
    );

    // "Start fresh" must be gone in this state: it would silently re-point at the already-adopted key.
    expect(screen.queryByTestId("skip-adopt")).toBeNull();
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();

    // Retry is the only path, and it is proven idempotent (existing contract) - it must complete.
    fireEvent.click(screen.getByTestId("retry-adopt"));
    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-1", "user-1"));
    expect(mocks.adoptLegacyLocalData).toHaveBeenCalledTimes(2);
  });

  // F5 (tier-3 review round 3, 2026-08-09): classifying "post-copy" ONLY from the thrown error's tag
  // left the window one line too narrow. adoptLegacyLocalData can resolve (the copy landed, the anon
  // blob is already gone) and the NEXT line - setBusinessContext - can still throw an untagged error.
  // The catch then showed the pre-copy "your data is still safe" copy plus "Start fresh": the exact
  // false-safety bug B4 fixed, just relocated one statement later.
  it("treats a throw from setBusinessContext (AFTER the copy resolved) as post-copy too", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue(membership);
    mocks.adoptLegacyLocalData.mockResolvedValue(undefined); // the copy LANDED: anon blob is gone
    mocks.setBusinessContext.mockImplementationOnce(() => {
      throw new Error("context wiring blew up after the copy");
    });

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("adopt-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("adopt-data"));

    expect(await screen.findByTestId("adopt-error-postcopy")).toBeInTheDocument();
    expect(screen.queryByTestId("adopt-error")).toBeNull();
    // No "Start fresh": the per-uid key already holds the adopted data, so it would not start fresh.
    expect(screen.queryByTestId("skip-adopt")).toBeNull();
  });

  it("a PRE-copy failure (untagged Error) still keeps both options and the original honest message", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue(membership);
    mocks.adoptLegacyLocalData.mockRejectedValueOnce(new Error("network blip before copy"));

    render(<BusinessContextGate><div data-testid="child">scanner</div></BusinessContextGate>);

    expect(await screen.findByTestId("adopt-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("adopt-data"));

    expect(await screen.findByTestId("adopt-error")).toBeInTheDocument();
    expect(screen.queryByTestId("adopt-error-postcopy")).toBeNull();
    // Start fresh remains available for a pre-copy failure (anon blob untouched).
    expect(screen.getByTestId("skip-adopt")).toBeInTheDocument();
  });
});
