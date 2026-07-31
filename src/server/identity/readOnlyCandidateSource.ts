import {
  lookupAllLocalBarcodes,
  lookupAllLocalPartNumbers,
  isCompleteIdentityCandidate,
  isCompleteLocalIdentitySnapshot,
  type LocalIdentitySnapshot,
} from "./localSnapshotIndex";
import type {
  IdentityCandidate,
  IdentityCandidateSource,
  IdentifierType,
  ScopedIdentifier,
} from "@/services/identity/types";

const barcodeIdentifierTypes = new Set(["gtin", "upc", "ean", "barcode"]);

export interface ApprovedLinkLookupInput {
  businessId: string;
  sourceSystem: string;
  sourceSignature: string;
  vendorId: string;
  identifiers: ScopedIdentifier[];
}

export interface ReadOnlyCandidateSourceDependencies {
  snapshot: LocalIdentitySnapshot | undefined;
  /**
   * The injected repository boundary must return only approved links for this exact scope.
   * This source owns neither persistence nor a default/fallback candidate store.
   */
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]>;
}

/** The repository's complete, scoped read model for an approved-link candidate. */
export interface ApprovedLinkLookupResult {
  businessId: string;
  sourceSystem: string;
  sourceSignature: string;
  vendorId: string;
  identifierType: IdentifierType;
  namespace: string;
  normalizedValue: string;
  status: "proposed" | "approved" | "rejected" | "revoked";
  version: number;
  revokedAt?: string;
  targetProductId: string;
  /** Null means the target was deleted or is otherwise no longer available. */
  currentTarget: IdentityCandidate | null;
}

interface MergedIdentityCandidate extends IdentityCandidate {
  /** Additive provenance retained when multiple local entries resolve to one product. */
  sourceEvidence: Array<{
    evidenceId: string;
    evidenceVersion: string;
    verificationTier: IdentityCandidate["verificationTier"];
    exactCodeEvidence: boolean;
    automaticEligible: boolean;
    identifiers: ScopedIdentifier[];
  }>;
}

function identifierKey(identifier: ScopedIdentifier): string {
  return JSON.stringify([identifier.type, identifier.namespace ?? "", identifier.normalized]);
}

function uniqueIdentifiers(identifiers: ScopedIdentifier[]): ScopedIdentifier[] {
  const seen = new Set<string>();
  return identifiers.filter((identifier) => {
    const key = identifierKey(identifier);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function snapshotCandidates(snapshot: LocalIdentitySnapshot, identifiers: ScopedIdentifier[]): IdentityCandidate[] {
  const barcodeKeys = identifiers
    .filter((identifier) => barcodeIdentifierTypes.has(identifier.type))
    .map((identifier) => identifier.normalized);
  const partNumberKeys = identifiers
    .filter((identifier) => identifier.type === "manufacturer_part_number")
    .map((identifier) => identifier.normalized);

  return [
    ...lookupAllLocalBarcodes(snapshot, barcodeKeys),
    ...lookupAllLocalPartNumbers(snapshot, partNumberKeys),
  ];
}

function candidateSortKey(candidate: IdentityCandidate): string {
  return JSON.stringify({
    productId: candidate.productId,
    category: candidate.category,
    businessScope: candidate.businessScope,
    verificationTier: candidate.verificationTier,
    automaticEligible: candidate.automaticEligible,
    evidenceId: candidate.evidenceId,
    evidenceVersion: candidate.evidenceVersion,
    exactCodeEvidence: candidate.exactCodeEvidence,
    identifiers: [...candidate.identifiers].sort((left, right) => identifierKey(left).localeCompare(identifierKey(right))),
    brand: candidate.brand ?? "",
    title: candidate.title ?? "",
    attributes: candidate.attributes,
    catalogVersion: candidate.catalogVersion,
    catalogSnapshotHash: candidate.catalogSnapshotHash,
  });
}

function mergeCandidates(candidates: IdentityCandidate[]): IdentityCandidate[] {
  const grouped = new Map<string, IdentityCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.productId);
    if (group) group.push(candidate);
    else grouped.set(candidate.productId, [candidate]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      const ordered = [...group].sort((left, right) => candidateSortKey(left).localeCompare(candidateSortKey(right)));
      const primary = ordered[0]!;
      const identifiers = ordered.flatMap((candidate) => candidate.identifiers)
        .filter((identifier, index, values) => values.findIndex((other) => identifierKey(other) === identifierKey(identifier)
          && other.evidenceId === identifier.evidenceId && other.evidenceVersion === identifier.evidenceVersion) === index)
        .sort((left, right) => `${identifierKey(left)}\u0000${left.evidenceId}\u0000${left.evidenceVersion}`.localeCompare(`${identifierKey(right)}\u0000${right.evidenceId}\u0000${right.evidenceVersion}`));
      const sourceEvidence = ordered.map((candidate) => ({
        evidenceId: candidate.evidenceId,
        evidenceVersion: candidate.evidenceVersion,
        verificationTier: candidate.verificationTier,
        exactCodeEvidence: candidate.exactCodeEvidence,
        automaticEligible: candidate.automaticEligible,
        identifiers: [...candidate.identifiers].sort((left, right) => identifierKey(left).localeCompare(identifierKey(right))),
      }));
      if (ordered.length === 1) return primary;
      return { ...primary, identifiers, sourceEvidence } satisfies MergedIdentityCandidate;
    });
}

function isValidApprovedLink(
  result: unknown,
  scope: ApprovedLinkLookupInput,
): result is ApprovedLinkLookupResult {
  if (!result || typeof result !== "object") return false;
  const link = result as Partial<ApprovedLinkLookupResult>;
  if (link.businessId !== scope.businessId || link.sourceSystem !== scope.sourceSystem
    || link.sourceSignature !== scope.sourceSignature || link.vendorId !== scope.vendorId
    || link.status !== "approved" || link.revokedAt !== undefined || !Number.isSafeInteger(link.version) || (link.version ?? 0) < 1
    || typeof link.namespace !== "string" || typeof link.normalizedValue !== "string" || !link.normalizedValue
    || !barcodeIdentifierTypes.has(link.identifierType as string) && link.identifierType !== "manufacturer_part_number") return false;
  if (!link.targetProductId || !isCompleteIdentityCandidate(link.currentTarget) || link.currentTarget.productId !== link.targetProductId) return false;
  return scope.identifiers.some((identifier) => identifier.type === link.identifierType
    && (identifier.namespace ?? "") === link.namespace && identifier.normalized === link.normalizedValue);
}

function approvedLinkCandidates(results: unknown[], scope: ApprovedLinkLookupInput): IdentityCandidate[] {
  const valid = results.filter((result): result is ApprovedLinkLookupResult => isValidApprovedLink(result, scope));
  const targetsByIdentifier = new Map<string, Set<string>>();
  for (const link of valid) {
    const key = JSON.stringify([link.identifierType, link.namespace, link.normalizedValue]);
    const targets = targetsByIdentifier.get(key) ?? new Set<string>();
    targets.add(link.targetProductId);
    targetsByIdentifier.set(key, targets);
  }
  if ([...targetsByIdentifier.values()].some((targets) => targets.size > 1)) return [];
  return valid.map((link) => link.currentTarget!);
}

/**
 * Creates the only candidate source used by the local preview: an injected all-hit snapshot plus
 * explicitly scoped approved links. It intentionally has no storage, provider, or network fallback.
 */
export function createReadOnlyCandidateSource(
  dependencies: ReadOnlyCandidateSourceDependencies,
): IdentityCandidateSource {
  if (!isCompleteLocalIdentitySnapshot(dependencies.snapshot)) throw new Error("local_snapshot_unavailable");
  const snapshot = dependencies.snapshot;

  return {
    readonlyOnly: true,
    async lookupBatch(inputs) {
      const results: Array<[string, IdentityCandidate[]]> = await Promise.all(inputs.map(async (input) => {
        const identifiers = uniqueIdentifiers(input.identifiers);
        const scope = {
          businessId: input.businessId,
          sourceSystem: input.sourceSystem,
          sourceSignature: input.sourceSignature,
          vendorId: input.vendorId,
          identifiers,
        };
        const links = approvedLinkCandidates(await dependencies.lookupApprovedLinks(scope), scope);
        return [input.rawRecordFingerprint, mergeCandidates([...snapshotCandidates(snapshot, identifiers), ...links])];
      }));

      return {
        catalogVersion: snapshot.catalogVersion,
        catalogSnapshotHash: snapshot.catalogSnapshotHash,
        candidatesByRecord: new Map(results),
      };
    },
  };
}
