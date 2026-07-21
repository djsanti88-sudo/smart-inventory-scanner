import { describe, it, expect } from "vitest";
import { usableIdentityName, evaluatePageJunk } from "@/services/fetchV2/pageEvidence/junkRules";

describe("lane C item C1: error/404-shaped page titles never pass the FetchV2 junk gate", () => {
  const CODE = "721749249238"; // live stress-batch regression: stored "We couldn't find this page"

  it("usableIdentityName rejects the exact live regression string and localized/provider variants", () => {
    for (const junk of [
      "We couldn’t find this page", // curly apostrophe (the exact live string)
      "We couldn't find this page", // straight apostrophe
      "This page isn't available",
      "Page Not Found",
      "404 error",
      "Access Denied",
      "Robot Check",
      "Attention Required! | Cloudflare",
    ]) {
      expect(usableIdentityName(junk, CODE), junk).toBe(false);
    }
  });

  it("usableIdentityName still accepts a real product name", () => {
    expect(usableIdentityName("Fortune Tormenta H/T FSR305 265/75R16 116T BSW", CODE)).toBe(true);
  });

  it("evaluatePageJunk rejects a page whose title is the 404-shaped string", () => {
    const verdict = evaluatePageJunk({ url: "https://example.com/x", title: "We couldn’t find this page", text: "" }, CODE);
    expect(verdict.rejected).toBe(true);
  });
});
