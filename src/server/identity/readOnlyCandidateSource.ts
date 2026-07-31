import {
  lookupAllLocalBarcodes,
  lookupAllLocalPartNumbers,
  type LocalIdentitySnapshot,
} from "./localSnapshotIndex";
import type {
  IdentityCandidate,
  IdentityCandidateSource,
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
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<IdentityCandidate[]>;
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

/**
 * Creates the only candidate source used by the local preview: an injected all-hit snapshot plus
 * explicitly scoped approved links. It intentionally has no storage, provider, or network fallback.
 */
export function createReadOnlyCandidateSource(
  dependencies: ReadOnlyCandidateSourceDependencies,
): IdentityCandidateSource {
  if (!dependencies.snapshot) throw new Error("local_snapshot_unavailable");
  const snapshot = dependencies.snapshot;

  return {
    readonlyOnly: true,
    async lookupBatch(inputs) {
      const results: Array<[string, IdentityCandidate[]]> = await Promise.all(inputs.map(async (input) => {
        const identifiers = uniqueIdentifiers(input.identifiers);
        const links = await dependencies.lookupApprovedLinks({
          businessId: input.businessId,
          sourceSystem: input.sourceSystem,
          sourceSignature: input.sourceSignature,
          vendorId: input.vendorId,
          identifiers,
        });
        return [input.rawRecordFingerprint, [...snapshotCandidates(snapshot, identifiers), ...links]];
      }));

      return {
        catalogVersion: snapshot.catalogVersion,
        catalogSnapshotHash: snapshot.catalogSnapshotHash,
        candidatesByRecord: new Map(results),
      };
    },
  };
}
