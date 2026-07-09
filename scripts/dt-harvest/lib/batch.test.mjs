import { describe, it, expect } from "vitest";
import { selectUrls, hostAllowed } from "./batch.mjs";

describe("selectUrls", () => {
  const urls = ["u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"];

  it("returns up to limit urls, skipping none when done is empty", () => {
    const result = selectUrls(urls, {}, { limit: 3 });
    expect(result).toEqual(["u0", "u1", "u2"]);
  });

  it("skips urls already marked done", () => {
    const done = { u0: true, u2: true };
    const result = selectUrls(urls, done, { limit: 3 });
    expect(result).toEqual(["u1", "u3", "u4"]);
  });

  it("caps at limit even when far more undone urls remain", () => {
    const result = selectUrls(urls, {}, { limit: 1 });
    expect(result).toEqual(["u0"]);
  });

  it("returns empty array when limit is 0", () => {
    const result = selectUrls(urls, {}, { limit: 0 });
    expect(result).toEqual([]);
  });

  it("returns fewer than limit when not enough undone urls remain", () => {
    const done = Object.fromEntries(urls.slice(0, 8).map((u) => [u, true]));
    const result = selectUrls(urls, done, { limit: 5 });
    expect(result).toEqual(["u8", "u9"]);
  });

  it("returns empty array when done is missing/undefined (treated as empty)", () => {
    const result = selectUrls(urls, undefined, { limit: 2 });
    expect(result).toEqual(["u0", "u1"]);
  });

  it("returns empty array for an empty urls list", () => {
    const result = selectUrls([], {}, { limit: 5 });
    expect(result).toEqual([]);
  });

  describe("shard partitioning", () => {
    // index i belongs to shard K of N iff i % N === K (0-based)
    it("shard 0/2 selects even-indexed urls only", () => {
      const result = selectUrls(urls, {}, { limit: 100, shard: { k: 0, n: 2 } });
      expect(result).toEqual(["u0", "u2", "u4", "u6", "u8"]);
    });

    it("shard 1/2 selects odd-indexed urls only", () => {
      const result = selectUrls(urls, {}, { limit: 100, shard: { k: 1, n: 2 } });
      expect(result).toEqual(["u1", "u3", "u5", "u7", "u9"]);
    });

    it("shard 2/3 selects every third url starting at index 2", () => {
      const result = selectUrls(urls, {}, { limit: 100, shard: { k: 2, n: 3 } });
      expect(result).toEqual(["u2", "u5", "u8"]);
    });

    it("combines shard partitioning with the limit cap", () => {
      const result = selectUrls(urls, {}, { limit: 2, shard: { k: 0, n: 2 } });
      expect(result).toEqual(["u0", "u2"]);
    });

    it("combines shard partitioning with done-skipping", () => {
      const done = { u0: true };
      const result = selectUrls(urls, done, { limit: 100, shard: { k: 0, n: 2 } });
      expect(result).toEqual(["u2", "u4", "u6", "u8"]);
    });
  });
});

describe("hostAllowed", () => {
  it("allows https://www.discounttire.com urls", () => {
    expect(hostAllowed("https://www.discounttire.com/tires/foo/bar-p123")).toBe(true);
  });

  it("allows https://discounttire.com (bare, no www) urls", () => {
    expect(hostAllowed("https://discounttire.com/tires/foo/bar-p123")).toBe(true);
  });

  it("rejects a different host entirely", () => {
    expect(hostAllowed("https://evil.com/tires/foo/bar-p123")).toBe(false);
  });

  it("rejects a lookalike host (discounttire.com.evil.com)", () => {
    expect(hostAllowed("https://discounttire.com.evil.com/tires/foo")).toBe(false);
  });

  it("rejects a subdomain-prefixed lookalike (notdiscounttire.com)", () => {
    expect(hostAllowed("https://notdiscounttire.com/tires/foo")).toBe(false);
  });

  it("rejects http (non-https) urls", () => {
    expect(hostAllowed("http://www.discounttire.com/tires/foo")).toBe(false);
  });

  it("rejects malformed urls without throwing", () => {
    expect(hostAllowed("not a url")).toBe(false);
    expect(hostAllowed("")).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
    expect(hostAllowed(null)).toBe(false);
  });

  it("allows a legit subdomain other than www if ever used (e.g. m.discounttire.com) - actually rejects unlisted subdomains", () => {
    // Hard allowlist is exactly discounttire.com and www.discounttire.com per the plan's
    // Global Constraints - no other subdomain is pre-approved.
    expect(hostAllowed("https://m.discounttire.com/tires/foo")).toBe(false);
  });
});
