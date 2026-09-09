import { describe, it, expect } from "vitest";
import { isTrustedProductHost, TRUSTED_PRODUCT_HOSTS } from "./trustedProductHosts";

// Task 21 (owner-ratified 2026-07-15): the trusted-source confidence floor and the learned-products
// tier both gate on "did this evidence come from a LEGIT product page" - a major retailer or the tire
// manufacturer's own site. This allowlist is registrable-domain exact matching (never substring), so
// an attacker cannot spoof trust with "evil-walmart.com.attacker.io" or "walmart.com.evil.io".

describe("isTrustedProductHost (Task 21)", () => {
  it("accepts the major retailers named in the task", () => {
    for (const host of ["walmart.com", "target.com", "discounttire.com", "tirerack.com", "amazon.com"]) {
      expect(isTrustedProductHost(`https://www.${host}/product/123`), host).toBe(true);
    }
  });

  it("accepts every KNOWN_TIRE_BRANDS manufacturer domain listed in the task", () => {
    const domains = [
      "michelin.com",
      "goodyear.com",
      "bridgestonetire.com",
      "continentaltire.com",
      "pirelli.com",
      "yokohamatire.com",
      "falkentire.com",
      "toyotires.com",
      "coopertire.com",
      "bfgoodrichtires.com",
      "hankooktire.com",
      "nexentireusa.com",
      "kumhotire.com",
      "generaltire.com",
      "firestonetire.com",
    ];
    for (const host of domains) {
      expect(isTrustedProductHost(`https://${host}/tires/x`), host).toBe(true);
    }
  });

  it("handles subdomains via registrable-domain comparison (www., shop.)", () => {
    expect(isTrustedProductHost("https://www.walmart.com/ip/123")).toBe(true);
    expect(isTrustedProductHost("https://shop.michelin.com/en-us/tire")).toBe(true);
    expect(isTrustedProductHost("http://shop.discounttire.com/tire/x")).toBe(true);
  });

  it("NEVER substring-matches: a lookalike host must fail", () => {
    expect(isTrustedProductHost("https://evil-walmart.com.attacker.io/x")).toBe(false);
    expect(isTrustedProductHost("https://walmart.com.evil.io/x")).toBe(false);
    expect(isTrustedProductHost("https://notwalmart.com/x")).toBe(false);
    expect(isTrustedProductHost("https://walmart.com.fake-tld/x")).toBe(false);
    expect(isTrustedProductHost("https://faketirerack.com/x")).toBe(false);
  });

  it("rejects an untrusted host entirely", () => {
    expect(isTrustedProductHost("https://randomblog.example.com/review")).toBe(false);
    expect(isTrustedProductHost("https://meros.io/049000006346")).toBe(false);
  });

  it("rejects malformed/empty URLs without throwing", () => {
    expect(isTrustedProductHost("")).toBe(false);
    expect(isTrustedProductHost("not a url")).toBe(false);
    expect(isTrustedProductHost(undefined as unknown as string)).toBe(false);
  });

  it("exposes the raw allowlist for reuse/inspection", () => {
    expect(TRUSTED_PRODUCT_HOSTS).toContain("walmart.com");
    expect(TRUSTED_PRODUCT_HOSTS).toContain("michelin.com");
  });
});
