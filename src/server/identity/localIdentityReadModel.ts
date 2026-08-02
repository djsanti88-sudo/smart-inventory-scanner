import "server-only";

import { isValidApprovedLink, type ApprovedLinkLookupInput, type ApprovedLinkLookupResult } from "./readOnlyCandidateSource";
import { isCompleteLocalIdentitySnapshot, type LocalIdentitySnapshot } from "./localSnapshotIndex";
import type { IdentityCandidate, ScopedIdentifier, TenantIdentityProduct } from "@/services/identity/types";
import { canonicalSha256 } from "@/services/identity/canonical";
import type { IdentityLinkAfter, IdentityLinkPageRecord, LinkLookup, LocalIdentityRepository } from "./localRepository";

type Scope = Pick<ApprovedLinkLookupInput, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId">;
type SnapshotWire = { catalogVersion: string; catalogSnapshotHash: string; barcodeCandidates: Array<[string, IdentityCandidate[]]>; partNumberCandidates: Array<[string, IdentityCandidate[]]>; approvedLinks: ApprovedLinkLookupResult[] };

export interface LocalIdentityReadModel {
  snapshot: LocalIdentitySnapshot;
  linkSnapshotHash: string;
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]>;
  hasCurrentTarget(input: Scope & { targetProductId: string; identifiers?: ScopedIdentifier[] }): boolean | Promise<boolean>;
  listCurrentApprovedLinks?(businessId: string): Promise<CurrentApprovedIdentityLink[]>;
  pageCurrentApprovedLinks?(businessId: string, input: { pageSize: number; after?: IdentityLinkAfter }): Promise<{ items: CurrentApprovedIdentityLink[]; total: number; nextAfter: IdentityLinkAfter | null }>;
}

export type CurrentApprovedIdentityLink = Pick<ApprovedLinkLookupResult, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId" | "identifierType" | "namespace" | "normalizedValue" | "targetProductId" | "version"> & { predecessorFingerprint: string; predecessorSource: "configured" | "durable" };
function predecessorContent(link: Pick<ApprovedLinkLookupResult, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId" | "identifierType" | "namespace" | "normalizedValue" | "targetProductId" | "version">): unknown { return { businessId: link.businessId, sourceSystem: link.sourceSystem, sourceSignature: link.sourceSignature, vendorId: link.vendorId, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, targetProductId: link.targetProductId, version: link.version }; }
export async function identityLinkPredecessorFingerprint(link: Pick<ApprovedLinkLookupResult, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId" | "identifierType" | "namespace" | "normalizedValue" | "targetProductId" | "version">): Promise<string> { return canonicalSha256(predecessorContent(link)); }

function scopeMatches(left: Scope, right: Scope): boolean { return left.businessId === right.businessId && left.sourceSystem === right.sourceSystem && left.sourceSignature === right.sourceSignature && left.vendorId === right.vendorId; }
function linkFamily(link: Pick<ApprovedLinkLookupResult, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId" | "identifierType" | "namespace" | "normalizedValue">): string { return JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]); }
const configuredLinksSymbol = Symbol("configuredIdentityLinks");
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
  const setHash = (entries: Array<[string, IdentityCandidate[]]>) => {
    const merged = new Map<string, IdentityCandidate[]>();
    for (const [key, candidates] of entries) merged.set(key, [...(merged.get(key) ?? []), ...candidates]);
    return [...merged.entries()].map(([key, candidates]) => [key, candidates
      .map((candidate) => ({ ...candidate, catalogSnapshotHash: hashes.catalogSnapshotHash }))
      .sort((left, right) => left.productId.localeCompare(right.productId) || JSON.stringify(left).localeCompare(JSON.stringify(right)))] as [string, IdentityCandidate[]]);
  };
  const snapshot: LocalIdentitySnapshot = { catalogVersion: wire.catalogVersion, catalogSnapshotHash: hashes.catalogSnapshotHash, barcodeCandidates: new Map(setHash(wire.barcodeCandidates)), partNumberCandidates: new Map(setHash(wire.partNumberCandidates)) };
  if (!isCompleteLocalIdentitySnapshot(snapshot)) return undefined;
  const candidates = allCandidates(snapshot);
  const model: LocalIdentityReadModel = {
    snapshot,
    linkSnapshotHash: hashes.linkSnapshotHash,
    async lookupApprovedLinks(input) { return wire.approvedLinks.filter((link) => scopeMatches(link, input)); },
    async listCurrentApprovedLinks(businessId) {
      const approved = wire.approvedLinks.filter((link) => link.businessId === businessId && link.status === "approved");
      return Promise.all(approved.map(async (link) => ({ businessId: link.businessId, sourceSystem: link.sourceSystem, sourceSignature: link.sourceSignature, vendorId: link.vendorId, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, targetProductId: link.targetProductId, version: link.version, predecessorSource: "configured" as const, predecessorFingerprint: await identityLinkPredecessorFingerprint(link) })));
    },
    hasCurrentTarget(input) {
      const scopedLinkInput = { businessId: input.businessId, sourceSystem: input.sourceSystem, sourceSignature: input.sourceSignature, vendorId: input.vendorId, identifiers: input.identifiers ?? [] };
      const requested = input.identifiers ?? [];
      return candidates.some((candidate) => candidate.productId === input.targetProductId && (candidate.businessScope === "master" || candidate.tenantBusinessId === input.businessId) && (requested.length === 0 || requested.some((key) => candidate.identifiers.some((identifier) => identifier.type === key.type && (identifier.namespace ?? "") === (key.namespace ?? "") && identifier.normalized === key.normalized))))
        || wire.approvedLinks.some((link) => isValidApprovedLink(link, scopedLinkInput) && link.targetProductId === input.targetProductId);
    },
  };
  Object.defineProperty(model, configuredLinksSymbol, { value: wire.approvedLinks, enumerable: false });
  return model;
}

/**
 * The configured master snapshot is immutable, but tenant products/links are durable local state.
 * This joins both before any preview/apply consumer reads them, so the link hash is an actual
 * content version rather than a configuration label.
 */
export async function loadAuthoritativeLocalIdentityReadModel(repository: Pick<LocalIdentityRepository, "findCurrentIdentityLinks" | "listTenantProducts"> & Partial<Pick<LocalIdentityRepository, "listCurrentIdentityLinks" | "pageAuthoritativeIdentityLinks">>): Promise<LocalIdentityReadModel | undefined> {
  const configured = await loadConfiguredLocalIdentityReadModel();
  if (!configured) return undefined;
  const configuredCandidates = allCandidates(configured.snapshot);
  const masterCandidateByProductId = new Map(configuredCandidates.filter((candidate) => candidate.businessScope === "master").map((candidate) => [candidate.productId, candidate]));
  const configuredLinks = (configured as LocalIdentityReadModel & { [configuredLinksSymbol]?: readonly ApprovedLinkLookupResult[] })[configuredLinksSymbol] ?? [];
  const configuredLinksByFamily = new Map<string, ApprovedLinkLookupResult[]>();
  for (const link of configuredLinks) configuredLinksByFamily.set(linkFamily(link), [...(configuredLinksByFamily.get(linkFamily(link)) ?? []), link]);
  // There is no cross-tenant enumeration path. The caller supplies its current tenant through lookup;
  // products are loaded lazily below and cached only for the duration of this model instance.
  type TenantState = { products: readonly TenantIdentityProduct[]; productById: ReadonlyMap<string, TenantIdentityProduct> };
  const tenantStates = new Map<string, Promise<TenantState>>();
  const tenantStateFor = (businessId: string): Promise<TenantState> => {
    const current = tenantStates.get(businessId);
    if (current) return current;
    const loading = repository.listTenantProducts(businessId).then((products) => ({
      products: Object.freeze([...products]),
      productById: new Map(products.map((product) => [product.productId, product])),
    }));
    tenantStates.set(businessId, loading);
    return loading;
  };
  const linksFor = async (input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]> => {
    const { productById } = await tenantStateFor(input.businessId);
    const requested = new Map<string, LinkLookup>();
    for (const identifier of input.identifiers) {
      const lookup: LinkLookup = { businessId: input.businessId, sourceSystem: input.sourceSystem, vendorId: input.vendorId, sourceSignature: input.sourceSignature, identifierType: identifier.type, namespace: identifier.namespace ?? "", normalizedValue: identifier.normalized };
      requested.set(linkFamily(lookup), lookup);
    }
    const durable = (await Promise.all([...requested.values()].reduce<LinkLookup[][]>((chunks, lookup, index) => {
      if (index % 25 === 0) chunks.push([]);
      chunks[chunks.length - 1]!.push(lookup);
      return chunks;
    }, []).map((chunk) => repository.findCurrentIdentityLinks(input.businessId, chunk)))).flat();
    const merged = new Map<string, ApprovedLinkLookupResult>();
    for (const key of requested.keys()) for (const link of configuredLinksByFamily.get(key) ?? []) merged.set(key, link);
    for (const link of durable) {
      const master = masterCandidateByProductId.get(link.targetProductId);
      const product = productById.get(link.targetProductId);
      const target = master ?? (product ? { productId: product.productId, category: "tenant", businessScope: "tenant" as const, tenantBusinessId: product.businessId, verificationTier: "approved" as const, automaticEligible: true, evidenceId: `tenant-product:${product.productId}`, evidenceVersion: product.createdAt, exactCodeEvidence: true, identifiers: [{ type: link.identifierType, raw: link.rawValue, normalized: link.normalizedValue, ...(link.namespace ? { namespace: link.namespace } : {}), source: "tenant-identity-link", evidenceAuthority: "approved_tenant_link" as const, evidenceId: `identity-link:${link.version}`, evidenceVersion: String(link.version) }], title: product.name, attributes: {}, catalogVersion: configured.snapshot.catalogVersion, catalogSnapshotHash: configured.snapshot.catalogSnapshotHash } : null);
      // Current durable state wins for this exact identifier family, including tombstones.
      merged.set(linkFamily(link), { businessId: link.businessId, sourceSystem: link.sourceSystem, sourceSignature: link.sourceSignature, vendorId: link.vendorId, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, status: link.status, version: link.version, evidenceId: `identity-link:${link.version}`, evidenceVersion: String(link.version), automaticEligible: true, targetProductId: link.targetProductId, currentTarget: target });
    }
    return [...merged.values()].filter((link) => link.status === "approved");
  };
  const currentApprovedLinksFor = async (businessId: string): Promise<CurrentApprovedIdentityLink[]> => {
    if (!repository.listCurrentIdentityLinks) return [];
    const [durable, configuredLinks] = await Promise.all([repository.listCurrentIdentityLinks(businessId), configured.listCurrentApprovedLinks ? configured.listCurrentApprovedLinks(businessId) : []]);
    const merged = new Map<string, Omit<CurrentApprovedIdentityLink, "predecessorFingerprint">>(configuredLinks.map((link) => [linkFamily(link), { ...link, predecessorSource: "configured" as const }]));
    for (const link of durable) {
      const key = linkFamily(link);
      if (link.status === "approved") merged.set(key, { businessId: link.businessId, sourceSystem: link.sourceSystem, sourceSignature: link.sourceSignature, vendorId: link.vendorId, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, targetProductId: link.targetProductId, version: link.version, predecessorSource: "durable" as const });
      else merged.delete(key);
    }
    return Promise.all([...merged.values()].map(async (link) => ({ ...link, predecessorFingerprint: await identityLinkPredecessorFingerprint(link) }))).then((links) => links.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  };
  return {
    snapshot: configured.snapshot,
    // The composition folds the current durable link set into this base per authenticated tenant.
    linkSnapshotHash: configured.linkSnapshotHash,
    lookupApprovedLinks: linksFor,
    listCurrentApprovedLinks: currentApprovedLinksFor,
    async pageCurrentApprovedLinks(businessId, input) {
      if (!repository.pageAuthoritativeIdentityLinks) { const all = (await currentApprovedLinksFor(businessId)).sort((left, right) => left.normalizedValue.localeCompare(right.normalizedValue) || linkFamily(left).localeCompare(linkFamily(right))), pageSize = Math.min(25, Math.max(1, input.pageSize)), visible = input.after ? all.filter((link) => link.normalizedValue.localeCompare(input.after!.normalizedValue) > 0 || (link.normalizedValue === input.after!.normalizedValue && linkFamily(link).localeCompare(input.after!.familyKey) > 0)) : all, items = visible.slice(0, pageSize); return { items, total: all.length, nextAfter: visible.length > pageSize ? { normalizedValue: items.at(-1)!.normalizedValue, familyKey: linkFamily(items.at(-1)!) } : null }; }
      const page = await repository.pageAuthoritativeIdentityLinks(businessId, { ...input, configured: configuredLinks as readonly IdentityLinkPageRecord[] });
      return { items: await Promise.all(page.items.map(async (link) => ({ businessId: link.businessId, sourceSystem: link.sourceSystem, sourceSignature: link.sourceSignature, vendorId: link.vendorId, identifierType: link.identifierType, namespace: link.namespace, normalizedValue: link.normalizedValue, targetProductId: link.targetProductId, version: link.version, predecessorSource: link.predecessorSource, predecessorFingerprint: await identityLinkPredecessorFingerprint(link) }))), total: page.total, nextAfter: page.nextAfter };
    },
    async hasCurrentTarget(input) {
      const results = await linksFor({ ...input, identifiers: input.identifiers ?? [] });
      if (results.some((link) => link.status === "approved" && link.targetProductId === input.targetProductId)) return true;
      const requested = input.identifiers ?? [];
      return configuredCandidates.some((candidate) => candidate.productId === input.targetProductId && (candidate.businessScope === "master" || candidate.tenantBusinessId === input.businessId) && (requested.length === 0 || requested.some((key) => candidate.identifiers.some((identifier) => identifier.type === key.type && (identifier.namespace ?? "") === (key.namespace ?? "") && identifier.normalized === key.normalized))));
    },
  };
}

export async function deriveAuthoritativeLinkSnapshotHash(model: Pick<LocalIdentityReadModel, "linkSnapshotHash">, repository: Pick<LocalIdentityRepository, "currentIdentityLinksFingerprint">, businessId: string): Promise<string> {
  const currentDurableLinksFingerprint = await repository.currentIdentityLinksFingerprint(businessId);
  return canonicalSha256({ configuredLinkSnapshotHash: model.linkSnapshotHash, businessId, currentDurableLinksFingerprint });
}
