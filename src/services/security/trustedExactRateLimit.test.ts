import { describe, expect, it, vi } from "vitest";
import { TrustedExactRateLimiter } from "@/services/security/trustedExactRateLimit";

describe("TrustedExactRateLimiter", () => {
  it("scopes scanner-safe buckets by both verified uid and business", () => {
    const now = vi.fn(() => 1_000);
    const limiter = new TrustedExactRateLimiter({ limit: 1, windowMs: 60_000, now });

    expect(limiter.check("uid-a", "business-a").allowed).toBe(true);
    expect(limiter.check("uid-a", "business-a").allowed).toBe(false);
    expect(limiter.check("uid-a", "business-b").allowed).toBe(true);
    expect(limiter.check("uid-b", "business-a").allowed).toBe(true);
  });

  it("expires a bucket after the configured scanner window", () => {
    let current = 1_000;
    const limiter = new TrustedExactRateLimiter({ limit: 1, windowMs: 5_000, now: () => current });

    expect(limiter.check("uid-a", "business-a").allowed).toBe(true);
    expect(limiter.check("uid-a", "business-a").allowed).toBe(false);
    current += 5_000;
    expect(limiter.check("uid-a", "business-a").allowed).toBe(true);
  });
});
