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

  // B3 regression (owner-reported, 2026-07-20): the header said "0 of 268 identified automatically"
  // while dozens of rows showed "Verified (app-confirmed)". Root cause: resolverStatus is stamped ONCE
  // at scan time by the deterministic resolver ("known"/"needs_review"/"conflict") and is NEVER updated
  // when a later decode auto-verifies the row (markFeedRowVerified only writes decodeStatus/provenance).
  // The counter must also count a row whose decodeStatus settled to "verified" with app_verified
  // provenance (the app's own auto-count gate resolved it), even though resolverStatus is still
  // "needs_review" from the original unknown scan. A raw AI "suggested" badge (no human confirmation,
  // no app verification) must still NOT count.
  it("counts a row auto-verified by decode (app_verified) even though resolverStatus never left needs_review", () => {
    const events = [
      { resolverStatus: "needs_review", decodeStatus: "verified", provenance: "app_verified" },
      { resolverStatus: "needs_review", decodeStatus: "suggested" },
      { resolverStatus: "known" },
    ];
    expect(computeMoatStats(events)).toEqual({ total: 3, identified: 2 });
  });

  it("does NOT count a decode-verified row whose provenance is only an AI self-report (not app-verified)", () => {
    const events = [
      { resolverStatus: "needs_review", decodeStatus: "verified", provenance: "ai_self_report" },
    ];
    expect(computeMoatStats(events)).toEqual({ total: 1, identified: 0 });
  });
});
