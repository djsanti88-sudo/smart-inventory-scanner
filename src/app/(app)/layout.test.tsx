import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  pathname: "/scan",
  getSession: vi.fn(),
  listMemberships: vi.fn(),
  rehydrateForUid: vi.fn(),
  setBusinessContext: vi.fn(),
}));

vi.mock("@/components/StoreHydrator", () => ({
  StoreHydrator: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/AuthGuard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/Nav", () => ({ Nav: () => <nav aria-label="Application" /> }));
vi.mock("@/components/ProdFirebaseBanner", () => ({ ProdFirebaseBanner: () => null }));
vi.mock("@/services/auth/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  getSelectedBusinessId: () => "shop-1",
  isFirebaseBackend: () => true,
}));
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasLegacyBlob: () => false,
  persistKeyForUid: (uid: string) => `sis-scan-${uid}`,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) => select({
      businessContextReady: true,
      businessDataLoaded: true,
      setBusinessContext: mocks.setBusinessContext,
    }),
    {
      getState: () => ({
        rehydrateForUid: mocks.rehydrateForUid,
        adoptLegacyLocalData: vi.fn(),
      }),
    },
  ),
}));

import AppLayout from "./layout";

afterEach(() => {
  cleanup();
  mocks.pathname = "/scan";
  mocks.getSession.mockReset();
  mocks.listMemberships.mockReset();
  mocks.rehydrateForUid.mockReset();
  mocks.setBusinessContext.mockReset();
});

describe("AppLayout business context", () => {
  it("keeps one validated business bootstrap while sibling route content changes", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([{ businessId: "shop-1" }]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    const view = render(<AppLayout><div>Scan page</div></AppLayout>);

    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("shop-1", "user-1"));
    mocks.pathname = "/review";
    view.rerender(<AppLayout><div>Review page</div></AppLayout>);

    expect(screen.getByText("Review page")).toBeInTheDocument();
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.rehydrateForUid).toHaveBeenCalledTimes(1);
    expect(mocks.setBusinessContext).toHaveBeenCalledTimes(1);
  });

  it("leaves business setup reachable before any business has been selected", async () => {
    mocks.pathname = "/business";
    mocks.getSession.mockResolvedValue(null);

    render(<AppLayout><div>Business setup</div></AppLayout>);

    expect(screen.getByText("Business setup")).toBeInTheDocument();
    await Promise.resolve();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});
