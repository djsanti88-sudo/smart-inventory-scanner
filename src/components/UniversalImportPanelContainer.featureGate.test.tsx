// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScanStore } from "@/stores/scanStore";
import type { Alias, Product } from "@/types";

vi.mock("@/components/UniversalImportPanel", () => ({
  UniversalImportPanel: ({ reviewSurface }: { reviewSurface?: ReactNode }) => <main>{reviewSurface}</main>,
}));

import { UniversalImportPanelContainer } from "@/components/UniversalImportPanelContainer";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  useScanStore.setState({ businessId: "shop-a", products: [] as Product[], aliases: [] as Alias[] });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviews: [], currentApprovedLinks: [], total: 0, linkTotal: 0, bucketTotals: {} }) }));
});

describe("UniversalImportPanelContainer local identity surface boundary", () => {
  it("does not expose the identity review queue to an admin in production even when the public flag is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1", "1");
    vi.stubEnv("NEXT_PUBLIC_LOCAL_IDENTITY_ROLE", "admin");

    render(<UniversalImportPanelContainer />);

    expect(screen.queryByRole("region", { name: "Identity review queue" })).not.toBeInTheDocument();
  });
});
