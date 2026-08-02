import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  pathname: "/scan",
  selectedBusinessId: "shop-1" as string | null,
  businessContextReady: true,
  businessDataLoaded: true,
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
  getSelectedBusinessId: () => mocks.selectedBusinessId,
  isFirebaseBackend: () => true,
}));
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  inspectLegacyAdoptionCandidate: () => Promise.resolve("absent"),
  persistKeyForUid: (uid: string) => `sis-scan-${uid}`,
}));
vi.mock("@/stores/scanPersistStorage", () => ({
  getPersistedStatePresence: () => Promise.resolve("absent"),
  getAuthoritativePersistFallback: () => null,
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
      businessContextReady: mocks.businessContextReady,
      businessDataLoaded: mocks.businessDataLoaded,
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
  mocks.selectedBusinessId = "shop-1";
  mocks.businessContextReady = true;
  mocks.businessDataLoaded = true;
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

  it("retries a rejected bootstrap when navigating to a sibling protected route", async () => {
    mocks.getSession.mockRejectedValueOnce(new Error("temporary auth outage"));

    const view = render(<AppLayout><div>Scan page</div></AppLayout>);

    expect(await screen.findByTestId("business-context-error")).toBeInTheDocument();
    expect(screen.queryByText("Scan page")).toBeNull();

    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([{ businessId: "shop-1" }]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);
    mocks.pathname = "/review";
    view.rerender(<AppLayout><div>Review page</div></AppLayout>);

    expect(await screen.findByText("Review page")).toBeInTheDocument();
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it("withholds a protected scan page when no user is signed in", async () => {
    mocks.getSession.mockResolvedValue(null);

    render(<AppLayout><div>Scan page</div></AppLayout>);

    expect(await screen.findByTestId("business-context-banner")).toHaveTextContent("You are not signed in");
    expect(screen.queryByText("Scan page")).toBeNull();
  });

  it("withholds a protected scan page when its selected business is not a membership", async () => {
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([]);

    render(<AppLayout><div>Scan page</div></AppLayout>);

    expect(await screen.findByTestId("business-context-banner")).toHaveTextContent("Select or create a business");
    expect(screen.queryByText("Scan page")).toBeNull();
  });

  it("withholds a protected scan page until the selected business data has loaded", async () => {
    mocks.businessContextReady = false;
    mocks.businessDataLoaded = false;
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([{ businessId: "shop-1" }]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);

    render(<AppLayout><div>Scan page</div></AppLayout>);

    expect(await screen.findByTestId("business-loading")).toBeInTheDocument();
    expect(screen.queryByText("Scan page")).toBeNull();
  });
});
