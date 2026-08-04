import { describe, expect, it, vi } from "vitest";
import { TrustedExactRateLimiter } from "@/services/security/trustedExactRateLimit";

describe("TrustedExactRateLimiter", () => {
  it("keys independently by verified user and business at the scanner-safe default", () => {
    const limiter = new TrustedExactRateLimiter({ now: () => 1_000 });
    for (let index = 0; index < 600; index += 1) expect(limiter.check("uid-a", "business-a").allowed).toBe(true);
    expect(limiter.check("uid-a", "business-a")).toMatchObject({ allowed: false, retryAfterMs: 60_000 });
    expect(limiter.check("uid-a", "business-b").allowed).toBe(true);
    expect(limiter.check("uid-b", "business-a").allowed).toBe(true);
  });

  it("expires old windows and bounds retained keys", () => {
    let now = 1_000;
    const limiter = new TrustedExactRateLimiter({ now: () => now, maxEntries: 2, limit: 1 });
    expect(limiter.check("a", "one").allowed).toBe(true);
    expect(limiter.check("b", "one").allowed).toBe(true);
    expect(limiter.check("c", "one").allowed).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(2);
    now += 60_001;
    expect(limiter.check("a", "one").allowed).toBe(true);
  });

  it("emits only masked anomaly telemetry when it rejects", () => {
    const anomaly = vi.fn();
    const limiter = new TrustedExactRateLimiter({ now: () => 1_000, limit: 1, onLimit: anomaly });
    limiter.check("sensitive-user", "sensitive-business");
    limiter.check("sensitive-user", "sensitive-business");
    expect(anomaly).toHaveBeenCalledWith(expect.objectContaining({ uid: "sen…ser", businessId: "sen…ess" }));
    expect(JSON.stringify(anomaly.mock.calls)).not.toContain("sensitive-user");
    expect(JSON.stringify(anomaly.mock.calls)).not.toContain("sensitive-business");
  });
});
