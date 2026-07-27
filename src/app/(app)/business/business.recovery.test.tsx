import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  createBusiness: vi.fn(),
  ensureWorkspace: vi.fn(),
  listMemberships: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  createBusiness: (...args: unknown[]) => mocks.createBusiness(...args),
  ensureWorkspace: (...args: unknown[]) => mocks.ensureWorkspace(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
  signOut: vi.fn(),
}));
vi.mock("@/lib/selectedBusiness", () => ({ setSelectedBusinessId: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: {
    getState: () => ({
      prepareSignOut: vi.fn().mockResolvedValue(0),
      resetForSignOut: vi.fn(),
    }),
  },
}));

import BusinessPage from "./page";

beforeEach(() => {
  mocks.createBusiness.mockReset();
  mocks.ensureWorkspace.mockReset();
  mocks.listMemberships.mockReset();
});
afterEach(() => cleanup());

describe("business page recovery", () => {
  it("shows a retry action when memberships cannot be loaded", async () => {
    mocks.listMemberships.mockRejectedValue(new Error("Firebase private detail"));
    render(<BusinessPage />);

    expect(await screen.findByTestId("business-load-error")).toHaveTextContent(
      "We could not load your businesses.",
    );
    expect(screen.getByTestId("retry-business-load")).toBeInTheDocument();
  });

  it("repairs a missing default workspace and refreshes memberships", async () => {
    mocks.listMemberships
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "b1_u1",
          businessId: "b1",
          businessName: "My Business",
          userId: "u1",
          role: "owner",
        },
      ]);
    mocks.ensureWorkspace.mockResolvedValue({
      status: "ready",
      accountCreated: false,
      businessId: "b1",
      error: null,
    });
    render(<BusinessPage />);

    fireEvent.click(await screen.findByTestId("repair-workspace"));

    await waitFor(() => expect(mocks.ensureWorkspace).toHaveBeenCalledOnce());
    expect(await screen.findByText("My Business")).toBeInTheDocument();
  });

  it("keeps a safe visible error when named business creation fails", async () => {
    mocks.listMemberships.mockResolvedValue([]);
    mocks.createBusiness.mockResolvedValue({
      businessId: null,
      error: "We could not create the business. Please try again.",
    });
    render(<BusinessPage />);
    fireEvent.change(await screen.findByTestId("business-name"), {
      target: { value: "Main Street Auto" },
    });
    fireEvent.click(screen.getByTestId("create-business"));

    expect(await screen.findByTestId("business-error")).toHaveTextContent(
      "We could not create the business.",
    );
  });

  it("shows the business name instead of its raw document ID", async () => {
    mocks.listMemberships.mockResolvedValue([{
      id: "opaque-business_user-1",
      businessId: "opaque-business",
      businessName: "Main Street Auto",
      userId: "user-1",
      role: "owner",
    }]);
    render(<BusinessPage />);

    expect(await screen.findByText("Main Street Auto")).toBeInTheDocument();
    expect(screen.queryByText("opaque-business")).not.toBeInTheDocument();
  });
});
