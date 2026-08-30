import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const state = {
    businessContextReady: false,
    businessDataLoaded: false,
  };
  return {
    getSession: vi.fn(),
    listMemberships: vi.fn(),
    setBusinessContext: vi.fn((businessId: string, uid: string) => {
      state.businessContextReady = true;
      state.businessDataLoaded = true;
      return { businessId, uid };
    }),
    rehydrateForUid: vi.fn(),
    hasMeaningfulLegacyBlobAsync: vi.fn(),
    hasPersistedBlobAsync: vi.fn(),
    getSelectedBusinessId: vi.fn(),
    setSelectedBusinessId: vi.fn(),
    push: vi.fn(),
    state,
  };
});

let selectedBusinessId: string | null = null;
let routePushHandler: ((href: string) => void) | null = null;

vi.mock("@/authentication/service/authMode", () => ({ isLiveAuth: () => true }));
vi.mock("@/lib/selectedBusiness", () => ({
  SELECTED_BUSINESS_CHANGED_EVENT: "sis:selected-business-changed",
  getSelectedBusinessId: () => mocks.getSelectedBusinessId(),
  setSelectedBusinessId: (...args: unknown[]) => mocks.setSelectedBusinessId(...args),
  isFirebaseBackend: () => true,
}));
vi.mock("@/authentication/auth", () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
  createBusiness: vi.fn(),
  createBusinessMember: vi.fn(),
  ensureWorkspace: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      mocks.push(href);
      routePushHandler?.(href);
    },
    replace: vi.fn(),
  }),
}));
vi.mock("@/stores/scanPersistNamespace", () => ({
  hasMeaningfulLegacyBlobAsync: (...args: unknown[]) => mocks.hasMeaningfulLegacyBlobAsync(...args),
  hasPersistedBlobAsync: (...args: unknown[]) => mocks.hasPersistedBlobAsync(...args),
  persistKeyForUid: (uid: string | null) => (uid ? `sis-scan-${uid}` : "sis-scan-v1"),
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) =>
      select({
        businessContextReady: mocks.state.businessContextReady,
        businessDataLoaded: mocks.state.businessDataLoaded,
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

import * as BusinessContextGateModule from "./BusinessContextGate";
import BusinessPage from "@/app/(app)/business/page";

const BusinessContextProvider =
  (BusinessContextGateModule as typeof BusinessContextGateModule & {
    BusinessContextProvider?: React.ComponentType<{ children: React.ReactNode }>;
  }).BusinessContextProvider ?? React.Fragment;
const { BusinessContextGate } = BusinessContextGateModule;

function membership(userId = "user-1") {
  return {
    id: `active_${userId}`,
    businessId: "biz-1",
    businessName: "Persistent Shop",
    userId,
    role: "owner",
  };
}

function businessMembership(businessId: string, businessName: string, userId = "user-1") {
  return {
    id: `${businessId}_${userId}`,
    businessId,
    businessName,
    userId,
    role: "owner",
  };
}

function PageGate({ route }: { route: string }) {
  return (
    <BusinessContextGate key={route}>
      <div data-testid="page">{route}</div>
    </BusinessContextGate>
  );
}

function PersistentProviderHarness() {
  const [route, setRoute] = React.useState("Scan");
  return (
    <BusinessContextProvider>
      <button type="button" onClick={() => setRoute("History")}>History</button>
      <button type="button" onClick={() => setRoute("Reconcile")}>Reconcile</button>
      <button type="button" onClick={() => setRoute("Settings")}>Settings</button>
      <button type="button" onClick={() => setRoute("Scan")}>Scan</button>
      <PageGate route={route} />
    </BusinessContextProvider>
  );
}

function BusinessSelectionHarness() {
  const [route, setRoute] = React.useState("Business");
  React.useEffect(() => {
    routePushHandler = (href: string) => {
      if (href === "/scan") setRoute("Scan");
    };
    return () => {
      routePushHandler = null;
    };
  }, []);
  return (
    <BusinessContextProvider>
      {route === "Business" ? <BusinessPage /> : <PageGate route="Scan" />}
    </BusinessContextProvider>
  );
}

function ReadyBusinessSwitchHarness() {
  const [route, setRoute] = React.useState("Scan");
  return (
    <BusinessContextProvider>
      {route === "Switch" ? (
        <button
          type="button"
          data-testid="select-business-biz-b"
          onClick={() => {
            mocks.setSelectedBusinessId("biz-b");
            window.dispatchEvent(
              new CustomEvent("sis:selected-business-changed", { detail: { businessId: "biz-b" } }),
            );
            setRoute("Scan");
          }}
        >
          Select Shop B
        </button>
      ) : (
        <>
          <button type="button" data-testid="go-switch" onClick={() => setRoute("Switch")}>Switch business</button>
          <PageGate route="Scan" />
        </>
      )}
    </BusinessContextProvider>
  );
}

afterEach(() => {
  cleanup();
  mocks.getSession.mockReset();
  mocks.listMemberships.mockReset();
  mocks.setBusinessContext.mockClear();
  mocks.rehydrateForUid.mockReset();
  mocks.hasMeaningfulLegacyBlobAsync.mockReset();
  mocks.hasPersistedBlobAsync.mockReset();
  mocks.getSelectedBusinessId.mockReset();
  mocks.setSelectedBusinessId.mockReset();
  mocks.push.mockReset();
  mocks.state.businessContextReady = false;
  mocks.state.businessDataLoaded = false;
  selectedBusinessId = null;
  routePushHandler = null;
});

describe("BusinessContextGate persistent provider", () => {
  it("keeps authenticated business bootstrap alive while page-level gates remount across navigation", async () => {
    mocks.getSelectedBusinessId.mockReturnValue("biz-1");
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([membership()]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);
    mocks.hasMeaningfulLegacyBlobAsync.mockResolvedValue(false);
    mocks.hasPersistedBlobAsync.mockResolvedValue(false);

    render(<PersistentProviderHarness />);

    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("Scan"));
    expect(screen.queryByTestId("business-loading")).toBeNull();

    for (let i = 0; i < 3; i += 1) {
      screen.getByRole("button", { name: "History" }).click();
      await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("History"));
      screen.getByRole("button", { name: "Reconcile" }).click();
      await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("Reconcile"));
      screen.getByRole("button", { name: "Settings" }).click();
      await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("Settings"));
      screen.getByRole("button", { name: "Scan" }).click();
      await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("Scan"));
      expect(screen.queryByTestId("business-loading")).toBeNull();
    }

    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.listMemberships).toHaveBeenCalledTimes(1);
    expect(mocks.rehydrateForUid).toHaveBeenCalledTimes(1);
    expect(mocks.setBusinessContext).toHaveBeenCalledTimes(1);
    expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-1", "user-1");
  });

  it("fails closed when the selected business is not in the authenticated membership list", async () => {
    mocks.getSelectedBusinessId.mockReturnValue("biz-1");
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);
    mocks.hasMeaningfulLegacyBlobAsync.mockResolvedValue(false);
    mocks.hasPersistedBlobAsync.mockResolvedValue(false);

    render(
      <BusinessContextProvider>
        <BusinessContextGate>
          <div data-testid="page">Scan</div>
        </BusinessContextGate>
      </BusinessContextProvider>,
    );

    expect(await screen.findByTestId("business-context-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("page")).toBeNull();
    expect(mocks.rehydrateForUid).not.toHaveBeenCalled();
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();
  });

  it("fails closed when the selected membership belongs to a different signed-in user", async () => {
    mocks.getSelectedBusinessId.mockReturnValue("biz-1");
    mocks.getSession.mockResolvedValue({ uid: "user-2" });
    mocks.listMemberships.mockResolvedValue([membership("user-1")]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);
    mocks.hasMeaningfulLegacyBlobAsync.mockResolvedValue(false);
    mocks.hasPersistedBlobAsync.mockResolvedValue(false);

    render(
      <BusinessContextProvider>
        <BusinessContextGate>
          <div data-testid="page">Scan</div>
        </BusinessContextGate>
      </BusinessContextProvider>,
    );

    expect(await screen.findByTestId("business-context-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("page")).toBeNull();
    expect(mocks.rehydrateForUid).not.toHaveBeenCalled();
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();
  });

  it("revalidates after a business page selection before rendering the gated scan page", async () => {
    mocks.getSelectedBusinessId.mockImplementation(() => selectedBusinessId);
    mocks.setSelectedBusinessId.mockImplementation((businessId: string) => {
      selectedBusinessId = businessId;
    });
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    mocks.listMemberships.mockResolvedValue([membership()]);
    mocks.rehydrateForUid.mockResolvedValue(undefined);
    mocks.hasMeaningfulLegacyBlobAsync.mockResolvedValue(false);
    mocks.hasPersistedBlobAsync.mockResolvedValue(false);

    render(<BusinessSelectionHarness />);

    expect(await screen.findByTestId("select-business-biz-1")).toBeInTheDocument();
    expect(mocks.setBusinessContext).not.toHaveBeenCalled();

    screen.getByTestId("select-business-biz-1").click();

    await waitFor(() => expect(screen.getByTestId("page")).toHaveTextContent("Scan"));
    expect(mocks.setBusinessContext).toHaveBeenCalledTimes(1);
    expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-1", "user-1");
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.listMemberships).toHaveBeenCalledTimes(3); // provider initial + BusinessPage list + provider revalidation
    expect(mocks.rehydrateForUid).toHaveBeenCalledTimes(1);
    const lastMembershipValidation =
      mocks.listMemberships.mock.invocationCallOrder[mocks.listMemberships.mock.invocationCallOrder.length - 1];
    const businessContextSet = mocks.setBusinessContext.mock.invocationCallOrder[0];
    expect(lastMembershipValidation).toBeLessThan(businessContextSet);
  });

  it("withholds gated scan content during an already-ready switch until the new business is validated", async () => {
    selectedBusinessId = "biz-a";
    mocks.state.businessContextReady = true;
    mocks.state.businessDataLoaded = true;
    mocks.getSelectedBusinessId.mockImplementation(() => selectedBusinessId);
    mocks.setSelectedBusinessId.mockImplementation((businessId: string) => {
      selectedBusinessId = businessId;
    });
    mocks.getSession.mockResolvedValue({ uid: "user-1" });
    let resolveBizBMemberships: (memberships: ReturnType<typeof businessMembership>[]) => void = () => {};
    mocks.listMemberships
      .mockResolvedValueOnce([businessMembership("biz-a", "Shop A")])
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveBizBMemberships = resolve;
      }));
    mocks.rehydrateForUid.mockResolvedValue(undefined);
    mocks.hasMeaningfulLegacyBlobAsync.mockResolvedValue(false);
    mocks.hasPersistedBlobAsync.mockResolvedValue(false);

    render(<ReadyBusinessSwitchHarness />);

    expect(await screen.findByTestId("page")).toHaveTextContent("Scan");
    expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-a", "user-1");
    mocks.setBusinessContext.mockClear();
    screen.getByTestId("go-switch").click();
    expect(await screen.findByTestId("select-business-biz-b")).toBeInTheDocument();

    screen.getByTestId("select-business-biz-b").click();

    await waitFor(() => expect(screen.queryByTestId("select-business-biz-b")).toBeNull());
    expect(screen.queryByTestId("page")).toBeNull();
    expect(screen.getByTestId("business-loading")).toBeInTheDocument();

    resolveBizBMemberships([businessMembership("biz-b", "Shop B")]);
    await waitFor(() => expect(mocks.setBusinessContext).toHaveBeenCalledWith("biz-b", "user-1"));
    expect(screen.getByTestId("page")).toHaveTextContent("Scan");
  });
});
