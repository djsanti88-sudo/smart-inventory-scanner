import { describe, it, expect } from "vitest";
import { decideDecode } from "@/decoding/decode";
import { emptyResult } from "@/decoding/provider";
import { verifyEvidence } from "@/decoding/evidenceVerifier";
import type { AiLookupResult, EvidenceResult } from "@/types";

// MASTER BASELINE v1 - ANY-SOURCE decode policy. decideDecode returns "verified" (auto-count) for a
// PUBLIC barcode when the app confirmed the EXACT scanned code in STRONG evidence, confidence >= the
// threshold, and there is NO catalog-derived brand-prefix conflict - from a SINGLE provider (no second
// source, no tire prefix family, no tire context required). Tire specs + scan-context are enforced
// DOWNSTREAM by the store auto-count gate, not here. Blocked at decode: weak/unverified evidence, below
// threshold, brand-prefix conflict (catalog-derived, passed in by the caller), provider conflict,
// vendor labels. PATH 3 (internet two-source size, tire-only) still verifies tires with no exact-code echo.

const tire = (over: Partial<AiLookupResult>): AiLookupResult => ({ ...emptyResult(), confidence: 0.92, ...over });
const strongEv = (code: string): EvidenceResult => ({ verified: true, strength: "snippet", matchedCode: code, matchedSources: ["snippet"], reason: "" });
const weakEv = (): EvidenceResult => ({ verified: false, strength: "none", matchedCode: "", matchedSources: [], reason: "" });

// Cooper owns the STRONG prefix 029142 (029142712886 -> family Cooper/Mastercraft/Starfire).
const COOPER = tire({ productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", specsShort: "LT245/75R16 120R" });

describe("decideDecode - any-source single-provider verify (baseline v1)", () => {
  it("VERIFIES a single public-barcode provider with strong app-verified evidence (single_source)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [strongEv("029142712886")], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.corroborationPath).toBe("single_source");
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(true);
  });

  it("VERIFIES outside tire context too (any-source is product-type agnostic)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Generic Snack Bar", brand: "Generic" })], evidences: [strongEv("012345678905")], confidenceThreshold: 0.8, code: "012345678905", scanContext: "any" });
    expect(r.status).toBe("verified");
  });

  it("VERIFIES a non-tire product with a genuinely confirming source (scan-anything baseline)", () => {
    // Under scan-anything + any-source a real non-tire product with the exact code confirmed is a valid
    // count - the old tire-only "poison" rejection no longer applies at the decode level. (The invalid-UPC
    // / 'did you mean a different code' case is still blocked because its evidence is never strong.)
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "" })], evidences: [strongEv("745125495781")], confidenceThreshold: 0.8, code: "745125495781", scanContext: "any" });
    expect(r.status).toBe("verified");
  });

  it("does NOT verify on WEAK/unverified evidence (exact code not app-confirmed)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [weakEv()], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT verify below the confidence threshold (non-prefix product, single_source path)", () => {
    // Use a generic non-tire-prefix product so only the single_source path applies (deterministic tire
    // corroboration is confidence-independent by design). Below 0.8 -> not verified.
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Generic Snack Bar", brand: "Generic", confidence: 0.5 })], evidences: [strongEv("012345678905")], confidenceThreshold: 0.8, code: "012345678905", scanContext: "any" });
    expect(r.status).not.toBe("verified");
  });

  it("PLAN C: a catalog-derived brand-prefix conflict is ADVISORY - with strong exact-code evidence it no longer blocks auto-count", () => {
    // Reconciled (Plan C Task 2): the brand-prefix mismatch used to hard-block every auto-count path. Owner
    // rule: GS1 prefixes are many-to-one, so a brand-prefix mismatch alone must never block when the app
    // confirmed the EXACT code in STRONG evidence (grounding/corpus wins over the prefix). The CATEGORY /
    // poison guard (wrong product TYPE) stays a hard block elsewhere (scanContextFirewall / store).
    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Bridgestone Dueler H/T 245/75R16 120R", brand: "Bridgestone", specsShort: "245/75R16 120R" })],
      evidences: [strongEv("029142712886")], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire",
      brandPrefixConflict: true,
    });
    expect(r.status).toBe("verified");
  });

  it("two independent providers that AGREE also verify (two_ai_agreement)", () => {
    const p = tire({ productName: "Acme Mystery 12 pack", brand: "Acme", upc: "012345678905" });
    const r = decideDecode({ codeType: "upc_a", results: [p, p], evidences: [strongEv("012345678905"), strongEv("012345678905")], confidenceThreshold: 0.8, code: "012345678905", scanContext: "any" });
    expect(r.status).toBe("verified");
    expect(r.corroborationPath).toBe("two_ai_agreement");
  });
});

describe("decideDecode - PATH 3 internet two-source size agreement (no exact-code echo, no DB)", () => {
  const sizeAgreed = (over = {}) =>
    tire({ productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", specsShort: "LT245/75R16 120R", sizeAgreement: true, ...over });

  it("AUTO-VERIFIES a strong-prefix tire when two independent sources agree on the size - WITHOUT exact-code evidence", () => {
    const r = decideDecode({ codeType: "upc_a", results: [sizeAgreed()], evidences: [weakEv()], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.corroborationPath).toBe("internet_two_source_size");
  });

  it("stays SUGGESTED when only ONE source has the size (no agreement)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [sizeAgreed({ sizeAgreement: false })], evidences: [weakEv()], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT verify the poison (non-tire) even with sizeAgreement true", () => {
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "", sizeAgreement: true })], evidences: [weakEv()], confidenceThreshold: 0.8, code: "745125495781", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT verify a brand NOT in the strong prefix family even with sizeAgreement", () => {
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Kumho Crugen 265/70R17 115T", brand: "Kumho", specsShort: "265/70R17 115T", sizeAgreement: true })], evidences: [weakEv()], confidenceThreshold: 0.8, code: "012345678905", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT set exactCodeEvidenceVerifiedByApp on the internet two-source path (no app-confirmed exact code)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [sizeAgreed()], evidences: [weakEv()], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(false);
  });

  it("does NOT verify the internet two-source path outside tire context (scanContext 'any')", () => {
    const r = decideDecode({ codeType: "upc_a", results: [sizeAgreed()], evidences: [weakEv()], confidenceThreshold: 0.8, code: "029142712886", scanContext: "any" });
    expect(r.status).not.toBe("verified");
  });
});

// END-TO-END evidence path: strong evidence comes from a REAL fetched page (verifyEvidence over
// fetchedSourceText), not a synthetic flag. These prove the live mechanism: a barcode auto-counts ONLY
// when the scanned code is genuinely confirmed in the page the app fetched.
describe("decideDecode - verify via fetched_source page text", () => {
  const cooperPage =
    "Cooper Discoverer A/T3 LT245/75R16 120R. UPC 029142712886. Light truck all-terrain tire. In stock.";

  it("auto-VERIFIES when the fetched page CONFIRMS the exact code", () => {
    const ev = verifyEvidence("029142712886", "upc_a", {
      fetchedSourceText: cooperPage, sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"], sourceSnippets: [], groundingChunks: [],
    });
    expect(ev.verified).toBe(true);
    expect(ev.strength).toBe("fetched_source"); // verified from the real page text, not url_only

    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [ev], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(true);
    expect(r.evidenceStrength).toBe("fetched_source");
  });

  it("does NOT verify when the fetched page does NOT contain the scanned code (no real confirmation)", () => {
    const ev = verifyEvidence("029142712886", "upc_a", {
      fetchedSourceText: "Bridgestone Dueler H/T. UPC 012000001291. In stock.", sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"], sourceSnippets: [], groundingChunks: [],
    });
    expect(ev.verified).toBe(false);

    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [ev], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified"); // stays Suggested/review: never auto-count without real confirmation
  });

  it("url_only on an UNTRUSTED product-DB host stays verified:false (not enough to auto-count)", () => {
    const ev = verifyEvidence("029142712886", "upc_a", {
      fetchedSourceText: "", sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"], sourceSnippets: [], groundingChunks: [],
    }, { trustedHosts: ["gs1.org", "gtin.info"] });
    expect(ev.verified).toBe(false);
    expect(ev.strength).toBe("url_only");

    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [ev], confidenceThreshold: 0.8, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("NON-MATCHING code (745125495781 -> go-upc returns a DIFFERENT EAN 7451254957818) is never verified", () => {
    // go-upc says the scanned code is "not a valid UPC" and returns a DIFFERENT GTIN. The scanned code does
    // NOT appear on the page, so the verifier yields none -> never "verified". This is the REAL poison guard.
    const goUpcPage = "Sorry, 745125495781 is not a valid UPC. Did you mean: Manstel 200 Pcs Aluminum Rivet Screw Kit, GTIN 7451254957818?";
    const ev = verifyEvidence("745125495781", "upc_a", {
      fetchedSourceText: goUpcPage, sourceUrls: ["https://go-upc.com/7451254957818"], sourceSnippets: [], groundingChunks: [],
    });
    expect(ev.verified, "the different EAN 7451254957818 must NOT satisfy the scanned 745125495781").toBe(false);
    expect(ev.strength).toBe("none");

    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "" })],
      evidences: [ev], confidenceThreshold: 0.8, code: "745125495781", scanContext: "any",
    });
    expect(r.status).not.toBe("verified"); // routes to Needs Review (evidence never confirmed the exact code)
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(false);
  });
});
