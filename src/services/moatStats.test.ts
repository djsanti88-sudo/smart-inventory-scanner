import { describe, it, expect } from "vitest";
import { computeMoatStats } from "@/services/moatStats";

describe("computeMoatStats", () => {
  it("counts known/resolved as identified, everything else as not", () => {
    const events = [
      { resolverStatus: "known" },
      { resolverStatus: "known" },
      { resolverStatus: "resolved" },
      { resolverStatus: "needs_review" },
      { resolverStatus: "conflict" },
    ];
    const stats = computeMoatStats(events);
    expect(stats).toEqual({ total: 5, identified: 3 });
  });

  it("returns zero/zero for an empty feed", () => {
    expect(computeMoatStats([])).toEqual({ total: 0, identified: 0 });
  });

  it("treats 'suggested' as NOT automatically identified (a human has not confirmed it yet)", () => {
    const events = [{ resolverStatus: "known" }, { resolverStatus: "suggested" }];
    expect(computeMoatStats(events)).toEqual({ total: 2, identified: 1 });
  });
});
