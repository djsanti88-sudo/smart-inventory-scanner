import { describe, expect, it } from "vitest";
import { TrustedExactAuthorizationCache } from "./trustedExactAuthorizationCache";

describe("TrustedExactAuthorizationCache", () => {
  it("returns a brief positive authorization without retaining cross-tenant access", () => {
    let now = 1_000;
    const cache = new TrustedExactAuthorizationCache({ now: () => now, ttlMs: 30_000 });
    cache.set("secret-token", "business-a", { uid: "user-1", platformOwner: false, hasVerifiedMembership: true }, 100_000);

    expect(cache.get("secret-token", "business-a")).toEqual({ uid: "user-1", platformOwner: false, hasVerifiedMembership: true });
    expect(cache.get("secret-token", "business-b")).toBeNull();
    expect(cache.get("different-token", "business-a")).toBeNull();
    now = 31_001;
    expect(cache.get("secret-token", "business-a")).toBeNull();
  });

  it("never outlives the verified token and ignores already-expired entries", () => {
    let now = 10_000;
    const cache = new TrustedExactAuthorizationCache({ now: () => now, ttlMs: 30_000 });
    cache.set("token", "business", { uid: "user", platformOwner: false, hasVerifiedMembership: true }, 11_000);
    now = 11_000;
    expect(cache.get("token", "business")).toBeNull();

    cache.set("expired", "business", { uid: "user", platformOwner: true, hasVerifiedMembership: false }, 10_999);
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest positive decision at its fixed bound", () => {
    const cache = new TrustedExactAuthorizationCache({ maxEntries: 2 });
    cache.set("one", "business", { uid: "one", platformOwner: false, hasVerifiedMembership: true }, Date.now() + 60_000);
    cache.set("two", "business", { uid: "two", platformOwner: false, hasVerifiedMembership: true }, Date.now() + 60_000);
    cache.set("three", "business", { uid: "three", platformOwner: false, hasVerifiedMembership: true }, Date.now() + 60_000);
    expect(cache.get("one", "business")).toBeNull();
    expect(cache.get("two", "business")?.uid).toBe("two");
    expect(cache.get("three", "business")?.uid).toBe("three");
  });
});
