import { describe, expect, test } from "vitest";
import { shouldRunGptRung, gptResultToDecodePayload, capTierForFirewall } from "./gptLadderRung";
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
  test("tier none maps to null (nothing to apply)", () => {
    expect(gptResultToDecodePayload(gptResult({ tier: "none" }), "049000028904")).toBeNull();
  });

  test("tier verified maps to a verified decision with the gpt_self_report corroboration path", () => {
    const r = gptResult({
      tier: "verified", brand: "Falken", productName: "Falken Wildpeak A/T3W 265/70R17",
      specs: "265/70R17 115T", gtin: "848983006257", confidence: 0.92, exactCodeFound: true,
      basis: "exact code on tirerack page", sourceUrls: ["https://www.tirerack.com/x"],
    });
    const payload = gptResultToDecodePayload(r, "848983006257");
    expect(payload).not.toBeNull();
    expect(payload!.decision.status).toBe("verified");
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

  test("tier info_only maps to needs_review with a 'background info only:' prefixed reasonText", () => {
    const r = gptResult({
      tier: "info_only", brand: "Goodyear", productName: "Goodyear (best guess, low confidence)",
      confidence: 0.3, exactCodeFound: false, basis: "barcode prefix suggests Goodyear family",
    });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    expect(payload.decision.status).toBe("needs_review");
    expect(payload.result.needsHumanReview).toBe(true);
    expect(payload.result.confidence).toBe(0.3);
    expect(payload.reasonText.startsWith("background info only: ")).toBe(true);
  });

  // CACHE-SAFETY CONTRACT (IMPORTANT 1): decode.ts documents "needs_review is reserved for no provider
  // produced a product" - the route's withDecodeCache decides PERMANENT-vs-retryable from
  // isUsableProductName(result.productName). An info_only tier is exactly a weak GPT guess: it must
  // NEVER carry a usable productName (or that guess gets cached FOREVER and the code can never
  // re-decode). The guess text must still reach the human via `guesses` instead.
  test("tier info_only: productName is EMPTY (never poisons the decode cache) and the guess lives in `guesses`", () => {
    const r = gptResult({
      tier: "info_only", brand: "Goodyear", productName: "Goodyear (best guess, low confidence)",
      confidence: 0.3, exactCodeFound: false, basis: "barcode prefix suggests Goodyear family",
    });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    expect(payload.result.productName).toBe("");
    expect(payload.result.guesses.length).toBeGreaterThan(0);
    expect(payload.result.guesses.some((g) => g.includes("Goodyear (best guess, low confidence)"))).toBe(true);
    expect(payload.result.guesses.some((g) => g.includes("barcode prefix suggests Goodyear family"))).toBe(true);
  });

  test("tier info_only with no basis: productName still empty, guess still carries the productName text", () => {
    const r = gptResult({
      tier: "info_only", brand: "Goodyear", productName: "Goodyear (best guess, low confidence)",
      confidence: 0.3, exactCodeFound: false, basis: "",
    });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    expect(payload.result.productName).toBe("");
    expect(payload.result.guesses).toEqual(["background info: Goodyear (best guess, low confidence)"]);
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

describe("capTierForFirewall", () => {
  test("downgrades a verified payload to suggested when the prefix firewall conflicts", () => {
    const r = gptResult({
      tier: "verified", brand: "Falken", productName: "Falken Wildpeak", confidence: 0.9, exactCodeFound: true,
    });
    const payload = gptResultToDecodePayload(r, "848983006257")!;
    const capped = capTierForFirewall(payload, true)!;
    expect(capped.decision.status).toBe("suggested");
    expect(capped.decision.corroborationPath).toBeUndefined();
    expect(capped.decision.reason).toContain("prefix-firewall conflict: auto-count blocked");
    expect(capped.result.needsHumanReview).toBe(true);
  });

  test("never upgrades - a non-conflicting verified payload passes through unchanged", () => {
    const r = gptResult({ tier: "verified", brand: "Falken", productName: "Falken Wildpeak", confidence: 0.9, exactCodeFound: true });
    const payload = gptResultToDecodePayload(r, "848983006257")!;
    const capped = capTierForFirewall(payload, false);
    expect(capped).toEqual(payload);
  });

  test("a conflict on an already-suggested or needs_review payload is a no-op (nothing to downgrade)", () => {
    const r = gptResult({ tier: "suggested", brand: "Michelin", productName: "Michelin Defender", confidence: 0.6 });
    const payload = gptResultToDecodePayload(r, "049000028904")!;
    const capped = capTierForFirewall(payload, true);
    expect(capped).toEqual(payload);
  });

  test("null payload passes through unchanged", () => {
    expect(capTierForFirewall(null, true)).toBeNull();
  });
});
