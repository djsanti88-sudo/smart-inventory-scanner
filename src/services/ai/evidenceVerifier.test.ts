import { describe, it, expect } from "vitest";
import { verifyEvidence } from "@/services/ai/evidenceVerifier";
import type { ProviderEvidence } from "@/types";

const empty: ProviderEvidence = { sourceUrls: [], sourceSnippets: [], groundingChunks: [] };

describe("EvidenceVerifier - the app verifies the exact code, not the model's claim", () => {
  it("REJECTS a model self-claim when no evidence actually contains the code", () => {
    const ev: ProviderEvidence = {
      ...empty,
      sourceSnippets: ["A great creamer for your coffee."],
      exactCodeEvidence: true, // model claims it - we must not trust this
    };
    const r = verifyEvidence("855724007602", "upc_a", ev);
    expect(r.verified).toBe(false);
    expect(r.strength).toBe("none");
  });

  it("REJECTS a page that echoes the code only to declare it invalid (745125495781 'not a valid UPC')", () => {
    // go-upc returns this for 745125495781 and points at a DIFFERENT code. The scanned code's presence in
    // an invalidation page is a denial, not confirmation -> must NOT verify (none), so it can never auto-trust.
    const ev: ProviderEvidence = {
      ...empty,
      fetchedSourceText: "Sorry, 745125495781 is not a valid UPC. Did you mean GTIN 7451254957818 (Manstel rivet kit)?",
      sourceUrls: ["https://go-upc.com/7451254957818"],
    };
    const r = verifyEvidence("745125495781", "upc_a", ev);
    expect(r.verified).toBe(false);
    expect(r.strength).toBe("none");
  });

  it("does NOT match a DIFFERENT, longer numeric code (7451254957818 != scanned 745125495781)", () => {
    const ev: ProviderEvidence = { ...empty, sourceSnippets: ["Product GTIN 7451254957818 Manstel rivet kit"] };
    const r = verifyEvidence("745125495781", "upc_a", ev);
    expect(r.verified).toBe(false); // exact numeric match only - a 12-digit prefix of a 13-digit code is not a hit
  });

  it("verifies when a source snippet contains the exact code", () => {
    const ev: ProviderEvidence = { ...empty, sourceSnippets: ["Listed as UPC 049000028904 on the box."] };
    const r = verifyEvidence("049000028904", "upc_a", ev);
    expect(r.verified).toBe(true);
    expect(r.strength).toBe("snippet");
    expect(r.matchedCode).toBe("049000028904");
  });

  it("matches numeric codes even with spaces/hyphens in the source", () => {
    const ev: ProviderEvidence = { ...empty, sourceSnippets: ["barcode 0 49000-02890 4 found"] };
    const r = verifyEvidence("049000028904", "upc_a", ev);
    expect(r.verified).toBe(true);
    expect(r.strength).toBe("snippet");
  });

  it("extracts and checks Gemini grounding chunks", () => {
    const ev: ProviderEvidence = { ...empty, groundingChunks: ["Product page mentions GTIN 6419440485331."] };
    const r = verifyEvidence("6419440485331", "ean_13", ev);
    expect(r.verified).toBe(true);
    expect(r.strength).toBe("grounding_chunk");
  });

  it("treats URL-only evidence as weak and NOT auto-verifiable", () => {
    const ev: ProviderEvidence = { ...empty, sourceUrls: ["https://shop.example.com/p/049000028904"] };
    const r = verifyEvidence("049000028904", "upc_a", ev);
    expect(r.strength).toBe("url_only");
    expect(r.verified).toBe(false); // url-only is not a verification unless host is trusted
  });

  it("accepts URL-only evidence only from an explicitly trusted host", () => {
    const ev: ProviderEvidence = { ...empty, sourceUrls: ["https://www.gs1.org/047000028904/049000028904"] };
    const r = verifyEvidence("049000028904", "upc_a", ev, { trustedHosts: ["gs1.org"] });
    expect(r.strength).toBe("url_only");
    expect(r.verified).toBe(true);
  });

  it("uses fetched source text as the strongest evidence", () => {
    const ev: ProviderEvidence = { ...empty, fetchedSourceText: "Full page text including 049000028904 here." };
    const r = verifyEvidence("049000028904", "upc_a", ev);
    expect(r.strength).toBe("fetched_source");
    expect(r.verified).toBe(true);
  });

  it("matches a UPC-12 code that appears as a GTIN-13 (leading zero) in a source URL", () => {
    const ev: ProviderEvidence = { ...empty, sourceUrls: ["https://barcodesdatabase.org/barcode/0012300197410"] };
    const r = verifyEvidence("012300197410", "upc_a", ev);
    expect(r.strength).toBe("url_only"); // found as the 13-digit form, but only in a URL
  });

  it("verifies a UPC-12 code found as a GTIN-13 in a snippet", () => {
    const ev: ProviderEvidence = { ...empty, sourceSnippets: ["UPC 0012300197410 Camel Crush"] };
    const r = verifyEvidence("012300197410", "upc_a", ev);
    expect(r.verified).toBe(true);
    expect(r.strength).toBe("snippet");
  });

  it("for alphanumeric vendor codes, requires an exact normalized match", () => {
    const ev: ProviderEvidence = { ...empty, sourceSnippets: ["Amazon label X004DY7YUT seen in listing"] };
    const r = verifyEvidence("X004DY7YUT", "vendor_label", ev);
    expect(r.verified).toBe(true);
    expect(r.strength).toBe("snippet");
    // a near-miss must NOT match
    const r2 = verifyEvidence("X004DY7YUT", "vendor_label", { ...empty, sourceSnippets: ["X004DY7YU9 different"] });
    expect(r2.verified).toBe(false);
  });
});
