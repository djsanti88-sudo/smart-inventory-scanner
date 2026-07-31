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

function handwrittenSha256Removed(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) words[index >> 2] = (words[index >> 2] ?? 0) | (bytes[index] << (24 - (index % 4) * 8));
  words[bytes.length >> 2] = (words[bytes.length >> 2] ?? 0) | (0x80 << (24 - (bytes.length % 4) * 8));
  words[(((bytes.length + 8) >> 6) << 4) + 15] = bytes.length * 8;
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rightRotate = (number: number, places: number) => (number >>> places) | (number << (32 - places));
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = words.slice(offset, offset + 16);
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15]!;
      const b = schedule[index - 2]!;
      schedule[index] = (schedule[index - 16]! + (rightRotate(a, 7) ^ rightRotate(a, 18) ^ (a >>> 3)) + schedule[index - 7]! + (rightRotate(b, 17) ^ rightRotate(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[index]! + schedule[index]!) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    hash = [hash[0]! + a, hash[1]! + b, hash[2]! + c, hash[3]! + d, hash[4]! + e, hash[5]! + f, hash[6]! + g, hash[7]! + h];
  }
  return hash.map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
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
