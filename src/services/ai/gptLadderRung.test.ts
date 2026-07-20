import { describe, expect, test } from "vitest";
import { shouldRunGptRung, gptResultToDecodePayload } from "./gptLadderRung";
import type { GptFromScratchResult } from "./gptFromScratch";
import { GPT_LADDER_WORST_CASE_USD } from "./gptFromScratch";

const okBudget = { allowed: true, spentUsd: 0, capUsd: 3 };
const blockedBudget = { allowed: false, spentUsd: 2.9, capUsd: 3 };

const baseInput = {
  code: "049000028904",
  codeType: "upc_a",
  priorStatus: undefined as string | undefined,
  e2e: false,
  apiKeyPresent: true,
  // LAZY budget: a thunk, not a pre-computed value (MINOR 3 - the route must not pay for the sync
  // budget-file read when an earlier, cheaper check already decided to skip).
  budget: () => okBudget,
};

describe("shouldRunGptRung", () => {
  test("runs when the ladder found nothing, code is public, online, keyed, and under budget", () => {
    expect(shouldRunGptRung(baseInput)).toEqual({ run: true, skipReason: "" });
  });

  test("skips when a prior rung already verified the code", () => {
    const r = shouldRunGptRung({ ...baseInput, priorStatus: "verified" });
    expect(r.run).toBe(false);
    expect(r.skipReason).toBeTruthy();
  });

  test("skips when a prior rung already produced a suggested match", () => {
    const r = shouldRunGptRung({ ...baseInput, priorStatus: "suggested" });
    expect(r.run).toBe(false);
    expect(r.skipReason).toBeTruthy();
  });

  test("does NOT skip on a prior needs_review/conflict status (those are exactly what the rung should try to resolve)", () => {
    expect(shouldRunGptRung({ ...baseInput, priorStatus: "needs_review" }).run).toBe(true);
    expect(shouldRunGptRung({ ...baseInput, priorStatus: "conflict" }).run).toBe(true);
  });

  test("skips vendor_label codeType (Amazon FNSKU/ASIN labels never reach GPT)", () => {
    const r = shouldRunGptRung({ ...baseInput, codeType: "vendor_label" });
    expect(r.run).toBe(false);
    expect(r.skipReason).toBeTruthy();
  });

  test("skips a raw FNSKU-shaped code even if the caller passed a stale/wrong codeType", () => {
    const r = shouldRunGptRung({ ...baseInput, code: "X001DY7YUT", codeType: "alpha_sku" });
    expect(r.run).toBe(false);
    expect(r.skipReason).toBeTruthy();
  });

  test("skips under E2E (mock path is handled separately by the route)", () => {
    const r = shouldRunGptRung({ ...baseInput, e2e: true });
    expect(r.run).toBe(false);
    expect(r.skipReason).toBeTruthy();
  });

  test("skips when no OpenAI API key is configured", () => {
    const r = shouldRunGptRung({ ...baseInput, apiKeyPresent: false });
    expect(r.run).toBe(false);
    expect(r.skipReason).toBeTruthy();
  });

  test("skips when the daily dollar budget is not allowed", () => {
    const r = shouldRunGptRung({ ...baseInput, budget: () => blockedBudget });
    expect(r.run).toBe(false);
    expect(r.skipReason).toBeTruthy();
  });

  test("each skip reason is a distinct, explicit string (no generic catch-all)", () => {
    const reasons = new Set([
      shouldRunGptRung({ ...baseInput, priorStatus: "verified" }).skipReason,
      shouldRunGptRung({ ...baseInput, codeType: "vendor_label" }).skipReason,
      shouldRunGptRung({ ...baseInput, e2e: true }).skipReason,
      shouldRunGptRung({ ...baseInput, apiKeyPresent: false }).skipReason,
      shouldRunGptRung({ ...baseInput, budget: () => blockedBudget }).skipReason,
    ]);
    expect(reasons.size).toBe(5);
  });

  // MINOR 3: the budget guard does a SYNCHRONOUS file read (checkGptLadderBudget). It must never pay
  // that cost when an earlier, cheaper check (prior status / codeType / e2e / api key) already decided
  // to skip - so `budget` is a thunk and shouldRunGptRung must not invoke it unless it reaches that
  // final check.
  test("never calls the budget thunk when an earlier cheap check already skips", () => {
    const spy = () => { throw new Error("budget thunk must not be called - an earlier check should have skipped first"); };
    expect(shouldRunGptRung({ ...baseInput, priorStatus: "verified", budget: spy }).run).toBe(false);
    expect(shouldRunGptRung({ ...baseInput, codeType: "vendor_label", budget: spy }).run).toBe(false);
    expect(shouldRunGptRung({ ...baseInput, e2e: true, budget: spy }).run).toBe(false);
    expect(shouldRunGptRung({ ...baseInput, apiKeyPresent: false, budget: spy }).run).toBe(false);
  });

  test("DOES call the budget thunk once every cheaper check has passed", () => {
    let calls = 0;
    const r = shouldRunGptRung({ ...baseInput, budget: () => { calls++; return okBudget; } });
    expect(r.run).toBe(true);
    expect(calls).toBe(1);
  });
});

function gptResult(overrides: Partial<GptFromScratchResult>): GptFromScratchResult {
  return {
    tier: "none",
    brand: "",
    productName: "",
    category: "",
    specs: "",
    gtin: "",
    confidence: 0,
    exactCodeFound: false,
    basis: "",
    sourceUrls: [],
    searches: 1,
    usdActual: 0.02,
    usdWorstCase: GPT_LADDER_WORST_CASE_USD,
    aborted: false,
    ...overrides,
  };
}

describe("gptResultToDecodePayload", () => {
  test("PROBE PARITY (owner order 2026-07-06): a verified-tier answer passes through even on a short code - no downgrade wrapper - but the decision.status is now demoted to suggested (D6 core, 2026-07-20)", () => {
    // The old short-code (<10 digit) verified->suggested cap was deleted with the rest of the
    // wrapper: GPT's answer (result payload fields) is taken exactly as returned. The DECISION status,
    // however, is now demoted: a bare GPT self-report can never mint "verified" (D6 core).
    const r = gptResult({
      tier: "verified", brand: "Qbake", productName: "Qbake Arabic Bread Brown",
      confidence: 0.86, exactCodeFound: true, gtin: "10011126",
    });
    const payload = gptResultToDecodePayload(r, "10011126");
    expect(payload).not.toBeNull();
    expect(payload!.decision.status).toBe("suggested");
    expect(payload!.decision.status).not.toBe("verified");
    expect(payload!.result.needsHumanReview).toBe(false);
  });

  test("tier none maps to null (nothing to apply)", () => {
    expect(gptResultToDecodePayload(gptResult({ tier: "none" }), "049000028904")).toBeNull();
  });

  test("tier verified maps to a SUGGESTED decision (D6 core demotion) with the gpt_self_report corroboration path preserved", () => {
    const r = gptResult({
      tier: "verified", brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17",
      specs: "265/70R17 115T", gtin: "848983006257", confidence: 0.92, exactCodeFound: true,
      basis: "exact code on tirerack page", sourceUrls: ["https://www.tirerack.com/x"],
    });
    const payload = gptResultToDecodePayload(r, "848983006257");
    expect(payload).not.toBeNull();
    // D6 core (2026-07-20): a bare GPT self-report can never mint "verified" - it is demoted to a
    // suggestion. corroborationPath/exactCodeEvidenceVerifiedByApp stay honest (unchanged).
    expect(payload!.decision.status).toBe("suggested");
    expect(payload!.decision.status).not.toBe("verified");
    expect(payload!.decision.confidence).toBe(0.92);
    expect(payload!.decision.corroborationPath).toBe("gpt_self_report");
    expect(payload!.decision.exactCodeEvidenceVerifiedByApp).toBe(false);
    expect(payload!.decision.crossCheck.decision).toBe("single_provider");
    expect(payload!.result.productName).toBe("Falken Wildpeak A/T3W 265/70R17");
    expect(payload!.result.brand).toBe("Falken");
    expect(payload!.result.specsShort).toBe("265/70R17 115T");
    expect(payload!.result.gtin).toBe("848983006257");
    expect(payload!.result.needsHumanReview).toBe(false);
    expect(payload!.result.guesses).toEqual(["exact code on tirerack page"]);
    expect(payload!.reasonText).toBe("");
  });

  test("tier suggested maps to a suggested decision (no corroborationPath - that is verified-only)", () => {
    const r = gptResult({
      tier: "suggested", brand: "Michelin", productName: "Michelin Defender 225/65R17",
      confidence: 0.6, exactCodeFound: false, basis: "partial prefix match",
    });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    expect(payload.decision.status).toBe("suggested");
    expect(payload.decision.corroborationPath).toBeUndefined();
    expect(payload.result.needsHumanReview).toBe(true);
  });

  test("PROBE PARITY (owner order 2026-07-06): a weak best-guess is a normal suggested payload - the name is shown, never buried", () => {
    // The old info_only tier (productName emptied, guess demoted to background text) is deleted:
    // a 0.3-confidence guess IS the suggestion, exactly as the probe displayed it.
    const r = gptResult({
      tier: "suggested", brand: "Goodyear", productName: "Goodyear (best guess, low confidence)",
      confidence: 0.3, exactCodeFound: false, basis: "barcode prefix suggests Goodyear family",
    });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    expect(payload.decision.status).toBe("suggested");
    expect(payload.result.productName).toBe("Goodyear (best guess, low confidence)");
    expect(payload.result.needsHumanReview).toBe(true);
    expect(payload.result.confidence).toBe(0.3);
    expect(payload.result.guesses).toEqual(["barcode prefix suggests Goodyear family"]);
    expect(payload.reasonText).toBe("");
  });

  test("category threads through into the emitted suggestion result (prompt v3)", () => {
    const r = gptResult({
      tier: "suggested", brand: "Toyo", productName: "Toyo Open Country A/T III",
      category: "Tires", confidence: 0.6, exactCodeFound: false, basis: "prefix match",
    });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    expect(payload.result.category).toBe("Tires");
  });

  test("gtin/upc/ean identifier fields are populated only for a 12-14 digit gtin", () => {
    const upc = gptResultToDecodePayload(gptResult({ tier: "suggested", productName: "x", confidence: 0.6, gtin: "049000028904" }), "049000028904")!;
    expect(upc.result.gtin).toBe("049000028904");
    expect(upc.result.upc).toBe("049000028904");
    expect(upc.result.ean).toBe("");

    const ean = gptResultToDecodePayload(gptResult({ tier: "suggested", productName: "x", confidence: 0.6, gtin: "8480000282904" }), "8480000282904")!;
    expect(ean.result.ean).toBe("8480000282904");
    expect(ean.result.upc).toBe("");

    const junk = gptResultToDecodePayload(gptResult({ tier: "suggested", productName: "x", confidence: 0.6, gtin: "123" }), "123")!;
    expect(junk.result.gtin).toBe("");
    expect(junk.result.upc).toBe("");
    expect(junk.result.ean).toBe("");
  });
});

// capTierForFirewall was DELETED (owner order 2026-07-06, "no questioning their answers"):
// GPT's verified self-report is no longer downgraded by the prefix firewall.

// BUG #14 (medium, info-disclosure, QA hardening 2026-07-16): decision.reason for a verified or
// suggested GPT-ladder settle used to hardcode "gpt-5.5 from-scratch: ..." - the model name is
// gratuitous customer-facing text and must never appear on a scan row. The reason must still be
// honest (it should explain the row is a self-reported / best-guess identity, review-first).
describe("gptResultToDecodePayload decision.reason is token-free (BUG #14)", () => {
  const DENYLIST_RE = /upcitemdb|openfoodfacts|goupc|go-upc|fetchv2|fetch v2|gpt[-_ ]?5\.5|gpt-5\.5-ladder|gpt_call_failed|gpt_aborted_at_cap|no_api_key|non_public_code_type|e2e_mode|budget_exceeded|prior_status_already_decided|\bladder\b|parallel:|tire-corpus|retail-corpus|learned-products/i;

  test("verified decision.reason names no vendor/model token and is non-empty", () => {
    const r = gptResult({
      tier: "verified", brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17",
      gtin: "848983006257", confidence: 0.92, exactCodeFound: true, basis: "exact code on tirerack page",
    });
    const payload = gptResultToDecodePayload(r, "848983006257")!;
    expect(payload.decision.reason.length).toBeGreaterThan(0);
    expect(DENYLIST_RE.test(payload.decision.reason)).toBe(false);
  });

  test("suggested decision.reason names no vendor/model token and is non-empty", () => {
    const r = gptResult({
      tier: "suggested", brand: "Michelin", productName: "Michelin Defender 225/65R17",
      confidence: 0.6, exactCodeFound: false, basis: "partial prefix match",
    });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    expect(payload.decision.reason.length).toBeGreaterThan(0);
    expect(DENYLIST_RE.test(payload.decision.reason)).toBe(false);
  });
});
