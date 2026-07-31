import { describe, expect, it } from "vitest";

import { evaluateIdentityCases, sha256ForIdentityEvaluation } from "./evaluator";
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
  it("uses standard SHA-256 vectors for ASCII, UTF-8, and multi-block inputs", () => {
    expect(sha256ForIdentityEvaluation("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256ForIdentityEvaluation("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256ForIdentityEvaluation("é😀")).toBe("1184d1f608158eea09d297565575892231550c403aaa913008d867a97cfd5c76");
    expect(sha256ForIdentityEvaluation("a".repeat(100))).toBe("2816597888e4a0d3a36b82b83316ab32680eb8f00f8cd3b9045a1f2dce0fbd7d");
  });
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

  it("counts wrong, negative, and targetless automatic decisions as false automatic", () => {
    const automaticCases: IdentityEvaluationCase[] = [
      { ...cases[0]!, caseId: "wrong", truthProductId: "product-a" },
      { ...cases[0]!, caseId: "negative", truthProductId: undefined },
      { ...cases[0]!, caseId: "missing-target", truthProductId: "product-a" },
    ];
    const automaticDecisions: IdentityEvaluationDecision[] = [
      { caseId: "wrong", kind: "automatic", targetProductId: "wrong-product", candidateProductIds: ["wrong-product"], latencyMs: 1 },
      { caseId: "negative", kind: "automatic", candidateProductIds: [], latencyMs: 1 },
      { caseId: "missing-target", kind: "automatic", candidateProductIds: ["product-a"], latencyMs: 1 },
    ];

    const metrics = evaluateIdentityCases(automaticCases, automaticDecisions, { bootstrapSamples: 10 });

    expect(metrics.falseAutomatic).toEqual({ numerator: 3, denominator: 3, rate: 1, gatePassed: false });
    expect(metrics.correctAutomaticCoverage).toEqual({ numerator: 0, denominator: 2, rate: 0 });
  });

  it("uses fixed SHA-256 golden group assignments and validates bootstrap sample bounds", () => {
    const metrics = evaluateIdentityCases(cases, decisions, { splitSeed: "split-seed", bootstrapSeed: "stable-seed", bootstrapSamples: 10 });

    expect(metrics.split).toEqual({ "group-a": "train", "group-b": "train", "group-c": "train" });
    expect(metrics.confidenceIntervals.falseAutomatic).toEqual({ lower: 0, upper: 0, samples: 10, method: "fixed-seed-group-bootstrap" });
    expect(() => evaluateIdentityCases(cases, decisions, { bootstrapSamples: 0 })).toThrow("invalid_bootstrap_samples");
    expect(() => evaluateIdentityCases(cases, decisions, { bootstrapSamples: -1 })).toThrow("invalid_bootstrap_samples");
    expect(() => evaluateIdentityCases(cases, decisions, { bootstrapSamples: 1.5 })).toThrow("invalid_bootstrap_samples");
  });

  it("handles empty and one-group evaluation deterministically", () => {
    const empty = evaluateIdentityCases([], [], { bootstrapSamples: 2 });
    const oneGroup = evaluateIdentityCases([cases[0]!], [decisions[0]!], { bootstrapSamples: 2 });

    expect(empty.rowAccounting).toEqual({ automatic: 0, review: 0, abstain: 0, non_product: 0, invalid: 0, input: 0, exact: true });
    expect(empty.confidenceIntervals.correctAutomaticCoverage).toEqual({ lower: 0, upper: 0, samples: 2, method: "fixed-seed-group-bootstrap" });
    expect(oneGroup.confidenceIntervals.correctAutomaticCoverage).toEqual({ lower: 1, upper: 1, samples: 2, method: "fixed-seed-group-bootstrap" });
  });
});
