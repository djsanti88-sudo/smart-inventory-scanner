import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import BusinessPage from "@/app/(app)/business/page";

// Owner report 2026-07-22: after creating a business with a typed name, the list showed "a random
// name that almost looks like a code string" - the raw businessId UUID was rendered instead of the
// saved business name. The name IS stored on the businesses doc; the list must join and show it.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/selectedBusiness", () => ({
  SELECTED_BUSINESS_CHANGED_EVENT: "sis:selected-business-changed",
  setSelectedBusinessId: vi.fn(),
}));
vi.mock("@/stores/scanStore", () => ({
  useScanStore: { getState: () => ({ prepareSignOut: vi.fn().mockResolvedValue(0), resetForSignOut: vi.fn() }) },
}));
// listMemberships resolves the business name onto each Membership (server-validated join), so the
// list renders the saved NAME directly - no separate name-fetch helper.
vi.mock("@/authentication/auth", () => ({
  createBusiness: vi.fn(),
  createBusinessMember: vi.fn(),
  ensureWorkspace: vi.fn(),
  signOut: vi.fn(),
  listMemberships: vi.fn().mockResolvedValue([
    {
      id: "b-uuid-1234_u1",
      businessId: "b-uuid-1234-abcd-9999",
      userId: "u1",
      role: "owner",
      businessName: "Polo's Point Tires",
    },
  ]),
}));

afterEach(() => cleanup());

describe("BusinessPage - membership list shows the business NAME, not the raw id", () => {
  it("renders the saved business name; the UUID is not the visible label", async () => {
    render(<BusinessPage />);
    await waitFor(() => expect(screen.getByText("Polo's Point Tires")).toBeTruthy());
    expect(screen.queryByText("b-uuid-1234-abcd-9999")).toBeNull();
  });
});
