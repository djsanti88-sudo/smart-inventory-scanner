import "server-only";

import { createIdentityPreview, type CreateIdentityPreviewInput, type PreviewVersions } from "@/services/identity/preview";
import type { LocalIdentitySnapshot } from "./localSnapshotIndex";
import { createReadOnlyCandidateSource, type ApprovedLinkLookupInput, type ApprovedLinkLookupResult } from "./readOnlyCandidateSource";
import { createLocalPreviewSigner } from "./previewSigner";

export type IdentityPreviewRole = "owner" | "admin" | "counter" | "viewer";
export interface IdentityPreviewActor { actorId: string; role: IdentityPreviewRole; }
export interface LocalIdentityPreviewComposition {
  snapshot: LocalIdentitySnapshot | undefined;
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]>;
  authenticate(request: Request, businessId: string): Promise<IdentityPreviewActor | undefined>;
  signingKey: () => string | undefined;
  versions: PreviewVersions;
}

let localComposition: LocalIdentityPreviewComposition | undefined;

/** Explicit local/mock injection only. There is no storage, catalog, provider, or network fallback. */
export function setLocalIdentityPreviewCompositionForTest(value: LocalIdentityPreviewComposition | undefined): void {
  localComposition = value;
}

export async function authorizeLocalIdentityPreview(request: Request, businessId: string): Promise<IdentityPreviewActor | undefined> {
  return localComposition?.authenticate(request, businessId);
}

export async function createComposedIdentityPreview(input: CreateIdentityPreviewInput, actor: IdentityPreviewActor): Promise<unknown> {
  if (!localComposition) throw new Error("local_snapshot_unavailable");
  const source = createReadOnlyCandidateSource({ snapshot: localComposition.snapshot, lookupApprovedLinks: localComposition.lookupApprovedLinks });
  const signer = await createLocalPreviewSigner(localComposition.signingKey());
  return createIdentityPreview({ ...input, actorId: actor.actorId, versions: localComposition.versions }, { source, signer });
}
