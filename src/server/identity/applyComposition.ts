import "server-only";

import path from "node:path";
import { isLiveAuth } from "@/services/auth/authMode";
import { verifySignedPreviewChunks, type PreviewVersions } from "@/services/identity/preview";
import { identityPluginVersions } from "@/services/identity/plugins";
import type { ScopedIdentifier } from "@/services/identity/types";
import { createFileAtomicLocalStorage, type AtomicLocalStorage, type AtomicTransaction } from "./atomicLocalStorage";
import { applyIdentityImport, type ApplyActor, type ApplyIdentityImportInput, type ApplyResult } from "./applyService";
import { createLocalAggregateLedger } from "./localAggregateLedger";
import { createLocalRepository } from "./localRepository";
import { createLocalPreviewSigner } from "./previewSigner";
import { loadAuthoritativeLocalIdentityReadModel, loadConfiguredLocalIdentityReadModel, deriveAuthoritativeLinkSnapshotHash } from "./localIdentityReadModel";
import { createLocalAtomicCountedApply } from "./localAtomicCountedApply";

export interface LocalIdentityApplyComposition {
  storage: AtomicLocalStorage; signingKey: () => string | undefined; versions: PreviewVersions; now?: () => Date;
  authenticate(request: Request, businessId: string): Promise<ApplyActor | undefined>;
  revalidateCountableTarget?: (input: { businessId: string; sourceSystem: string; sourceSignature: string; vendorId: string; targetProductId: string; identifiers: ScopedIdentifier[]; row: Record<string, unknown>; decision: import("@/services/identity/types").IdentityDecision; corrected: boolean }, transaction?: AtomicTransaction) => Promise<boolean>;
}
let injected: LocalIdentityApplyComposition | undefined;
type Membership = ApplyActor;
/** Isolates local/test durable state without accepting a path from the environment. */
export function localIdentityStorageRoot(): string {
  const runId = process.env.IDENTITY_LOCAL_RUN_ID;
  const safeRunId = runId && /^[A-Za-z0-9_-]{1,128}$/.test(runId) ? runId : "local-apply-v1";
  return path.join(process.cwd(), ".tmp", "identity-import", safeRunId);
}

function memberships(): Membership[] | undefined {
  const raw = process.env.IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON;
  if (!raw || raw.length > 64 * 1024) return undefined;
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) && value.length > 0 && value.every((item): item is Membership => Boolean(item) && typeof item === "object" && typeof (item as Membership).actorId === "string" && typeof (item as Membership).businessId === "string" && ["owner", "admin", "counter", "viewer"].includes((item as Membership).role)) ? value : undefined; } catch { return undefined; }
}
async function configured(): Promise<LocalIdentityApplyComposition | undefined> {
  const configuredMemberships = memberships(); if (!configuredMemberships) return undefined;
  const root = localIdentityStorageRoot();
  const storage = createFileAtomicLocalStorage({ root });
  const repository = createLocalRepository(storage);
  const model = await loadAuthoritativeLocalIdentityReadModel(repository); const configuredModel = await loadConfiguredLocalIdentityReadModel(); if (!model || !configuredModel) return undefined;
  const catalogVersion = model.snapshot.catalogVersion, catalogSnapshotHash = model.snapshot.catalogSnapshotHash;
  const linkVersion = "local-snapshot-links-v1", linkSnapshotHash = model.linkSnapshotHash;
  return { storage, signingKey: () => process.env.IDENTITY_PREVIEW_SIGNING_KEY, versions: { engineVersion: "identity-engine-v2", pluginVersions: [...identityPluginVersions], catalogVersion, catalogSnapshotHash, linkVersion, linkSnapshotHash }, revalidateCountableTarget: async (input, transaction) => {
    // Atomic callers already own the storage mutex. Use the immutable configured snapshot
    // plus their transaction state; never recursively open the repository here.
    if (await configuredModel.hasCurrentTarget({ businessId: input.businessId, sourceSystem: input.sourceSystem, sourceSignature: input.sourceSignature, vendorId: input.vendorId, targetProductId: input.targetProductId, identifiers: input.identifiers })) return true;
    if (transaction) {
      const links = await transaction.get<Array<{ businessId: string; sourceSystem: string; sourceSignature: string; vendorId: string; identifierType: string; namespace: string; normalizedValue: string; targetProductId: string; status: string; version: number }>>("identity-links") ?? [];
      const products = await transaction.get<Array<{ businessId: string; productId: string }>>("identity-tenant-products") ?? [];
      const product = products.some((item) => item.businessId === input.businessId && item.productId === input.targetProductId);
      const current = links.filter((link) => link.businessId === input.businessId && link.sourceSystem === input.sourceSystem && link.sourceSignature === input.sourceSignature && link.vendorId === input.vendorId && input.identifiers.some((identifier) => identifier.type === link.identifierType && (identifier.namespace ?? "") === link.namespace && identifier.normalized === link.normalizedValue)).sort((left, right) => right.version - left.version)[0];
      return Boolean(product && current?.status === "approved" && current.targetProductId === input.targetProductId);
    }
    const current = await loadAuthoritativeLocalIdentityReadModel(repository);
    return Boolean(current && await current.hasCurrentTarget({ businessId: input.businessId, sourceSystem: input.sourceSystem, sourceSignature: input.sourceSignature, vendorId: input.vendorId, targetProductId: input.targetProductId, identifiers: input.identifiers }));
  }, authenticate: async (_request, businessId) => { const actorId = process.env.SCANBIN_LOCAL_ACTOR_ID; if (!actorId) return undefined; const member = configuredMemberships.find((membership) => membership.actorId === actorId && membership.businessId === businessId); if (!member) throw new Error("apply_nonmember"); return member; } };
}
async function composition(): Promise<LocalIdentityApplyComposition | undefined> { return injected ?? configured(); }
export function setLocalIdentityApplyCompositionForTest(value: LocalIdentityApplyComposition | undefined): void { injected = value; }
export function isLocalIdentityApplyEnabled(): boolean { return process.env.NODE_ENV !== "production" && !isLiveAuth() && process.env.NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1 === "1"; }

function businessIdFromUnsignedToken(token: string): string | undefined {
  try { const chunk: unknown = JSON.parse(token); const businessId = (chunk as { scope?: { businessId?: unknown } })?.scope?.businessId; return typeof businessId === "string" && businessId.length > 0 && businessId.length <= 256 ? businessId : undefined; } catch { return undefined; }
}
export async function authorizeLocalIdentityApply(request: Request, token: string): Promise<ApplyActor | undefined> {
  const current = await composition(); const businessId = businessIdFromUnsignedToken(token);
  if (!current || !businessId) throw new Error("local_apply_configuration_unavailable");
  return current.authenticate(request, businessId);
}
export async function applyComposedIdentityImport(input: ApplyIdentityImportInput, actor: ApplyActor): Promise<ApplyResult> {
  const current = await composition(); if (!current) throw new Error("local_apply_configuration_unavailable");
  const signer = await createLocalPreviewSigner(current.signingKey()); const clock = () => (current.now?.() ?? new Date()).toISOString();
  const repository = createLocalRepository(current.storage);
  const linkSnapshotHash = injected ? current.versions.linkSnapshotHash : await deriveAuthoritativeLinkSnapshotHash({ linkSnapshotHash: current.versions.linkSnapshotHash }, repository, actor.businessId);
  const versions = { ...current.versions, linkSnapshotHash };
  const atomicCountedRow = current.revalidateCountableTarget ? createLocalAtomicCountedApply(current.storage, current.revalidateCountableTarget) : undefined;
  return applyIdentityImport(input, { repository, ledger: createLocalAggregateLedger(current.storage), verifier: (payloads, now, expected) => verifySignedPreviewChunks(payloads, signer, now, expected), source: { versions, revalidateCountableTarget: current.revalidateCountableTarget }, ...(atomicCountedRow ? { atomicCountedRow } : {}), clock, actor });
}
