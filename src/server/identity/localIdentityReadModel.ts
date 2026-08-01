import "server-only";

import { isValidApprovedLink, type ApprovedLinkLookupInput, type ApprovedLinkLookupResult } from "./readOnlyCandidateSource";
import { isCompleteLocalIdentitySnapshot, type LocalIdentitySnapshot } from "./localSnapshotIndex";
import type { IdentityCandidate, ScopedIdentifier } from "@/services/identity/types";
import { canonicalSha256 } from "@/services/identity/canonical";
import type { LocalIdentityRepository } from "./localRepository";

type Scope = Pick<ApprovedLinkLookupInput, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId">;
type SnapshotWire = { catalogVersion: string; catalogSnapshotHash: string; barcodeCandidates: Array<[string, IdentityCandidate[]]>; partNumberCandidates: Array<[string, IdentityCandidate[]]>; approvedLinks: ApprovedLinkLookupResult[] };

export interface LocalIdentityReadModel {
  snapshot: LocalIdentitySnapshot;
  linkSnapshotHash: string;
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]>;
  hasCurrentTarget(input: Scope & { targetProductId: string; identifiers?: ScopedIdentifier[] }): boolean | Promise<boolean>;
}

function scopeMatches(left: Scope, right: Scope): boolean { return left.businessId === right.businessId && left.sourceSystem === right.sourceSystem && left.sourceSignature === right.sourceSignature && left.vendorId === right.vendorId; }
function allCandidates(snapshot: LocalIdentitySnapshot): IdentityCandidate[] { return [...snapshot.barcodeCandidates.values(), ...snapshot.partNumberCandidates.values()].flatMap((rows) => [...rows]); }
function content(entries: Array<[string, IdentityCandidate[]]>): unknown[] { return entries.map(([key, candidates]) => [key, candidates.map((candidate) => Object.fromEntries(Object.entries(candidate).filter(([property]) => property !== "catalogSnapshotHash"))).sort((a, b) => a.productId.localeCompare(b.productId))]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))); }
export async function deriveConfiguredSnapshotHashes(wire: { catalogVersion: string; barcodeCandidates: unknown; partNumberCandidates: unknown; approvedLinks: unknown }): Promise<{ catalogSnapshotHash: string; linkSnapshotHash: string }> {
  const barcodeCandidates = Array.isArray(wire.barcodeCandidates) ? wire.barcodeCandidates as Array<[string, IdentityCandidate[]]> : [];
  const partNumberCandidates = Array.isArray(wire.partNumberCandidates) ? wire.partNumberCandidates as Array<[string, IdentityCandidate[]]> : [];
  const approvedLinks = Array.isArray(wire.approvedLinks) ? wire.approvedLinks : [];
  return { catalogSnapshotHash: await canonicalSha256({ catalogVersion: wire.catalogVersion, barcodeCandidates: content(barcodeCandidates), partNumberCandidates: content(partNumberCandidates) }), linkSnapshotHash: await canonicalSha256({ approvedLinks: [...approvedLinks].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }) };
}

/** Strict server-only env loader. It never performs remote retrieval or accepts caller-selected IDs. */
export async function loadConfiguredLocalIdentityReadModel(): Promise<LocalIdentityReadModel | undefined> {
  const raw = process.env.IDENTITY_LOCAL_SNAPSHOT_JSON;
  if (!raw || raw.length > 512 * 1024) return undefined;
  let wire: SnapshotWire;
  try { wire = JSON.parse(raw) as SnapshotWire; } catch { return undefined; }
  if (!wire || typeof wire !== "object" || !Array.isArray(wire.barcodeCandidates) || !Array.isArray(wire.partNumberCandidates) || !Array.isArray(wire.approvedLinks)) return undefined;
  const hashes = await deriveConfiguredSnapshotHashes(wire);
  if (wire.catalogSnapshotHash !== hashes.catalogSnapshotHash) return undefined;
  const setHash = (entries: Array<[string, IdentityCandidate[]]>) => entries.map(([key, candidates]) => [key, candidates.map((candidate) => ({ ...candidate, catalogSnapshotHash: hashes.catalogSnapshotHash }))] as [string, IdentityCandidate[]]);
  const snapshot: LocalIdentitySnapshot = { catalogVersion: wire.catalogVersion, catalogSnapshotHash: hashes.catalogSnapshotHash, barcodeCandidates: new Map(setHash(wire.barcodeCandidates)), partNumberCandidates: new Map(setHash(wire.partNumberCandidates)) };
  if (!isCompleteLocalIdentitySnapshot(snapshot)) return undefined;
  const candidates = allCandidates(snapshot);
  return {
    snapshot,
    linkSnapshotHash: hashes.linkSnapshotHash,
    async lookupApprovedLinks(input) { return wire.approvedLinks.filter((link) => scopeMatches(link, input)); },
    hasCurrentTarget(input) {
      const scopedLinkInput = { businessId: input.businessId, sourceSystem: input.sourceSystem, sourceSignature: input.sourceSignature, vendorId: input.vendorId, identifiers: input.identifiers ?? [] };
      const requested = input.identifiers ?? [];
      return candidates.some((candidate) => candidate.productId === input.targetProductId && (candidate.businessScope === "master" || candidate.tenantBusinessId === input.businessId) && (requested.length === 0 || requested.some((key) => candidate.identifiers.some((identifier) => identifier.type === key.type && (identifier.namespace ?? "") === (key.namespace ?? "") && identifier.normalized === key.normalized))))
        || wire.approvedLinks.some((link) => isValidApprovedLink(link, scopedLinkInput) && link.targetProductId === input.targetProductId);
    },
  };
}

/**
 * The configured master snapshot is immutable, but tenant products/links are durable local state.
 * This joins both before any preview/apply consumer reads them, so the link hash is an actual
 * content version rather than a configuration label.
 */
export async function loadAuthoritativeLocalIdentityReadModel(repository: Pick<LocalIdentityRepository, "listCurrentIdentityLinks" | "listTenantProducts">): Promise<LocalIdentityReadModel | undefined> {
  const configured = await loadConfiguredLocalIdentityReadModel();
  if (!configured) return undefined;
  const configuredCandidates = allCandidates(configured.snapshot);
  // There is no cross-tenant enumeration path. The caller supplies its current tenant through lookup;
  // products are loaded lazily below and cached only for the duration of this model instance.
  const linksFor = async (input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]> => {
    const [durable, products] = await Promise.all([repository.listCurrentIdentityLinks(input.businessId), repository.listTenantProducts(input.businessId)]);
    const productById = new Map(products.map((product) => [product.productId, product]));
    const current = durable.filter((link) => scopeMatches(link, input));
    const configuredLinks = await configured.lookupApprovedLinks(input);
    return [...configuredLinks, ...current.map((link): ApprovedLinkLookupResult => {
      const master = configuredCandidates.find((candidate) => candidate.productId === link.targetProductId && candidate.businessScope === "master");
      const product = productById.get(link.targetProductId);
      const target = master ?? (product ? { productId: product.productId, category: "tenant", businessScope: "tenant" as const, tenantBusinessId: product.businessId, verificationTier: "approved" as const, automaticEligible: true, evidenceId: `tenant-product:${product.productId}`, evidenceVersion: product.createdAt, exactCodeEvidence: true, identifiers: [{ type: link.identifierType, raw: link.rawValue, normalized: link.normalizedValue, ...(link.namespace ? { namespace: link.namespace } : {}), source: "tenant-identity-link", evidenceAuthority: "approved_tenant_link" as const, evidenceId: `identity-link:${link.version}`, evidenceVersion: String(link.version) }], title: product.name, attributes: {}, catalogVersion: configured.snapshot.catalogVersion, catalogSnapshotHash: configured.snapshot.catalogSnapshotHash } : null);
      return { businessId: link.businessId, sourceSystem: link.sourceSystem, sourceSignature: link.sourceSignature, vendorId: link.vendorId, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, status: link.status, version: link.version, evidenceId: `identity-link:${link.version}`, evidenceVersion: String(link.version), automaticEligible: true, targetProductId: link.targetProductId, currentTarget: target };
    })];
  };
  return {
    snapshot: configured.snapshot,
    // The composition folds the current durable link set into this base per authenticated tenant.
    linkSnapshotHash: configured.linkSnapshotHash,
    lookupApprovedLinks: linksFor,
    async hasCurrentTarget(input) {
      if (configured.hasCurrentTarget(input)) return true;
      const results = await linksFor({ ...input, identifiers: input.identifiers ?? [] });
      return results.some((link) => link.status === "approved" && link.targetProductId === input.targetProductId);
    },
  };
}

export async function deriveAuthoritativeLinkSnapshotHash(model: Pick<LocalIdentityReadModel, "linkSnapshotHash">, repository: Pick<LocalIdentityRepository, "listCurrentIdentityLinks">, businessId: string): Promise<string> {
  const durable = await repository.listCurrentIdentityLinks(businessId);
  return canonicalSha256({ configuredLinkSnapshotHash: model.linkSnapshotHash, businessId, currentDurableLinks: durable.map((link) => ({ businessId: link.businessId, sourceSystem: link.sourceSystem, vendorId: link.vendorId, sourceSignature: link.sourceSignature, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, targetProductId: link.targetProductId, status: link.status, version: link.version })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}
