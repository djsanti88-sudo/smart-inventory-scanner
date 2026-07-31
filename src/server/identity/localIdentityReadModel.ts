import "server-only";

import type { ApprovedLinkLookupInput, ApprovedLinkLookupResult } from "./readOnlyCandidateSource";
import { isCompleteLocalIdentitySnapshot, type LocalIdentitySnapshot } from "./localSnapshotIndex";
import type { IdentityCandidate } from "@/services/identity/types";

type Scope = Pick<ApprovedLinkLookupInput, "businessId" | "sourceSystem" | "sourceSignature" | "vendorId">;
type SnapshotWire = { catalogVersion: string; catalogSnapshotHash: string; barcodeCandidates: Array<[string, IdentityCandidate[]]>; partNumberCandidates: Array<[string, IdentityCandidate[]]>; approvedLinks: ApprovedLinkLookupResult[] };

export interface LocalIdentityReadModel {
  snapshot: LocalIdentitySnapshot;
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]>;
  hasCurrentTarget(input: Scope & { targetProductId: string }): boolean;
}

function scopeMatches(left: Scope, right: Scope): boolean { return left.businessId === right.businessId && left.sourceSystem === right.sourceSystem && left.sourceSignature === right.sourceSignature && left.vendorId === right.vendorId; }
function allCandidates(snapshot: LocalIdentitySnapshot): IdentityCandidate[] { return [...snapshot.barcodeCandidates.values(), ...snapshot.partNumberCandidates.values()].flatMap((rows) => [...rows]); }

/** Strict server-only env loader. It never performs remote retrieval or accepts caller-selected IDs. */
export function loadConfiguredLocalIdentityReadModel(): LocalIdentityReadModel | undefined {
  const raw = process.env.IDENTITY_LOCAL_SNAPSHOT_JSON;
  if (!raw || raw.length > 512 * 1024) return undefined;
  let wire: SnapshotWire;
  try { wire = JSON.parse(raw) as SnapshotWire; } catch { return undefined; }
  if (!wire || typeof wire !== "object" || !Array.isArray(wire.barcodeCandidates) || !Array.isArray(wire.partNumberCandidates) || !Array.isArray(wire.approvedLinks)) return undefined;
  const snapshot: LocalIdentitySnapshot = { catalogVersion: wire.catalogVersion, catalogSnapshotHash: wire.catalogSnapshotHash, barcodeCandidates: new Map(wire.barcodeCandidates), partNumberCandidates: new Map(wire.partNumberCandidates) };
  if (!isCompleteLocalIdentitySnapshot(snapshot)) return undefined;
  const candidates = allCandidates(snapshot);
  return {
    snapshot,
    async lookupApprovedLinks(input) { return wire.approvedLinks.filter((link) => scopeMatches(link, input)); },
    hasCurrentTarget(input) { return candidates.some((candidate) => candidate.productId === input.targetProductId && (candidate.businessScope === "master" || candidate.businessScope === "tenant")); },
  };
}
