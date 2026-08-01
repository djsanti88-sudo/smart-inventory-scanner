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
  evidenceId: string;
  evidenceVersion: string;
  automaticEligible: boolean;
  revokedAt?: string;
  targetProductId: string;
  /** Null means the target was deleted or is otherwise no longer available. */
  currentTarget: IdentityCandidate | null;
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

function snapshotCandidates(snapshot: LocalIdentitySnapshot, identifiers: ScopedIdentifier[], businessId: string): IdentityCandidate[] {
  const barcodeKeys = identifiers
    .filter((identifier) => barcodeIdentifierTypes.has(identifier.type))
    .map((identifier) => identifier.normalized);
  const partNumberKeys = identifiers
    .filter((identifier) => identifier.type === "manufacturer_part_number")
    .map((identifier) => identifier.normalized);

  return [
    ...lookupAllLocalBarcodes(snapshot, barcodeKeys),
    ...lookupAllLocalPartNumbers(snapshot, partNumberKeys),
  ].filter((candidate) => candidate.businessScope === "master" || candidate.tenantBusinessId === businessId);
}

function candidateSortKey(candidate: IdentityCandidate): string {
  return JSON.stringify({
    productId: candidate.productId,
    category: candidate.category,
    businessScope: candidate.businessScope,
    tenantBusinessId: candidate.tenantBusinessId ?? "",
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

/**
 * Evidence records remain atomic: ordering/deduplication can remove only an identical record,
 * never combine an eligible flag from one record with an immutable identifier from another.
 */
function orderAtomicCandidates(candidates: IdentityCandidate[]): IdentityCandidate[] {
  const ordered = [...candidates].sort((left, right) => {
    const product = left.productId.localeCompare(right.productId);
    return product || candidateSortKey(left).localeCompare(candidateSortKey(right));
  });
  return ordered.filter((candidate, index) => index === 0
    || candidateSortKey(candidate) !== candidateSortKey(ordered[index - 1]!));
}

export function isValidApprovedLink(
  result: unknown,
  scope: ApprovedLinkLookupInput,
): result is ApprovedLinkLookupResult {
  if (!result || typeof result !== "object") return false;
  const link = result as Partial<ApprovedLinkLookupResult>;
  if (link.businessId !== scope.businessId || link.sourceSystem !== scope.sourceSystem
    || link.sourceSignature !== scope.sourceSignature || link.vendorId !== scope.vendorId
    || link.status !== "approved" || link.revokedAt !== undefined || !Number.isSafeInteger(link.version) || (link.version ?? 0) < 1
    || typeof link.evidenceId !== "string" || !link.evidenceId || typeof link.evidenceVersion !== "string" || !link.evidenceVersion
    || typeof link.automaticEligible !== "boolean" || typeof link.namespace !== "string" || typeof link.normalizedValue !== "string" || !link.normalizedValue
    || !barcodeIdentifierTypes.has(link.identifierType as string) && link.identifierType !== "manufacturer_part_number") return false;
  if (!link.targetProductId || !isCompleteIdentityCandidate(link.currentTarget) || link.currentTarget.productId !== link.targetProductId) return false;
  if (link.currentTarget.businessScope !== "master"
    && (link.currentTarget.businessScope !== "tenant" || link.currentTarget.tenantBusinessId !== scope.businessId)) return false;
  return scope.identifiers.some((identifier) => identifier.type === link.identifierType
    && (identifier.namespace ?? "") === link.namespace && identifier.normalized === link.normalizedValue);
}

function approvedLinkCandidates(
  results: unknown[],
  scope: ApprovedLinkLookupInput,
  snapshot: LocalIdentitySnapshot,
): IdentityCandidate[] {
  const valid = results.filter((result): result is ApprovedLinkLookupResult => isValidApprovedLink(result, scope));
  const targetsByIdentifier = new Map<string, Set<string>>();
  for (const link of valid) {
    const key = JSON.stringify([link.identifierType, link.namespace, link.normalizedValue]);
    const targets = targetsByIdentifier.get(key) ?? new Set<string>();
    targets.add(link.targetProductId);
    targetsByIdentifier.set(key, targets);
  }
  if ([...targetsByIdentifier.values()].some((targets) => targets.size > 1)) return [];
  return valid.map((link) => {
    const matchedIdentifier = scope.identifiers.find((identifier) => identifier.type === link.identifierType
      && (identifier.namespace ?? "") === link.namespace && identifier.normalized === link.normalizedValue)!;
    const target = link.currentTarget!;
    return {
      ...target,
      businessScope: "tenant",
      verificationTier: "approved",
      automaticEligible: link.automaticEligible,
      evidenceId: link.evidenceId,
      evidenceVersion: link.evidenceVersion,
      exactCodeEvidence: true,
      identifiers: [{
        type: link.identifierType,
        raw: matchedIdentifier.raw,
        normalized: matchedIdentifier.normalized,
        ...(link.namespace ? { namespace: link.namespace } : {}),
        source: "approved-tenant-link",
        evidenceAuthority: "approved_tenant_link",
        evidenceId: link.evidenceId,
        evidenceVersion: link.evidenceVersion,
      }],
      catalogVersion: snapshot.catalogVersion,
      catalogSnapshotHash: snapshot.catalogSnapshotHash,
    };
  });
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
        const links = approvedLinkCandidates(await dependencies.lookupApprovedLinks(scope), scope, snapshot);
        return [input.rawRecordFingerprint, orderAtomicCandidates([...snapshotCandidates(snapshot, identifiers, input.businessId), ...links])];
      }));

      return {
        catalogVersion: snapshot.catalogVersion,
        catalogSnapshotHash: snapshot.catalogSnapshotHash,
        candidatesByRecord: new Map(results),
      };
    },
  };
}
