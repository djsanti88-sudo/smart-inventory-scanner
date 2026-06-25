import { describe, it, expect } from "vitest";
import { decideDecode } from "@/services/ai/decode";
import { emptyResult } from "@/services/ai/provider";
import { verifyEvidence } from "@/services/ai/evidenceVerifier";
import type { AiLookupResult, EvidenceResult } from "@/types";

// Deterministic tire corroboration: a single-provider tire decode AUTO-COUNTS (status "verified") only
// when the barcode's STRONG brand-prefix family + tire context + full specs + app-verified exact code all
// agree (an independent, non-AI-text source). Mismatch / non-tire / missing specs / weak evidence / wrong
// context can never satisfy it, and confidence alone never does.

const tire = (over: Partial<AiLookupResult>): AiLookupResult => ({ ...emptyResult(), confidence: 0.92, ...over });
const strongEv = (code: string): EvidenceResult => ({ verified: true, strength: "snippet", matchedCode: code, matchedSources: ["snippet"], reason: "" });
const weakEv = (): EvidenceResult => ({ verified: false, strength: "none", matchedCode: "", matchedSources: [], reason: "" });

// Cooper owns the STRONG prefix 029142 (029142712886 -> family Cooper/Mastercraft/Starfire).
const COOPER = tire({ productName: "Cooper Discoverer A/T3 LT245/75R16 120R", brand: "Cooper", specsShort: "LT245/75R16 120R" });

// PATH 2 (Phase 9): page-fetch + one independent model agreement. A tire whose code is NOT in a strong
// prefix family can still auto-count when the page-fetch result was corroborated by an independent model
// read of the same page (result.corroboratedByModel) AND all hard gates pass. Never page-fetch alone,
// never model-only, never a non-tire, never spec-less, never weak evidence.
describe("decideDecode - PATH 2 page-fetch + model agreement", () => {
  // A real tire brand (so the tire-domain gate passes) on a code that is NOT in any prefix family - the UPC
  // 012345678905 maps to no tire prefix. This isolates PATH 2 (page-fetch + model agreement, no prefix help)
  // and stays valid as the real prefix table grows. (Continental, used before, is now a sibling on 051342.)
  const SYNTH = (over: Partial<AiLookupResult> = {}) =>
    tire({ productName: "Kumho Crugen HP71 265/70R17 115T", brand: "Kumho", specsShort: "265/70R17 115T", ...over });

  it("AUTO-VERIFIES via page_fetch_model_agreement when corroboratedByModel + full specs + strong evidence", () => {
    const r = decideDecode({ codeType: "upc_a", results: [SYNTH({ corroboratedByModel: true })], evidences: [strongEv("012345678905")], confidenceThreshold: 0.85, code: "012345678905", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.corroborationPath).toBe("page_fetch_model_agreement");
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("page-fetch ALONE (no model corroboration) stays SUGGESTED - never auto-counts", () => {
    const r = decideDecode({ codeType: "upc_a", results: [SYNTH({ corroboratedByModel: false })], evidences: [strongEv("012345678905")], confidenceThreshold: 0.85, code: "012345678905", scanContext: "tire" });
    expect(r.status).toBe("suggested");
  });

  it("PATH 2 requires FULL specs: a spec-less tire with model corroboration does NOT verify", () => {
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Continental TerrainContact A/T", brand: "Continental", specsShort: "", corroboratedByModel: true })], evidences: [strongEv("012345678905")], confidenceThreshold: 0.85, code: "012345678905", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("PATH 2 requires the TIRE domain: a non-tire with model corroboration does NOT verify (poison shape)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "", corroboratedByModel: true })], evidences: [strongEv("745125495781")], confidenceThreshold: 0.85, code: "745125495781", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("PATH 2 requires STRONG app-verified evidence: model corroboration on weak evidence does NOT verify", () => {
    const r = decideDecode({ codeType: "upc_a", results: [SYNTH({ corroboratedByModel: true })], evidences: [weakEv()], confidenceThreshold: 0.85, code: "012345678905", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("PATH 2 is tire-context only: corroboratedByModel in scanContext 'any' does NOT verify", () => {
    const r = decideDecode({ codeType: "upc_a", results: [SYNTH({ corroboratedByModel: true })], evidences: [strongEv("012345678905")], confidenceThreshold: 0.85, code: "012345678905", scanContext: "any" });
    expect(r.status).not.toBe("verified");
  });
});

describe("decideDecode - deterministic tire corroboration", () => {
  it("AUTO-VERIFIES a corroborated single-provider tire (strong family + specs + app-verified code)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [strongEv("029142712886")], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(true);
    expect(r.reason).toMatch(/corroborated/i);
  });

  it("does NOT verify the poison (Manstel rivet kit, non-tire) even with app-verified evidence", () => {
    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "" })],
      evidences: [strongEv("745125495781")], confidenceThreshold: 0.85, code: "745125495781", scanContext: "tire",
    });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT verify a brand/prefix MISMATCH (Bridgestone on Cooper's 029142 barcode)", () => {
    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Bridgestone Dueler H/T 245/75R16 120R", brand: "Bridgestone", specsShort: "245/75R16 120R" })],
      evidences: [strongEv("029142712886")], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire",
    });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT verify a tire missing required specs (no size/load/speed)", () => {
    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Cooper Discoverer A/T3", brand: "Cooper", specsShort: "" })],
      evidences: [strongEv("029142712886")], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire",
    });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT corroborate outside tire context (scanContext 'any')", () => {
    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [strongEv("029142712886")], confidenceThreshold: 0.85, code: "029142712886", scanContext: "any" });
    expect(r.status).not.toBe("verified");
  });

  it("does NOT corroborate on weak/unverified evidence (exact code not app-confirmed)", () => {
    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [weakEv()], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("uses ONLY the strong tier: a weak-tier-only prefix (Nokian Finland EAN 6413613) does NOT corroborate", () => {
    const r = decideDecode({
      codeType: "ean_13",
      results: [tire({ productName: "Nokian Hakkapeliitta R5 235/65R18 106R", brand: "Nokian", specsShort: "235/65R18 106R" })],
      evidences: [strongEv("6413613001234")], confidenceThreshold: 0.85, code: "6413613001234", scanContext: "tire",
    });
    expect(r.status).not.toBe("verified"); // 6413613 is hint_weak only -> never corroborates
  });

  it("two independent providers that AGREE still auto-verify without any prefix corroboration", () => {
    const p = tire({ productName: "Acme Mystery 12 pack", brand: "Acme", upc: "012345678905" });
    const r = decideDecode({ codeType: "upc_a", results: [p, p], evidences: [strongEv("012345678905"), strongEv("012345678905")], confidenceThreshold: 0.85, code: "012345678905", scanContext: "any" });
    expect(r.status).toBe("verified");
  });

  it("a single provider with NO corroboration stays Suggested (unchanged)", () => {
    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Generic Snack Bar", brand: "Generic", upc: "012345678905" })],
      evidences: [strongEv("012345678905")], confidenceThreshold: 0.85, code: "012345678905", scanContext: "any",
    });
    expect(r.status).toBe("suggested");
  });
});

// END-TO-END evidence path: the exact-code-evidence fix means the strong evidence that unlocks
// corroboration comes from a REAL fetched page (verifyEvidence over fetchedSourceText), not a synthetic
// flag. These tests drive verifyEvidence with actual page text so they prove the live mechanism: a tire
// auto-counts ONLY when the scanned code is confirmed in the page the app fetched.
describe("decideDecode - tire corroboration via fetched_source page text", () => {
  // A realistic product-DB page body for the Cooper tire (contains the exact scanned UPC).
  const cooperPage =
    "Cooper Discoverer A/T3 LT245/75R16 120R. UPC 029142712886. Light truck all-terrain tire. In stock.";

  it("auto-VERIFIES a strong-prefix-family tire when the fetched page CONFIRMS the exact code", () => {
    const ev = verifyEvidence("029142712886", "upc_a", {
      fetchedSourceText: cooperPage, sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"], sourceSnippets: [], groundingChunks: [],
    });
    expect(ev.verified).toBe(true);
    expect(ev.strength).toBe("fetched_source"); // verified from the real page text, not url_only

    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [ev], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire" });
    expect(r.status).toBe("verified");
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(true);
    expect(r.evidenceStrength).toBe("fetched_source");
  });

  it("does NOT verify when the fetched page does NOT contain the scanned code (no real confirmation)", () => {
    // Page is about a different code -> fetched_source cannot confirm 029142712886 -> evidence none.
    const ev = verifyEvidence("029142712886", "upc_a", {
      fetchedSourceText: "Bridgestone Dueler H/T. UPC 012000001291. In stock.", sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"], sourceSnippets: [], groundingChunks: [],
    });
    expect(ev.verified).toBe(false);

    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [ev], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified"); // stays Suggested/review: never auto-count without real confirmation
  });

  it("poison 745125495781 (Manstel rivet kit) in tire context stays NEEDS REVIEW even with a confirming page", () => {
    // The poison's own page genuinely contains its code (fetched_source verifies), yet it must NOT
    // auto-count: Manstel is not in any STRONG tire prefix family and the product is non-tire.
    const poisonPage = "Manstel 200 Pcs Aluminum Rivet Screw Kit. UPC 745125495781. Hardware.";
    const ev = verifyEvidence("745125495781", "upc_a", {
      fetchedSourceText: poisonPage, sourceUrls: ["https://go-upc.com/745125495781"], sourceSnippets: [], groundingChunks: [],
    });
    expect(ev.verified).toBe(true); // the code IS on the page...

    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "" })],
      evidences: [ev], confidenceThreshold: 0.85, code: "745125495781", scanContext: "tire",
    });
    expect(r.status).not.toBe("verified"); // ...but corroboration still refuses it (layer 1)
  });

  it("url_only on an UNTRUSTED product-DB host stays verified:false (not enough to corroborate)", () => {
    // The exact code appears ONLY in the URL of a crowd barcode DB (which echoes any code) -> url_only,
    // untrusted -> NOT verified. A tire backed only by such evidence must NOT auto-count.
    const ev = verifyEvidence("029142712886", "upc_a", {
      fetchedSourceText: "", sourceUrls: ["https://www.upcitemdb.com/upc/029142712886"], sourceSnippets: [], groundingChunks: [],
    }, { trustedHosts: ["gs1.org", "gtin.info"] });
    expect(ev.verified).toBe(false);
    expect(ev.strength).toBe("url_only");

    const r = decideDecode({ codeType: "upc_a", results: [COOPER], evidences: [ev], confidenceThreshold: 0.85, code: "029142712886", scanContext: "tire" });
    expect(r.status).not.toBe("verified");
  });

  it("NON-MATCHING code (745125495781 -> go-upc returns a DIFFERENT EAN 7451254957818) is never verified", () => {
    // The real bug: go-upc says 745125495781 is "not a valid UPC" and returns a DIFFERENT GTIN
    // (7451254957818 = Manstel rivet kit). The scanned code does NOT appear on the page - only the longer,
    // different code does. The verifier must require the EXACT scanned code (numeric, exact), so this
    // yields none/url_only, exactCodeEvidenceVerifiedByApp=false, and the decode is never "verified".
    const goUpcPage = "Sorry, 745125495781 is not a valid UPC. Did you mean: Manstel 200 Pcs Aluminum Rivet Screw Kit, GTIN 7451254957818?";
    const ev = verifyEvidence("745125495781", "upc_a", {
      fetchedSourceText: goUpcPage, sourceUrls: ["https://go-upc.com/7451254957818"], sourceSnippets: [], groundingChunks: [],
    });
    expect(ev.verified, "the different EAN 7451254957818 must NOT satisfy the scanned 745125495781").toBe(false);
    expect(ev.strength).toBe("none");

    const r = decideDecode({
      codeType: "upc_a",
      results: [tire({ productName: "Manstel 200 Pcs Aluminum Rivet Screw Kit", brand: "Manstel", specsShort: "" })],
      evidences: [ev], confidenceThreshold: 0.85, code: "745125495781", scanContext: "tire",
    });
    expect(r.status).not.toBe("verified"); // routes to Needs Review (evidence + firewall both hold)
    expect(r.exactCodeEvidenceVerifiedByApp).toBe(false);
  });
});
