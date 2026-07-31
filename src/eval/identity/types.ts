import type { IdentityDecisionKind } from "@/services/identity/types";

export interface IdentityEvaluationCase {
  caseId: string;
  identityGroupId: string;
  category: string;
  sourceSystem: string;
  vendorId: string;
  transformation: string;
  stratum: string;
  quantity: number;
  /** Omit when the case is a known negative / safe-abstention example. */
  truthProductId?: string;
}

export interface IdentityEvaluationDecision {
  caseId: string;
  kind: IdentityDecisionKind;
  targetProductId?: string;
  candidateProductIds: string[];
  latencyMs: number;
}

export interface IdentityAccounting {
  automatic: number;
  review: number;
  abstain: number;
  non_product: number;
  invalid: number;
  input: number;
  exact: boolean;
}

export interface IdentityRate {
  numerator: number;
  denominator: number;
  rate: number;
}

export interface FalseAutomaticRate extends IdentityRate {
  gatePassed: boolean;
}

export interface IdentityLatencyMetrics {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  percentileMethod: "nearest-rank";
}

export interface IdentityMetricSummary {
  rowAccounting: IdentityAccounting;
  quantityAccounting: IdentityAccounting;
  falseAutomatic: FalseAutomaticRate;
  correctAutomaticCoverage: IdentityRate;
  reviewRecallAt3: IdentityRate;
  reviewPrecisionAt3: IdentityRate;
  latency: IdentityLatencyMetrics;
}

export interface BootstrapInterval {
  lower: number;
  upper: number;
  samples: number;
  method: "fixed-seed-group-bootstrap";
}

export interface IdentityMetrics extends IdentityMetricSummary {
  split: Record<string, "train" | "dev" | "locked">;
  confidenceIntervals: Record<"falseAutomatic" | "correctAutomaticCoverage" | "reviewRecallAt3", BootstrapInterval>;
  strata: {
    category: Record<string, IdentityMetricSummary>;
    sourceSystem: Record<string, IdentityMetricSummary>;
    vendorId: Record<string, IdentityMetricSummary>;
    transformation: Record<string, IdentityMetricSummary>;
    stratum: Record<string, IdentityMetricSummary>;
  };
}

export interface EvaluateIdentityOptions {
  bootstrapSeed?: string;
  bootstrapSamples?: number;
  splitSeed?: string;
}

export interface IdentityEvaluationManifest {
  manifestVersion: "identity-manifest-v1";
  syntheticOnly: true;
  promotionEligible: false;
  promotionBlockers: readonly ["synthetic_only", "real_export_evidence_required"];
  splitSeed: string;
  cases: IdentityEvaluationCase[];
}
