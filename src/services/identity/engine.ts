import { canonicalSha256, validateIdentityInput } from "./canonical";
import { genericIdentityPlugin, pluginFor, type IdentityCategoryPlugin } from "./plugins";
import type {
  EvidenceAuthority,
  IdentityCandidate,
  IdentityCandidateSource,
  IdentityDecision,
  IdentityInput,
  ScopedIdentifier,
} from "./types";

export interface IdentityCandidateSnapshot {
  catalogVersion: string;
  catalogSnapshotHash: string;
  candidates: IdentityCandidate[];
}

const engineVersion = "identity-engine-v1";
const nonProductCategories = new Set(["labor", "service", "fee", "subtotal", "header"]);
const immutableAuthorities = new Set<EvidenceAuthority>([
  "approved_tenant_link",
  "human_verified_master",
  "verified_exact_code_corpus",
]);

interface CandidateGroup {
  productId: string;
  candidates: IdentityCandidate[];
  exactImmutable: boolean;
  semanticScore: number;
  evidence: string[];
  missing: string[];
  qualifyingEvidence?: ImmutableEvidence;
}

interface ImmutableEvidence {
  candidateEvidenceId: string;
  candidateEvidenceVersion: string;
  identifierEvidenceId: string;
  identifierEvidenceVersion: string;
}

function normalizedCategory(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function identifierKey(identifier: Pick<ScopedIdentifier, "type" | "namespace" | "normalized">): string {
  return JSON.stringify([identifier.type, identifier.namespace ?? "", identifier.normalized]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function evidenceKey(evidence: ImmutableEvidence): string {
  return [
    evidence.candidateEvidenceId,
    evidence.candidateEvidenceVersion,
    evidence.identifierEvidenceId,
    evidence.identifierEvidenceVersion,
  ].join("\u0000");
}

function immutableExactEvidence(input: IdentityInput, candidate: IdentityCandidate): ImmutableEvidence | undefined {
  if (!candidate.automaticEligible || !candidate.exactCodeEvidence) return undefined;
  if (
    candidate.verificationTier !== "approved" &&
    candidate.verificationTier !== "human_verified" &&
    candidate.verificationTier !== "exact_code_verified"
  ) {
    return undefined;
  }
  const inputKeys = new Set(input.identifiers.map(identifierKey));
  return candidate.identifiers
    .filter((identifier) => inputKeys.has(identifierKey(identifier)) && immutableAuthorities.has(identifier.evidenceAuthority))
    .map((identifier) => ({
      candidateEvidenceId: candidate.evidenceId,
      candidateEvidenceVersion: candidate.evidenceVersion,
      identifierEvidenceId: identifier.evidenceId,
      identifierEvidenceVersion: identifier.evidenceVersion,
    }))
    .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)))[0];
}

function compareGroups(left: CandidateGroup, right: CandidateGroup): number {
  if (left.exactImmutable !== right.exactImmutable) return left.exactImmutable ? -1 : 1;
  if (left.semanticScore !== right.semanticScore) return right.semanticScore - left.semanticScore;
  return left.productId.localeCompare(right.productId);
}

function initialDecision(input: IdentityInput, snapshot: IdentityCandidateSnapshot, plugin: IdentityCategoryPlugin): Omit<
  IdentityDecision,
  "kind" | "targetProductId" | "selectedCandidateId" | "candidates" | "decisionBasis" | "constraintOutcomes" | "decisionFingerprint"
> {
  return {
    normalizedKeys: input.identifiers.map((identifier) => ({
      type: identifier.type,
      ...(identifier.namespace ? { namespace: identifier.namespace } : {}),
      value: identifier.normalized,
    })),
    candidateSnapshotHash: snapshot.catalogSnapshotHash,
    engineVersion,
    pluginVersion: plugin.version,
    sourceRecordFingerprint: input.rawRecordFingerprint,
  };
}

function sourceRecordFingerprint(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { rawRecordFingerprint?: unknown }).rawRecordFingerprint === "string") {
    return (input as { rawRecordFingerprint: string }).rawRecordFingerprint;
  }
  return "";
}

function invalidDecisionMetadata(
  input: unknown,
  snapshot: IdentityCandidateSnapshot,
  plugin: IdentityCategoryPlugin,
): Omit<IdentityDecision, "kind" | "targetProductId" | "selectedCandidateId" | "candidates" | "decisionBasis" | "constraintOutcomes" | "decisionFingerprint"> {
  return {
    normalizedKeys: [],
    candidateSnapshotHash: snapshot.catalogSnapshotHash,
    engineVersion,
    pluginVersion: plugin.version,
    sourceRecordFingerprint: sourceRecordFingerprint(input),
  };
}

/** The canonical, undefined-free projection used for every decision fingerprint. */
export function identityDecisionFingerprintProjection(
  decision: Omit<IdentityDecision, "decisionFingerprint"> | IdentityDecision,
): Record<string, unknown> {
  return {
    kind: decision.kind,
    ...(decision.targetProductId ? { targetProductId: decision.targetProductId } : {}),
    candidates: decision.candidates,
    ...(decision.selectedCandidateId ? { selectedCandidateId: decision.selectedCandidateId } : {}),
    decisionBasis: decision.decisionBasis,
    normalizedKeys: decision.normalizedKeys,
    constraintOutcomes: decision.constraintOutcomes,
    candidateSnapshotHash: decision.candidateSnapshotHash,
    engineVersion: decision.engineVersion,
    pluginVersion: decision.pluginVersion,
    sourceRecordFingerprint: decision.sourceRecordFingerprint,
  };
}

async function finalize(
  base: Omit<IdentityDecision, "decisionFingerprint">,
): Promise<IdentityDecision> {
  return {
    ...base,
    decisionFingerprint: await canonicalSha256(identityDecisionFingerprintProjection(base)),
  };
}

function terminal(
  input: IdentityInput,
  snapshot: IdentityCandidateSnapshot,
  plugin: IdentityCategoryPlugin,
  kind: "invalid" | "non_product" | "abstain",
  rule: string,
  evidenceId: string,
): Promise<IdentityDecision> {
  return finalize({
    ...initialDecision(input, snapshot, plugin),
    kind,
    candidates: [],
    decisionBasis: [{ rule, evidenceId, evidenceVersion: engineVersion }],
    constraintOutcomes: [],
  });
}

function invalidTerminal(
  input: unknown,
  snapshot: IdentityCandidateSnapshot,
  plugin: IdentityCategoryPlugin,
  errors: string[],
): Promise<IdentityDecision> {
  return finalize({
    ...invalidDecisionMetadata(input, snapshot, plugin),
    kind: "invalid",
    candidates: [],
    decisionBasis: [{ rule: "input_validation", evidenceId: errors.join("|"), evidenceVersion: engineVersion }],
    constraintOutcomes: [],
  });
}

/** Makes a pure, replayable identity decision from a previously read candidate snapshot. */
export async function decideIdentity(
  input: unknown,
  snapshot: IdentityCandidateSnapshot,
  plugin: IdentityCategoryPlugin,
): Promise<IdentityDecision> {
  const errors = validateIdentityInput(input);
  if (errors.length > 0) return invalidTerminal(input, snapshot, plugin, errors);

  const normalized = plugin.normalize(input as IdentityInput);
  if (normalized.recordType && normalized.recordType !== "product" && nonProductCategories.has(normalized.recordType)) {
    return terminal(normalized, snapshot, plugin, "non_product", "explicit_adapter_record_type", normalized.recordType);
  }
  const category = normalizedCategory(normalized.categoryHint);
  if (nonProductCategories.has(category)) return terminal(normalized, snapshot, plugin, "non_product", "allowlisted_category", category);

  const constraintOutcomes: IdentityDecision["constraintOutcomes"] = [];
  const viable = new Map<string, CandidateGroup>();
  const rejectedProductIds = new Set<string>();

  for (const candidate of snapshot.candidates) {
    const constraint = plugin.hardConstraints(normalized, candidate);
    constraintOutcomes.push({ candidateId: candidate.productId, result: constraint });
    if (constraint.outcome === "reject") {
      rejectedProductIds.add(candidate.productId);
      continue;
    }

    const semantic = plugin.semanticFeatures(normalized, candidate);
    const existing = viable.get(candidate.productId) ?? {
      productId: candidate.productId,
      candidates: [],
      exactImmutable: false,
      semanticScore: 0,
      evidence: [],
      missing: [],
    };
    existing.candidates.push(candidate);
    const immutableEvidence = immutableExactEvidence(normalized, candidate);
    existing.exactImmutable ||= Boolean(immutableEvidence);
    if (immutableEvidence && (!existing.qualifyingEvidence || evidenceKey(immutableEvidence) < evidenceKey(existing.qualifyingEvidence))) {
      existing.qualifyingEvidence = immutableEvidence;
    }
    existing.semanticScore = Math.max(existing.semanticScore, semantic.score);
    existing.evidence.push(candidate.evidenceId, ...candidate.identifiers.map((identifier) => identifier.evidenceId));
    existing.missing.push(...constraint.missing);
    viable.set(candidate.productId, existing);
  }

  for (const productId of rejectedProductIds) viable.delete(productId);
  const groups = [...viable.values()].sort(compareGroups);
  const orderedOutcomes = constraintOutcomes.sort((left, right) => {
    const byProduct = left.candidateId.localeCompare(right.candidateId);
    if (byProduct !== 0) return byProduct;
    return JSON.stringify(left.result).localeCompare(JSON.stringify(right.result));
  });
  if (groups.length === 0) {
    const hasRejection = orderedOutcomes.some((outcome) => outcome.result.outcome === "reject");
    return finalize({
      ...initialDecision(normalized, snapshot, plugin),
      kind: "abstain",
      candidates: [],
      decisionBasis: [
        {
          rule: hasRejection ? "all_candidates_contradicted" : "no_viable_candidate",
          evidenceId: snapshot.catalogSnapshotHash,
          evidenceVersion: snapshot.catalogVersion,
        },
      ],
      constraintOutcomes: orderedOutcomes,
    });
  }

  const candidates = groups.map((group, index) => ({
    productId: group.productId,
    rank: index + 1,
    score: group.semanticScore,
    evidence: uniqueSorted(group.evidence),
    missingFields: uniqueSorted(group.missing),
    contradictions: [],
  }));
  const automatic = groups.length === 1 && groups[0]?.exactImmutable;
  const selected = groups[0]!;
  return finalize({
    ...initialDecision(normalized, snapshot, plugin),
    kind: automatic ? "automatic" : "review",
    ...(automatic ? { targetProductId: selected.productId, selectedCandidateId: selected.productId } : {}),
    candidates,
    decisionBasis: automatic
      ? [
          {
            rule: "unique_immutable_exact_evidence",
            evidenceId: selected.qualifyingEvidence!.candidateEvidenceId,
            evidenceVersion: selected.qualifyingEvidence!.candidateEvidenceVersion,
          },
        ]
      : [{ rule: "review_ranked_candidates", evidenceId: snapshot.catalogSnapshotHash, evidenceVersion: snapshot.catalogVersion }],
    constraintOutcomes: orderedOutcomes,
  });
}

/** Reads all candidates once, then applies the pure engine in the caller's input order. */
export async function decideIdentityBatch(
  inputs: unknown[],
  source: IdentityCandidateSource,
): Promise<IdentityDecision[]> {
  const validInputs = inputs.filter((input): input is IdentityInput => validateIdentityInput(input).length === 0);
  const lookup = await source.lookupBatch(validInputs);
  return Promise.all(
    inputs.map((input) => {
      const plugin = validateIdentityInput(input).length === 0 ? pluginFor(input as IdentityInput) : genericIdentityPlugin;
      return decideIdentity(
        input,
        {
          catalogVersion: lookup.catalogVersion,
          catalogSnapshotHash: lookup.catalogSnapshotHash,
          candidates: lookup.candidatesByRecord.get(sourceRecordFingerprint(input)) ?? [],
        },
        plugin,
      );
    }),
  );
}
