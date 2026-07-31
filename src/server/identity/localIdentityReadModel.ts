import "server-only";

import { isValidApprovedLink, type ApprovedLinkLookupInput, type ApprovedLinkLookupResult } from "./readOnlyCandidateSource";
import { isCompleteLocalIdentitySnapshot, type LocalIdentitySnapshot } from "./localSnapshotIndex";
import type { IdentityCandidate, ScopedIdentifier } from "@/services/identity/types";
import { canonicalSha256 } from "@/services/identity/canonical";

type Scope = Pick<ApprovedLinkLookupInput, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId">;
type SnapshotWire = { catalogVersion: string; catalogSnapshotHash: string; barcodeCandidates: Array<[string, IdentityCandidate[]]>; partNumberCandidates: Array<[string, IdentityCandidate[]]>; approvedLinks: ApprovedLinkLookupResult[] };

export interface LocalIdentityReadModel {
  snapshot: LocalIdentitySnapshot;
  linkSnapshotHash: string;
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]>;
  hasCurrentTarget(input: Scope & { targetProductId: string; identifiers?: ScopedIdentifier[] }): boolean;
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
      return candidates.some((candidate) => candidate.productId === input.targetProductId && (candidate.businessScope === "master" || candidate.tenantBusinessId === input.businessId))
        || wire.approvedLinks.some((link) => isValidApprovedLink(link, scopedLinkInput) && link.targetProductId === input.targetProductId);
    },
  };
}
