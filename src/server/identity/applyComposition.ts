import "server-only";

import path from "node:path";
import { isLiveAuth } from "@/services/auth/authMode";
import { canonicalSha256 } from "@/services/identity/canonical";
import { verifySignedPreviewChunks, type PreviewVersions } from "@/services/identity/preview";
import { createFileAtomicLocalStorage, type AtomicLocalStorage } from "./atomicLocalStorage";
import { applyIdentityImport, type ApplyActor, type ApplyIdentityImportInput, type ApplyResult } from "./applyService";
import { createLocalAggregateLedger } from "./localAggregateLedger";
import { createLocalRepository } from "./localRepository";
import { createLocalPreviewSigner } from "./previewSigner";
import { loadConfiguredLocalIdentityReadModel } from "./localIdentityReadModel";

export interface LocalIdentityApplyComposition {
  storage: AtomicLocalStorage; signingKey: () => string | undefined; versions: PreviewVersions; now?: () => Date;
  authenticate(request: Request, businessId: string): Promise<ApplyActor | undefined>;
  revalidateCountableTarget?: (input: { businessId: string; targetProductId: string; row: Record<string, unknown>; decision: import("@/services/identity/types").IdentityDecision; corrected: boolean }) => Promise<boolean>;
}
let injected: LocalIdentityApplyComposition | undefined;
type Membership = ApplyActor;

function memberships(): Membership[] | undefined {
  const raw = process.env.IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON;
  if (!raw || raw.length > 64 * 1024) return undefined;
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) && value.length > 0 && value.every((item): item is Membership => Boolean(item) && typeof item === "object" && typeof (item as Membership).actorId === "string" && typeof (item as Membership).businessId === "string" && ["owner", "admin", "counter", "viewer"].includes((item as Membership).role)) ? value : undefined; } catch { return undefined; }
}
async function configured(): Promise<LocalIdentityApplyComposition | undefined> {
  const configuredMemberships = memberships(); if (!configuredMemberships) return undefined;
  const model = loadConfiguredLocalIdentityReadModel(); if (!model) return undefined;
  const catalogVersion = model.snapshot.catalogVersion, catalogSnapshotHash = model.snapshot.catalogSnapshotHash;
  const linkVersion = "local-snapshot-links-v1", linkSnapshotHash = await canonicalSha256({ linkVersion, catalogSnapshotHash });
  const root = path.join(process.cwd(), ".tmp", "identity-import", "local-apply-v1");
  return { storage: createFileAtomicLocalStorage({ root }), signingKey: () => process.env.IDENTITY_PREVIEW_SIGNING_KEY, versions: { engineVersion: "identity-engine-v1", pluginVersions: ["identity-generic-v1"], catalogVersion, catalogSnapshotHash, linkVersion, linkSnapshotHash }, revalidateCountableTarget: async (input) => model.hasCurrentTarget({ businessId: input.businessId, sourceSystem: String(input.row.sourceSystem), sourceSignature: String(input.row.sourceSignature), vendorId: String(input.row.vendorId), targetProductId: input.targetProductId }), authenticate: async (_request, businessId) => { const actorId = process.env.SCANBIN_LOCAL_ACTOR_ID; if (!actorId) return undefined; const member = configuredMemberships.find((membership) => membership.actorId === actorId && membership.businessId === businessId); if (!member) throw new Error("apply_nonmember"); return member; } };
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
  return applyIdentityImport(input, { repository: createLocalRepository(current.storage), ledger: createLocalAggregateLedger(current.storage), verifier: (payloads, now, expected) => verifySignedPreviewChunks(payloads, signer, now, expected), source: { versions: current.versions, revalidateCountableTarget: current.revalidateCountableTarget }, clock, actor });
}
