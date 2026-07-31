import type { EvidenceAuthority, IdentifierType, IdentityCandidate, ScopedIdentifier } from "@/services/identity/types";

/**
 * Immutable, locally injected candidate indexes for identity preview. The adapter deliberately
 * holds every exact-key collision; decisions, not retrieval, decide whether a collision is safe.
 */
export interface LocalIdentitySnapshot {
  catalogVersion: string;
  catalogSnapshotHash: string;
  barcodeCandidates: ReadonlyMap<string, readonly IdentityCandidate[]>;
  partNumberCandidates: ReadonlyMap<string, readonly IdentityCandidate[]>;
}

const identifierTypes = new Set<IdentifierType>([
  "gtin", "upc", "ean", "barcode", "manufacturer_part_number", "vendor_sku", "oem_number", "internal_code", "shelf_code", "source_alias",
]);
const evidenceAuthorities = new Set<EvidenceAuthority>([
  "approved_tenant_link", "human_verified_master", "verified_exact_code_corpus", "vendor_import", "unverified_master", "provider_suggestion",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIdentifier(value: unknown): value is ScopedIdentifier {
  if (!value || typeof value !== "object") return false;
  const identifier = value as Partial<ScopedIdentifier>;
  return identifierTypes.has(identifier.type as IdentifierType)
    && nonEmptyString(identifier.raw)
    && nonEmptyString(identifier.normalized)
    && nonEmptyString(identifier.source)
    && evidenceAuthorities.has(identifier.evidenceAuthority as EvidenceAuthority)
    && nonEmptyString(identifier.evidenceId)
    && nonEmptyString(identifier.evidenceVersion)
    && (identifier.namespace === undefined || typeof identifier.namespace === "string");
}

/** Runtime guard for injected snapshots and current approved-link targets. */
export function isCompleteIdentityCandidate(value: unknown): value is IdentityCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IdentityCandidate>;
  return nonEmptyString(candidate.productId)
    && nonEmptyString(candidate.category)
    && (candidate.businessScope === "tenant" || candidate.businessScope === "master")
    && ["approved", "human_verified", "exact_code_verified", "suggested"].includes(candidate.verificationTier ?? "")
    && typeof candidate.automaticEligible === "boolean"
    && nonEmptyString(candidate.evidenceId)
    && nonEmptyString(candidate.evidenceVersion)
    && typeof candidate.exactCodeEvidence === "boolean"
    && Array.isArray(candidate.identifiers)
    && candidate.identifiers.every(isIdentifier)
    && candidate.attributes !== null
    && typeof candidate.attributes === "object"
    && nonEmptyString(candidate.catalogVersion)
    && nonEmptyString(candidate.catalogSnapshotHash);
}

function indexIsComplete(
  index: unknown,
  identifierTypesForIndex: ReadonlySet<IdentifierType>,
  snapshot: Pick<LocalIdentitySnapshot, "catalogVersion" | "catalogSnapshotHash">,
): index is ReadonlyMap<string, readonly IdentityCandidate[]> {
  if (!(index instanceof Map)) return false;
  for (const [key, candidates] of index) {
    if (!nonEmptyString(key) || !Array.isArray(candidates) || candidates.length === 0) return false;
    for (const candidate of candidates) {
      if (!isCompleteIdentityCandidate(candidate)
        || candidate.catalogVersion !== snapshot.catalogVersion
        || candidate.catalogSnapshotHash !== snapshot.catalogSnapshotHash
        || !candidate.identifiers.some((identifier) => identifierTypesForIndex.has(identifier.type) && identifier.normalized === key)) {
        return false;
      }
    }
  }
  return true;
}

/** Fails closed unless this is a complete, internally consistent all-hit local snapshot. */
export function isCompleteLocalIdentitySnapshot(value: unknown): value is LocalIdentitySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<LocalIdentitySnapshot>;
  if (!nonEmptyString(snapshot.catalogVersion) || !nonEmptyString(snapshot.catalogSnapshotHash)) return false;
  return indexIsComplete(snapshot.barcodeCandidates, new Set(["gtin", "upc", "ean", "barcode"]), snapshot as LocalIdentitySnapshot)
    && indexIsComplete(snapshot.partNumberCandidates, new Set(["manufacturer_part_number"]), snapshot as LocalIdentitySnapshot);
}

function lookupAll(
  index: ReadonlyMap<string, readonly IdentityCandidate[]>,
  keys: readonly string[],
): IdentityCandidate[] {
  const candidates: IdentityCandidate[] = [];
  for (const key of new Set(keys)) {
    const hits = index.get(key);
    if (hits) candidates.push(...hits);
  }
  return candidates;
}

/** Returns every local exact-barcode hit, including collisions. */
export function lookupAllLocalBarcodes(snapshot: LocalIdentitySnapshot, keys: readonly string[]): IdentityCandidate[] {
  return lookupAll(snapshot.barcodeCandidates, keys);
}

/** Returns every local exact-manufacturer-part-number hit, including collisions. */
export function lookupAllLocalPartNumbers(snapshot: LocalIdentitySnapshot, keys: readonly string[]): IdentityCandidate[] {
  return lookupAll(snapshot.partNumberCandidates, keys);
}
