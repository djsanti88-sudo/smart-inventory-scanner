import { describe, it, expect } from "vitest";
// Pure cap-math from the task spend-ledger helper. The fs-backed mutations (addCash/addFirecrawl)
// are exercised by the CLI during the run; here we lock the pure guard logic that protects the
// $30 cash cap and the Firecrawl 500-credit / 50-pages-per-domain caps.
import {
  projectedCash,
  cashWouldExceed,
  projectedCredits,
  firecrawlWouldExceed,
} from "../../scripts/spend-ledger.mjs";

describe("spend ledger cash cap ($30)", () => {
  const cash = { totalUsd: 28, cap: 30 };
  it("allows a charge that stays at/under the cap", () => {
    expect(cashWouldExceed(cash, 2)).toBe(false);
    expect(projectedCash(cash, 2)).toBe(30);
  });
  it("blocks a charge that crosses the cap", () => {
    expect(cashWouldExceed(cash, 2.01)).toBe(true);
  });
  it("rounds to cents (no float drift across the cap)", () => {
    expect(projectedCash({ totalUsd: 0.1, cap: 30 }, 0.2)).toBe(0.3);
  });
});

describe("firecrawl ledger caps (500 credits, 50 pages/domain)", () => {
  const fc = { credits: 480, cap: 500, perDomainCap: 50, perDomain: { "michelin.com": 40 } };
  it("allows usage within both caps", () => {
    expect(firecrawlWouldExceed(fc, 10, 5, "michelin.com")).toBe(false);
    expect(projectedCredits(fc, 10)).toBe(490);
  });
  it("blocks when total credit cap would be exceeded", () => {
    expect(firecrawlWouldExceed(fc, 25, 5, "goodyear.com")).toBe(true);
  });
  it("blocks when per-domain page cap would be exceeded", () => {
    expect(firecrawlWouldExceed(fc, 1, 11, "michelin.com")).toBe(true); // 40 + 11 > 50
  });
  it("treats a never-seen domain as 0 pages used", () => {
    expect(firecrawlWouldExceed(fc, 1, 50, "newbrand.com")).toBe(false);
    expect(firecrawlWouldExceed(fc, 1, 51, "newbrand.com")).toBe(true);
  });
});
