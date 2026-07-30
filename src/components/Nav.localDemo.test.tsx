import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScanStore } from "@/stores/scanStore";

vi.mock("next/navigation", () => ({
  usePathname: () => "/scan",
  useRouter: () => ({ replace: vi.fn() }),
}));

import { Nav } from "./Nav";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Nav local tire demo boundary", () => {
  it("shows Report and hides Reconcile in local demo mode", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    useScanStore.setState({ needsReviewQueue: [] });
    render(<Nav />);
    expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/report");
    expect(screen.queryByRole("link", { name: "Reconcile" })).toBeNull();
  });

  it("keeps Reconcile available outside local demo mode", () => {
    useScanStore.setState({ needsReviewQueue: [] });
    render(<Nav />);
    expect(screen.getByRole("link", { name: "Reconcile" })).toHaveAttribute("href", "/reconcile");
  });
});
