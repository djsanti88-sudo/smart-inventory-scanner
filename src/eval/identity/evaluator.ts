import { createHash } from "node:crypto";
import type {
  EvaluateIdentityOptions,
  IdentityAccounting,
  IdentityEvaluationCase,
  IdentityEvaluationDecision,
  IdentityLatencyMetrics,
  IdentityMetricSummary,
  IdentityMetrics,
  IdentityRate,
} from "./types";

const BUCKETS = ["automatic", "review", "abstain", "non_product", "invalid"] as const;
type Bucket = (typeof BUCKETS)[number];
type PairedCase = { evaluationCase: IdentityEvaluationCase; decision: IdentityEvaluationDecision };

/** Locale settings must never change benchmark ordering. */
function compareCodePoints(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Node-only evaluator hash: standards-backed SHA-256 over UTF-8 bytes. */
export function sha256ForIdentityEvaluation(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256(value: string): string {
  return sha256ForIdentityEvaluation(value);
}

function rate(numerator: number, denominator: number): IdentityRate {
  return { numerator, denominator, rate: denominator === 0 ? 0 : numerator / denominator };
}

function accounting(pairs: PairedCase[], quantity: boolean): IdentityAccounting {
  const amounts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<Bucket, number>;
  for (const pair of pairs) amounts[pair.decision.kind] += quantity ? pair.evaluationCase.quantity : 1;
  const input = pairs.reduce((total, pair) => total + (quantity ? pair.evaluationCase.quantity : 1), 0);
  return { ...amounts, input, exact: input === BUCKETS.reduce((total, bucket) => total + amounts[bucket], 0) };
}

function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1)]!;
}

function latency(pairs: PairedCase[]): IdentityLatencyMetrics {
  const values = pairs.map((pair) => pair.decision.latencyMs);
  return { count: values.length, p50: nearestRank(values, 50), p95: nearestRank(values, 95), p99: nearestRank(values, 99), max: nearestRank(values, 100), percentileMethod: "nearest-rank" };
}

function summary(pairs: PairedCase[]): IdentityMetricSummary {
  const positives = pairs.filter((pair) => pair.evaluationCase.truthProductId);
  const automatic = pairs.filter((pair) => pair.decision.kind === "automatic");
  const correctAutomatic = automatic.filter((pair) =>
    Boolean(pair.evaluationCase.truthProductId) &&
    Boolean(pair.decision.targetProductId) &&
    pair.evaluationCase.truthProductId === pair.decision.targetProductId,
  );
  const falseAutomatic = automatic.length - correctAutomatic.length;
  const reviewEligible = positives.filter((pair) => pair.decision.kind !== "automatic");
  const reviewsWithCandidates = pairs.filter((pair) => pair.decision.kind === "review" && pair.decision.candidateProductIds.length > 0);
  const trueInTopThree = (pair: PairedCase) => Boolean(pair.evaluationCase.truthProductId && pair.decision.candidateProductIds.slice(0, 3).includes(pair.evaluationCase.truthProductId));
  return {
    rowAccounting: accounting(pairs, false),
    quantityAccounting: accounting(pairs, true),
    falseAutomatic: { ...rate(falseAutomatic, automatic.length), gatePassed: falseAutomatic === 0 },
    correctAutomaticCoverage: rate(correctAutomatic.length, positives.length),
    reviewRecallAt3: rate(reviewEligible.filter(trueInTopThree).length, reviewEligible.length),
    reviewPrecisionAt3: rate(reviewsWithCandidates.filter(trueInTopThree).length, reviewsWithCandidates.length),
    latency: latency(pairs),
  };
}

function pairCases(cases: readonly IdentityEvaluationCase[], decisions: readonly IdentityEvaluationDecision[]): PairedCase[] {
  const caseIds = new Set<string>();
  const decisionByCase = new Map<string, IdentityEvaluationDecision>();
  for (const evaluationCase of cases) {
    if (!evaluationCase.caseId || !evaluationCase.identityGroupId || !Number.isFinite(evaluationCase.quantity) || evaluationCase.quantity < 0 || caseIds.has(evaluationCase.caseId)) throw new Error("invalid_or_duplicate_case");
    caseIds.add(evaluationCase.caseId);
  }
  for (const decision of decisions) {
    if (!caseIds.has(decision.caseId) || decisionByCase.has(decision.caseId) || !Number.isFinite(decision.latencyMs) || decision.latencyMs < 0) throw new Error("decision_case_mismatch");
    decisionByCase.set(decision.caseId, decision);
  }
  if (decisionByCase.size !== cases.length) throw new Error("decision_case_mismatch");
  return [...cases].sort((left, right) => compareCodePoints(left.caseId, right.caseId)).map((evaluationCase) => ({ evaluationCase, decision: decisionByCase.get(evaluationCase.caseId)! }));
}

function splitGroups(pairs: PairedCase[], seed: string): Record<string, "train" | "dev" | "locked"> {
  const result: Record<string, "train" | "dev" | "locked"> = {};
  for (const groupId of [...new Set(pairs.map((pair) => pair.evaluationCase.identityGroupId))].sort(compareCodePoints)) {
    const bucket = Number.parseInt(sha256(`${seed}\u0000${groupId}`).slice(0, 8), 16) % 10;
    result[groupId] = bucket < 6 ? "train" : bucket < 8 ? "dev" : "locked";
  }
  return result;
}

function random(seed: string): () => number {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}

function bootstrap(pairs: PairedCase[], seed: string, samples: number): IdentityMetrics["confidenceIntervals"] {
  const groups = [...new Set(pairs.map((pair) => pair.evaluationCase.identityGroupId))].sort(compareCodePoints);
  const byGroup = new Map(groups.map((group) => [group, pairs.filter((pair) => pair.evaluationCase.identityGroupId === group)]));
  const values = { falseAutomatic: [] as number[], correctAutomaticCoverage: [] as number[], reviewRecallAt3: [] as number[] };
  const next = random(seed);
  if (groups.length === 0) {
    return Object.fromEntries(Object.keys(values).map((name) => [name, { lower: 0, upper: 0, samples, method: "fixed-seed-group-bootstrap" }])) as IdentityMetrics["confidenceIntervals"];
  }
  for (let index = 0; index < samples; index += 1) {
    const resample = Array.from({ length: groups.length }, () => byGroup.get(groups[Math.floor(next() * groups.length)]!)!).flat();
    const result = summary(resample);
    values.falseAutomatic.push(result.falseAutomatic.rate);
    values.correctAutomaticCoverage.push(result.correctAutomaticCoverage.rate);
    values.reviewRecallAt3.push(result.reviewRecallAt3.rate);
  }
  return Object.fromEntries(Object.entries(values).map(([name, rates]) => [name, { lower: nearestRank(rates, 2.5), upper: nearestRank(rates, 97.5), samples, method: "fixed-seed-group-bootstrap" }])) as IdentityMetrics["confidenceIntervals"];
}

function dimensions(pairs: PairedCase[]): IdentityMetrics["strata"] {
  const collect = (key: keyof Pick<IdentityEvaluationCase, "category" | "sourceSystem" | "vendorId" | "transformation" | "stratum">) => Object.fromEntries(
    [...new Set(pairs.map((pair) => pair.evaluationCase[key]))].sort(compareCodePoints).map((value) => [value, summary(pairs.filter((pair) => pair.evaluationCase[key] === value))]),
  );
  return { category: collect("category"), sourceSystem: collect("sourceSystem"), vendorId: collect("vendorId"), transformation: collect("transformation"), stratum: collect("stratum") };
}

/** Pure evaluator: it has no filesystem, provider, network, or persistence dependency. */
export function evaluateIdentityCases(cases: readonly IdentityEvaluationCase[], decisions: readonly IdentityEvaluationDecision[], options: EvaluateIdentityOptions = {}): IdentityMetrics {
  const bootstrapSamples = options.bootstrapSamples ?? 1_000;
  if (!Number.isInteger(bootstrapSamples) || bootstrapSamples <= 0 || bootstrapSamples > 100_000) throw new Error("invalid_bootstrap_samples");
  const pairs = pairCases(cases, decisions);
  const base = summary(pairs);
  if (!base.rowAccounting.exact || !base.quantityAccounting.exact) throw new Error("accounting_not_exact");
  return {
    ...base,
    split: splitGroups(pairs, options.splitSeed ?? "identity-split-v1"),
    confidenceIntervals: bootstrap(pairs, options.bootstrapSeed ?? "identity-bootstrap-v1", bootstrapSamples),
    strata: dimensions(pairs),
  };
}
