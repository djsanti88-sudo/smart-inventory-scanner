import { describe, it, expect } from "vitest";
import { decideDecode } from "@/services/ai/decode";
import { emptyResult } from "@/services/ai/provider";
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

  it("uses ONLY the strong tier: a weak-tier-only prefix (Nexen Korea EAN 8807622) does NOT corroborate", () => {
    const r = decideDecode({
      codeType: "ean_13",
      results: [tire({ productName: "Nexen Roadian GTX 235/65R18 106V", brand: "Nexen", specsShort: "235/65R18 106V" })],
      evidences: [strongEv("8807622002083")], confidenceThreshold: 0.85, code: "8807622002083", scanContext: "tire",
    });
    expect(r.status).not.toBe("verified"); // 8807622 is hint_weak only -> never corroborates
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
