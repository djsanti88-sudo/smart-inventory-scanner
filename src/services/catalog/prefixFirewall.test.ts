import { describe, it, expect } from "vitest";
import { evaluatePrefixFirewall } from "@/services/catalog/prefixFirewall";
import { lookupPrefix } from "@/services/catalog/prefixIndex";

// The firewall is an EVIDENCE-WEIGHTED conflict signal, NOT absolute proof, and it must NOT create
// false rejects for legitimate private-label / multi-prefix / multi-UPC products. Conflict requires a
// real contradiction (manufacturer + CATEGORY mismatch, or a candidate UPC-set that excludes the scan
// in a category-incompatible way), and official exact-code evidence overrides it.

const BUCKET = "051596320812"; // United Solutions prefix (housewares/bucket)
const bucketPrefix = lookupPrefix(BUCKET);

describe("prefixFirewall (evidence-weighted, false-reject-safe)", () => {
  it("blocks a model hallucination: a ceiling fan claimed for a bucket-maker prefix", () => {
    const v = evaluatePrefixFirewall({
      code: BUCKET,
      prefix: bucketPrefix,
      candidate: { brand: "Hampton Bay", manufacturer: "King of Fans", category: "ceiling fan" },
      candidateKnownUpcs: ["792145369783"], // the fan's real UPC set excludes the scanned code
      exactCodeVerifiedByApp: false,
    });
    expect(v.conflict).toBe(true);
    expect(["prefix_manufacturer_conflict", "reverse_upc_conflict"]).toContain(v.kind);
    expect(v.weight).toBeGreaterThan(0.5);
    expect(v.overriddenByEvidence).toBe(false);
  });

  it("does NOT flag a legitimate PRIVATE-LABEL match (Home Depot retail brand on a United Solutions prefix)", () => {
    const v = evaluatePrefixFirewall({
      code: BUCKET,
      prefix: bucketPrefix,
      candidate: { brand: "The Home Depot", category: "bucket" }, // retail brand differs; category matches
      candidateKnownUpcs: [],
      exactCodeVerifiedByApp: false,
    });
    expect(v.conflict).toBe(false); // brand-only difference is NOT a conflict when category is compatible
    expect(v.kind).toBe("none");
  });

  it("does NOT false-reject a MULTI-PREFIX product (same bucket also sold under a different maker's UPC)", () => {
    const v = evaluatePrefixFirewall({
      code: BUCKET,
      prefix: bucketPrefix,
      candidate: { brand: "The Home Depot", category: "bucket" },
      candidateKnownUpcs: ["084305355546", "684305355548"], // our catalog only knows OTHER bucket UPCs
      exactCodeVerifiedByApp: false,
    });
    // category is compatible (bucket maker), so a UPC-set exclusion is treated as multi-prefix, NOT a conflict
    expect(v.conflict).toBe(false);
  });

  it("official exact-code evidence OVERRIDES a prefix conflict", () => {
    const v = evaluatePrefixFirewall({
      code: BUCKET,
      prefix: bucketPrefix,
      candidate: { manufacturer: "King of Fans", category: "ceiling fan" },
      candidateKnownUpcs: ["792145369783"],
      exactCodeVerifiedByApp: true, // app confirmed the exact code in strong evidence
    });
    expect(v.overriddenByEvidence).toBe(true);
    expect(v.conflict).toBe(false);
  });

  it("a matching manufacturer is never a conflict", () => {
    const v = evaluatePrefixFirewall({
      code: BUCKET,
      prefix: bucketPrefix,
      candidate: { manufacturer: "United Solutions", category: "storage bin" },
      candidateKnownUpcs: [],
    });
    expect(v.conflict).toBe(false);
  });

  it("reverse footprint: candidate brand known under OTHER prefixes, scan not among them -> conflict", () => {
    const v = evaluatePrefixFirewall({
      code: "0999000111111", // prefix 0999000 - unknown scanned prefix
      prefix: null,
      candidate: { brand: "Acme", category: "snacks" },
      candidateKnownPrefixes: ["0123456", "0123457"], // Acme is known elsewhere, never under 0999000
      exactCodeVerifiedByApp: false,
    });
    expect(v.conflict).toBe(true);
    expect(v.kind).toBe("reverse_upc_conflict");
  });

  it("reverse footprint: NO conflict when the scan's prefix IS in the candidate's footprint", () => {
    const v = evaluatePrefixFirewall({
      code: "0123456000000", // prefix 0123456 - in the footprint
      prefix: null,
      candidate: { brand: "Acme", category: "snacks" },
      candidateKnownPrefixes: ["0123456", "0123457"],
      exactCodeVerifiedByApp: false,
    });
    expect(v.conflict).toBe(false);
  });

  it("an unknown prefix with no UPC-set info never conflicts (non-cataloged products unaffected)", () => {
    const v = evaluatePrefixFirewall({
      code: "999888777666",
      prefix: null,
      candidate: { brand: "Whatever", category: "mystery" },
      candidateKnownUpcs: [],
    });
    expect(v.conflict).toBe(false);
    expect(v.kind).toBe("none");
  });
});
