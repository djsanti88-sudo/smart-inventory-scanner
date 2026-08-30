// src/users-businesses/BusinessContextGate.authmode.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const isLiveAuth = vi.fn();
vi.mock("@/authentication/service/authMode", () => ({ isLiveAuth: () => isLiveAuth() }));
vi.mock("@/users-businesses/selectedBusiness", () => ({
  SELECTED_BUSINESS_CHANGED_EVENT: "sis:selected-business-changed",
  getSelectedBusinessId: () => null,
  isFirebaseBackend: () => true,
}));
vi.mock("@/authentication/auth", () => ({
  getSession: vi.fn().mockResolvedValue(null),
  listMemberships: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasMeaningfulLegacyBlobAsync: async () => false,
  hasPersistedBlobAsync: async () => false,
  persistKeyForUid: (uid: string | null) => (uid ? `sis-scan-${uid}` : "sis-scan-v1"),
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ businessContextReady: false, businessDataLoaded: false, setBusinessContext: vi.fn() }),
    { getState: () => ({ rehydrateForUid: vi.fn(), adoptLegacyLocalData: vi.fn() }) },
  ),
}));

import { BusinessContextGate } from "./BusinessContextGate";

afterEach(() => cleanup());

describe("BusinessContextGate + AUTH_MODE", () => {
  it("mock mode: cloud=false, children render directly", () => {
    isLiveAuth.mockReturnValue(false);
    render(<BusinessContextGate><div data-testid="child">hi</div></BusinessContextGate>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
  it("live mode + Firebase backend: cloud=true, the gate engages (banner, children withheld)", async () => {
    isLiveAuth.mockReturnValue(true);
    render(<BusinessContextGate><div data-testid="child">hi</div></BusinessContextGate>);
    expect(screen.queryByTestId("child")).toBeNull();
    expect(await screen.findByTestId("business-context-banner")).toBeInTheDocument();
  });
});
