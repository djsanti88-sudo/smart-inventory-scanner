import { describe, it, expect } from "vitest";
import { emptyTenantState } from "./scanReset";
import { DEFAULT_SETTINGS } from "@/stores/scanStore";

describe("emptyTenantState", () => {
  it("returns empty tenant arrays and default settings", () => {
    const s = emptyTenantState();
    expect(s.scanFeed).toEqual([]);
    expect(s.finalCounts).toEqual([]);
    expect(s.needsReviewQueue).toEqual([]);
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });
});
