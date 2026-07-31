import "server-only";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { isLocalIdentityApplyEnabled } from "@/server/identity/applyComposition";
import { createFileAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";
import { createLocalRepository, type LocalIdentityRepository } from "@/server/identity/localRepository";
import { loadConfiguredLocalIdentityReadModel } from "@/server/identity/localIdentityReadModel";
import type { ApplyActor } from "@/server/identity/applyService";
import type { IdentityLink, IdentityReview, TenantIdentityProduct } from "@/services/identity/types";
import { canonicalSha256 } from "@/services/identity/canonical";

type ReviewRole = ApplyActor["role"];
type ReviewRepository = Pick<LocalIdentityRepository, "listIdentityReviews"> & Partial<Pick<LocalIdentityRepository, "applyReviewAction" | "resolveIdentityReview" | "saveIdentityLink" | "createTenantProduct">>;
type Versions = { catalogVersion: string; linkVersion: string };
const roles: ReviewRole[] = ["owner", "admin", "counter", "viewer"];
const root = path.join(process.cwd(), ".tmp", "identity-import", "local-apply-v1");

function json(body: unknown, status = 200): NextResponse { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function actorFromEnvironment(businessId: string): ApplyActor | undefined {
  const actorId = process.env.SCANBIN_LOCAL_ACTOR_ID;
  const raw = process.env.IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON;
  if (!actorId || !raw || raw.length > 64 * 1024) return undefined;
  try { const members: unknown = JSON.parse(raw); if (!Array.isArray(members)) return undefined; const member = members.find((value) => value && typeof value === "object" && (value as ApplyActor).actorId === actorId && (value as ApplyActor).businessId === businessId && roles.includes((value as ApplyActor).role)); return member as ApplyActor | undefined; } catch { return undefined; }
}
async function defaultVersions(): Promise<Versions> { const model = await loadConfiguredLocalIdentityReadModel(); if (!model) throw new Error("review_configuration_unavailable"); return { catalogVersion: model.snapshot.catalogVersion, linkVersion: model.linkSnapshotHash }; }

type Dependencies = { enabled: () => boolean; authorize: (request: Request, businessId: string) => Promise<ApplyActor | undefined>; repository: ReviewRepository; currentVersions: () => Promise<Versions>; currentModel?: () => ReturnType<typeof loadConfiguredLocalIdentityReadModel> };
type Action = "confirm_candidate" | "reject" | "create_tenant_product" | "revoke_link";
const maxBodyBytes = 16 * 1024;
function positiveInteger(value: string | null, fallback: number, maximum: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback; }
function requestBody(value: unknown): value is { businessId: string; reviewId: string; action: Action; targetProductId?: string; name?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every((key) => ["businessId", "reviewId", "action", "targetProductId", "name"].includes(key)) && typeof input.businessId === "string" && input.businessId.length > 0 && typeof input.reviewId === "string" && input.reviewId.length > 0 && ["confirm_candidate", "reject", "create_tenant_product", "revoke_link"].includes(input.action as string) && (input.targetProductId === undefined || typeof input.targetProductId === "string") && (input.name === undefined || typeof input.name === "string");
}
function isManager(actor: ApplyActor): boolean { return actor.role === "owner" || actor.role === "admin"; }
function chosenCandidate(review: IdentityReview, targetProductId: string | undefined): string | undefined { return targetProductId && review.decision.candidates.some((candidate) => candidate.productId === targetProductId) ? targetProductId : undefined; }

export function createIdentityReviewRoute(dependencies: Dependencies): (request: Request) => Promise<NextResponse> {
  return async (request) => {
    if (!dependencies.enabled()) return json({ error: "Identity reviews are unavailable." }, 404);
    const url = new URL(request.url);
    const businessId = request.method === "GET" ? url.searchParams.get("businessId") ?? "" : "";
    let body: { businessId: string; reviewId: string; action: Action; targetProductId?: string; name?: string } | undefined;
    if (request.method === "POST") { if (Number(request.headers.get("content-length")) > maxBodyBytes) return json({ error: "Identity review request was too large." }, 400); try { const text = await request.text(); if (new TextEncoder().encode(text).byteLength > maxBodyBytes) return json({ error: "Identity review request was too large." }, 400); const parsed: unknown = JSON.parse(text); if (!requestBody(parsed)) return json({ error: "Identity review request was invalid." }, 400); body = parsed; } catch { return json({ error: "Body must be valid JSON." }, 400); } }
    const scope = body?.businessId ?? businessId;
    if (!scope) return json({ error: "Business access is required." }, 400);
    const actor = await dependencies.authorize(request, scope);
    if (!actor || actor.businessId !== scope) return json({ error: "Business access is required." }, 403);
    if (request.method === "GET") { try { const reviews = await dependencies.repository.listIdentityReviews(scope); const pageSize = positiveInteger(url.searchParams.get("pageSize"), 25, 25), requestedPage = positiveInteger(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER), page = Math.min(requestedPage, Math.max(1, Math.ceil(reviews.length / pageSize))); return json({ reviews: reviews.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: reviews.length }); } catch { return json({ error: "Unable to load identity reviews." }, 500); } }
    if (request.method !== "POST" || !body) return json({ error: "Method not allowed." }, 405);
    if (!isManager(actor)) return json({ error: "Only owners and admins can resolve identity reviews." }, 403);
    try {
    const review = (await dependencies.repository.listIdentityReviews(scope)).find((item) => item.reviewId === body!.reviewId);
    if (!review) return json({ error: "Identity review was not found." }, 404);
    const actionId = request.headers.get("Idempotency-Key") ?? `review:${review.reviewId}:${body.action}`;
    const apply = async (resolution: NonNullable<IdentityReview["resolution"]>, link?: IdentityLink, product?: TenantIdentityProduct) => {
      const payloadFingerprint = await canonicalSha256({ reviewId: review.reviewId, action: body!.action, targetProductId: body!.targetProductId ?? "", name: body!.name?.trim() ?? "" });
      if (dependencies.repository.applyReviewAction) return dependencies.repository.applyReviewAction({ businessId: scope, reviewId: review.reviewId, actionId, payloadFingerprint, resolution, resolvedBy: actor.actorId, ...(link ? { link } : {}), ...(product ? { product } : {}) });
      if (product) await dependencies.repository.createTenantProduct?.(product); if (link) await dependencies.repository.saveIdentityLink?.(link);
      return { review: await dependencies.repository.resolveIdentityReview!(scope, review.reviewId, resolution, actor.actorId, new Date().toISOString()), ...(link ? { link } : {}), ...(product ? { product } : {}) };
    };
    if (body.action === "reject") return json(await apply("rejected"));
    if (body.action === "create_tenant_product") {
      const name = body.name?.trim(); if (!name || name.length > 200) return json({ error: "A tenant product name is required." }, 400);
      const product: TenantIdentityProduct = { productId: `tenant:${randomUUID()}`, businessId: scope, name, createdBy: actor.actorId, createdAt: new Date().toISOString() };
      const key = review.decision.normalizedKeys[0]; if (!key || !review.scope) return json({ error: "The review has no durable identifier." }, 409);
      const versions = await dependencies.currentVersions(); const link: IdentityLink = { businessId: scope, sourceSystem: review.scope.sourceSystem, vendorId: review.scope.vendorId, sourceSignature: review.scope.sourceSignature, identifierType: key.type, namespace: key.namespace ?? "", rawValue: key.value, normalizedValue: key.value, targetProductId: product.productId, status: "approved", evidence: [...review.decision.decisionBasis.map((basis) => basis.evidenceId), `catalog:${versions.catalogVersion}`, `links:${versions.linkVersion}`, `review:${review.reviewId}`], createdBy: actor.actorId, createdAt: new Date().toISOString(), approvedBy: actor.actorId, approvedAt: new Date().toISOString(), version: 1 };
      return json(await apply("create_product", link, product));
    }
    const targetProductId = chosenCandidate(review, body.targetProductId);
    if (!targetProductId || !review.scope) return json({ error: "The selected candidate is not available for this review." }, 409);
    const key = review.decision.normalizedKeys[0]; if (!key) return json({ error: "The review has no durable identifier." }, 409);
    const model = dependencies.currentModel ? await dependencies.currentModel() : undefined;
    if (dependencies.currentModel && (!model || !model.hasCurrentTarget({ businessId: scope, sourceSystem: review.scope.sourceSystem, sourceSignature: review.scope.sourceSignature, vendorId: review.scope.vendorId, targetProductId, identifiers: [{ type: key.type, raw: key.value, normalized: key.value, namespace: key.namespace, source: "review", evidenceAuthority: "vendor_import", evidenceId: review.reviewId, evidenceVersion: review.decision.decisionFingerprint }] }))) return json({ error: "The selected target is stale or no longer supported by its exact identifier." }, 409);
    const versions = await dependencies.currentVersions();
    const link: IdentityLink = { businessId: scope, sourceSystem: review.scope.sourceSystem, vendorId: review.scope.vendorId, sourceSignature: review.scope.sourceSignature, identifierType: key.type, namespace: key.namespace ?? "", rawValue: key.value, normalizedValue: key.value, targetProductId, status: body.action === "revoke_link" ? "revoked" : "approved", evidence: [...review.decision.decisionBasis.map((basis) => basis.evidenceId), `catalog:${versions.catalogVersion}`, `links:${versions.linkVersion}`, `review:${review.reviewId}`], createdBy: actor.actorId, createdAt: new Date().toISOString(), ...(body.action === "confirm_candidate" ? { approvedBy: actor.actorId, approvedAt: new Date().toISOString() } : {}), version: body.action === "revoke_link" ? 2 : 1 };
    return json(await apply(body.action === "revoke_link" ? "rejected" : "confirmed", link));
    } catch { return json({ error: "Unable to update identity review." }, 500); }
  };
}

export const GET = createIdentityReviewRoute({ enabled: isLocalIdentityApplyEnabled, authorize: async (_request, businessId) => actorFromEnvironment(businessId), repository: createLocalRepository(createFileAtomicLocalStorage({ root })), currentVersions: defaultVersions, currentModel: loadConfiguredLocalIdentityReadModel });
export const POST = GET;
