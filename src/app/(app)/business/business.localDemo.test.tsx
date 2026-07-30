import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  createBusiness: vi.fn(),
  createBusinessMember: vi.fn(),
  ensureWorkspace: vi.fn(),
  listMemberships: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  createBusiness: (...args: unknown[]) => mocks.createBusiness(...args),
  createBusinessMember: (...args: unknown[]) => mocks.createBusinessMember(...args),
  ensureWorkspace: (...args: unknown[]) => mocks.ensureWorkspace(...args),
  listMemberships: (...args: unknown[]) => mocks.listMemberships(...args),
  signOut: (...args: unknown[]) => mocks.signOut(...args),
}));
vi.mock("@/lib/selectedBusiness", () => ({ setSelectedBusinessId: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/stores/scanStore", () => ({ useScanStore: { getState: vi.fn() } }));

import BusinessPage from "./page";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
  Object.values(mocks).forEach((mock) => mock.mockReset());
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("BusinessPage local demo", () => {
  it("keeps business management unavailable without starting any Firebase-backed operation", () => {
    render(<BusinessPage />);

    expect(screen.getByText("Business management is unavailable in the local demo.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to scan" })).toHaveAttribute("href", "/scan");
    expect(mocks.listMemberships).not.toHaveBeenCalled();
    expect(mocks.createBusiness).not.toHaveBeenCalled();
    expect(mocks.createBusinessMember).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
