import { describe, expect, it } from "vitest";

import { evaluateIdentityCases } from "./evaluator";
import type { IdentityEvaluationCase, IdentityEvaluationDecision } from "./types";

const cases: IdentityEvaluationCase[] = [
  {
    caseId: "automatic-positive",
    identityGroupId: "group-a",
    category: "tire",
    sourceSystem: "fixture",
    vendorId: "vendor-a",
    transformation: "exact",
    stratum: "positive",
    quantity: 2,
    truthProductId: "product-a",
  },
  {
    caseId: "review-missing-truth",
    identityGroupId: "group-b",
    category: "tire",
    sourceSystem: "fixture",
    vendorId: "vendor-a",
    transformation: "missing-barcode",
    stratum: "missing-identifier",
    quantity: 3,
    truthProductId: "product-b",
  },
  {
    caseId: "safe-abstain",
    identityGroupId: "group-c",
    category: "tire",
    sourceSystem: "fixture",
    vendorId: "vendor-a",
    transformation: "negative",
    stratum: "negative",
    quantity: 1,
  },
];

const decisions: IdentityEvaluationDecision[] = [
  { caseId: "automatic-positive", kind: "automatic", targetProductId: "product-a", candidateProductIds: ["product-a"], latencyMs: 1 },
  { caseId: "review-missing-truth", kind: "review", candidateProductIds: ["wrong-product"], latencyMs: 2 },
  { caseId: "safe-abstain", kind: "abstain", candidateProductIds: [], latencyMs: 3 },
];

describe("evaluateIdentityCases", () => {
  it("accounts for immutable automatic, review-miss, and abstain cases exactly once", () => {
    const metrics = evaluateIdentityCases(cases, decisions, { bootstrapSeed: "test-seed", bootstrapSamples: 40 });

    expect(metrics.rowAccounting).toEqual({ automatic: 1, review: 1, abstain: 1, non_product: 0, invalid: 0, input: 3, exact: true });
    expect(metrics.quantityAccounting).toEqual({ automatic: 2, review: 3, abstain: 1, non_product: 0, invalid: 0, input: 6, exact: true });
    expect(metrics.falseAutomatic).toEqual({ numerator: 0, denominator: 1, rate: 0, gatePassed: true });
    expect(metrics.correctAutomaticCoverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(metrics.reviewRecallAt3).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(metrics.reviewPrecisionAt3).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(metrics.latency).toEqual({ count: 3, p50: 2, p95: 3, p99: 3, max: 3, percentileMethod: "nearest-rank" });
  });

  it("uses a deterministic identity-group split and group-bootstrap confidence interval", () => {
    const first = evaluateIdentityCases(cases, decisions, { bootstrapSeed: "stable-seed", bootstrapSamples: 40, splitSeed: "split-seed" });
    const second = evaluateIdentityCases([...cases].reverse(), [...decisions].reverse(), {
      bootstrapSeed: "stable-seed",
      bootstrapSamples: 40,
      splitSeed: "split-seed",
    });

    expect(first.split).toEqual(second.split);
    expect(first.confidenceIntervals).toEqual(second.confidenceIntervals);
    expect(first.strata.category.tire.rowAccounting.input).toBe(3);
  });

  it("fails closed when case or decision accounting is not one-to-one", () => {
    expect(() => evaluateIdentityCases(cases, decisions.slice(0, 2))).toThrow("decision_case_mismatch");
  });
});
