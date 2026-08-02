import "server-only";

import { createIdentityPreview, type CreateIdentityPreviewInput, type PreviewVersions } from "@/services/identity/preview";
import { identityPluginVersions } from "@/services/identity/plugins";
import type { LocalIdentitySnapshot } from "./localSnapshotIndex";
import { createReadOnlyCandidateSource, type ApprovedLinkLookupInput, type ApprovedLinkLookupResult } from "./readOnlyCandidateSource";
import { createLocalPreviewSigner } from "./previewSigner";
import { loadAuthoritativeLocalIdentityReadModel, deriveAuthoritativeLinkSnapshotHash } from "./localIdentityReadModel";
import { createFileAtomicLocalStorage } from "./atomicLocalStorage";
import { createLocalRepository } from "./localRepository";
import { localIdentityStorageRoot } from "./applyComposition";

export type IdentityPreviewRole = "owner" | "admin" | "counter" | "viewer";
export interface IdentityPreviewActor { actorId: string; role: IdentityPreviewRole; }
export interface LocalIdentityPreviewComposition {
  snapshot: LocalIdentitySnapshot | undefined;
  lookupApprovedLinks(input: ApprovedLinkLookupInput): Promise<ApprovedLinkLookupResult[]>;
  authenticate(request: Request, businessId: string): Promise<IdentityPreviewActor | undefined>;
  signingKey: () => string | undefined;
  versions: PreviewVersions;
  now?: () => Date;
}

let localComposition: LocalIdentityPreviewComposition | undefined;

const localRoles = new Set<IdentityPreviewRole>(["owner", "admin", "counter", "viewer"]);

interface LocalPreviewMembership { actorId: string; businessId: string; role: IdentityPreviewRole; }

function configuredMemberships(): LocalPreviewMembership[] | undefined {
  const raw = process.env.IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON;
  if (!raw || raw.length > 64 * 1024) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item): item is LocalPreviewMembership => Boolean(item) && typeof item === "object"
      && typeof (item as LocalPreviewMembership).actorId === "string" && (item as LocalPreviewMembership).actorId.length > 0 && (item as LocalPreviewMembership).actorId.length <= 256
      && typeof (item as LocalPreviewMembership).businessId === "string" && (item as LocalPreviewMembership).businessId.length > 0 && (item as LocalPreviewMembership).businessId.length <= 256
      && localRoles.has((item as LocalPreviewMembership).role))) return undefined;
    return parsed;
  } catch { return undefined; }
}

/**
 * The real local/mock composition is deliberately tiny and immutable: an empty, all-hit index and
 * an empty approved-link repository.  It is useful for exercising the signed-preview transport,
 * but cannot discover catalog data, initialize storage, or mutate a local demo.
 */
async function configuredLocalComposition(): Promise<LocalIdentityPreviewComposition | undefined> {
  const memberships = configuredMemberships();
  if (!memberships) return undefined;
  const repository = createLocalRepository(createFileAtomicLocalStorage({ root: localIdentityStorageRoot() }));
  const model = await loadAuthoritativeLocalIdentityReadModel(repository);
  if (!model) return undefined;
  const snapshot = model.snapshot;
  const linkVersion = "local-snapshot-links-v1";
  const linkSnapshotHash = model.linkSnapshotHash;
  return {
    snapshot,
    lookupApprovedLinks: model.lookupApprovedLinks,
    authenticate: async (_request, businessId) => {
      // Mock mode has no Firebase session.  The actor is nevertheless server-owned: never accept
      // an actor id from a request header, cookie, or body as proof of membership.
      const actorId = process.env.SCANBIN_LOCAL_ACTOR_ID;
      const membership = memberships.find((item) => item.actorId === actorId && item.businessId === businessId);
      return membership ? { actorId: membership.actorId, role: membership.role } : undefined;
    },
    signingKey: () => process.env.IDENTITY_PREVIEW_SIGNING_KEY,
    versions: { engineVersion: "identity-engine-v2", pluginVersions: [...identityPluginVersions], catalogVersion: snapshot.catalogVersion, catalogSnapshotHash: snapshot.catalogSnapshotHash, linkVersion, linkSnapshotHash },
  };
}

async function currentComposition(): Promise<LocalIdentityPreviewComposition | undefined> {
  return localComposition ?? configuredLocalComposition();
}

/** Explicit local/mock injection only. There is no storage, catalog, provider, or network fallback. */
export function setLocalIdentityPreviewCompositionForTest(value: LocalIdentityPreviewComposition | undefined): void {
  localComposition = value;
}

export async function authorizeLocalIdentityPreview(request: Request, businessId: string): Promise<IdentityPreviewActor | undefined> {
  return (await currentComposition())?.authenticate(request, businessId);
}

export async function createComposedIdentityPreview(input: CreateIdentityPreviewInput, actor: IdentityPreviewActor): Promise<unknown> {
  const composition = await currentComposition();
  if (!composition) throw new Error("local_snapshot_unavailable");
  const source = createReadOnlyCandidateSource({ snapshot: composition.snapshot, lookupApprovedLinks: composition.lookupApprovedLinks });
  const signer = await createLocalPreviewSigner(composition.signingKey());
  const issuedAt = (composition.now?.() ?? new Date()).toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + 15 * 60 * 1000).toISOString();
  // The durable tenant link state is part of the signed preview version. A confirmation or revoke
  // therefore invalidates an already-issued preview even when the injected master snapshot is unchanged.
  const linkSnapshotHash = localComposition ? composition.versions.linkSnapshotHash : await deriveAuthoritativeLinkSnapshotHash(
    { linkSnapshotHash: composition.versions.linkSnapshotHash },
    createLocalRepository(createFileAtomicLocalStorage({ root: localIdentityStorageRoot() })),
    input.rows[0]?.businessId ?? "",
  );
  return createIdentityPreview({ ...input, actorId: actor.actorId, versions: { ...composition.versions, linkSnapshotHash }, issuedAt, expiresAt }, { source, signer });
}
