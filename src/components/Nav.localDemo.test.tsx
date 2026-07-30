import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScanStore } from "@/stores/scanStore";

const mocks = vi.hoisted(() => ({
  pathname: "/scan",
  searchParams: new URLSearchParams(),
  suspendSearchParams: false,
  pendingSearchParams: new Promise<never>(() => {}),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => {
    if (mocks.suspendSearchParams) throw mocks.pendingSearchParams;
    return mocks.searchParams;
  },
  useRouter: () => ({ replace: vi.fn() }),
}));

import { Nav } from "./Nav";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.pathname = "/scan";
  mocks.searchParams = new URLSearchParams();
  mocks.suspendSearchParams = false;
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

  it("carries a canonical proof batch only to the Report link", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    mocks.searchParams = new URLSearchParams("proofBatch=01");
    useScanStore.setState({ needsReviewQueue: [] });

    render(<Nav />);

    expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/report?proofBatch=01");
    expect(screen.getByRole("link", { name: "Scan" })).toHaveAttribute("href", "/scan");
  });

  it("does not carry a proof batch outside local demo mode", () => {
    mocks.searchParams = new URLSearchParams("proofBatch=01");
    useScanStore.setState({ needsReviewQueue: [] });

    render(<Nav />);

    expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/report");
  });

  it("keeps navigation available while search params are suspended during prerendering", () => {
    vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
    mocks.suspendSearchParams = true;
    useScanStore.setState({ needsReviewQueue: [] });

    render(<Nav />);

    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/report");
  });

  it.each(["1", "00", "31", "01x", " 01", ""]) (
    "does not carry non-canonical proof batch %j",
    (proofBatch) => {
      vi.stubEnv("NEXT_PUBLIC_LOCAL_DEMO", "1");
      mocks.searchParams = new URLSearchParams({ proofBatch });
      useScanStore.setState({ needsReviewQueue: [] });

      render(<Nav />);

      expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/report");
    },
  );
});
