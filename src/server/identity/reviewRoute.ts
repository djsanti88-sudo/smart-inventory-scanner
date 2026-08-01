import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isLocalIdentityApplyEnabled, localIdentityStorageRoot } from "@/server/identity/applyComposition";
import { createFileAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";
import { createLocalRepository, type LocalIdentityRepository } from "@/server/identity/localRepository";
import { deriveAuthoritativeLinkSnapshotHash, loadAuthoritativeLocalIdentityReadModel, type CurrentApprovedIdentityLink } from "@/server/identity/localIdentityReadModel";
import type { ApplyActor } from "@/server/identity/applyService";
import type { IdentityLink, IdentityReview, TenantIdentityProduct } from "@/services/identity/types";
import { canonicalSha256, isValidIdentityNamespace } from "@/services/identity/canonical";

type ReviewRole = ApplyActor["role"];
type ReviewRepository = Pick<LocalIdentityRepository, "listIdentityReviews"> & Partial<Pick<LocalIdentityRepository, "pageIdentityReviews" | "listCurrentIdentityLinks" | "pageCurrentIdentityLinks" | "findCurrentIdentityLinks" | "applyReviewAction" | "resolveIdentityReview" | "saveIdentityLink" | "createTenantProduct" | "revokeIdentityLink">>;
type Versions = { catalogVersion: string; linkVersion: string };
const roles: ReviewRole[] = ["owner", "admin", "counter", "viewer"];

function json(body: unknown, status = 200): NextResponse { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function actorFromEnvironment(businessId: string): ApplyActor | undefined {
  const actorId = process.env.SCANBIN_LOCAL_ACTOR_ID;
  const raw = process.env.IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON;
  if (!actorId || !raw || raw.length > 64 * 1024) return undefined;
  try { const members: unknown = JSON.parse(raw); if (!Array.isArray(members)) return undefined; const member = members.find((value) => value && typeof value === "object" && (value as ApplyActor).actorId === actorId && (value as ApplyActor).businessId === businessId && roles.includes((value as ApplyActor).role)); return member as ApplyActor | undefined; } catch { return undefined; }
}
const defaultRepository = createLocalRepository(createFileAtomicLocalStorage({ root: localIdentityStorageRoot() }));
async function defaultModel() { return loadAuthoritativeLocalIdentityReadModel(defaultRepository); }
async function defaultVersions(businessId?: string): Promise<Versions> { const model = await defaultModel(); if (!model) throw new Error("review_configuration_unavailable"); return { catalogVersion: model.snapshot.catalogVersion, linkVersion: businessId ? await deriveAuthoritativeLinkSnapshotHash(model, defaultRepository, businessId) : model.linkSnapshotHash }; }

type Dependencies = { enabled: () => boolean; authorize: (request: Request, businessId: string) => Promise<ApplyActor | undefined>; repository: ReviewRepository; currentVersions: (businessId?: string) => Promise<Versions>; currentModel?: () => ReturnType<typeof loadAuthoritativeLocalIdentityReadModel>; currentApprovedLinks?: (businessId: string) => Promise<CurrentApprovedIdentityLink[]>; pageCurrentApprovedLinks?: (businessId: string, input: { page: number; pageSize: number }) => Promise<{ items: CurrentApprovedIdentityLink[]; total: number }> };
type Action = "confirm_candidate" | "reject" | "create_tenant_product" | "revoke_link";
type Bucket = "automatic" | "review" | "abstain" | "non_product" | "invalid";
const bucketValues = new Set<Bucket>(["automatic", "review", "abstain", "non_product", "invalid"]);
const maxBodyBytes = 16 * 1024;
function positiveInteger(value: string | null, fallback: number, maximum: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback; }
type StandaloneLink = Pick<CurrentApprovedIdentityLink, "sourceSystem" | "sourceSignature" | "vendorId" | "identifierType" | "namespace" | "normalizedValue" | "targetProductId" | "version" | "predecessorFingerprint" | "predecessorSource">;
function standaloneLink(value: unknown): value is StandaloneLink { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const link = value as Record<string, unknown>; return Object.keys(link).every((key) => ["sourceSystem", "sourceSignature", "vendorId", "identifierType", "namespace", "normalizedValue", "targetProductId", "version", "predecessorFingerprint", "predecessorSource"].includes(key)) && ["sourceSystem", "sourceSignature", "vendorId", "identifierType", "normalizedValue", "targetProductId", "predecessorFingerprint"].every((key) => typeof link[key] === "string" && Boolean((link[key] as string).trim())) && isValidIdentityNamespace(link.identifierType, link.namespace) && Number.isSafeInteger(link.version) && (link.predecessorSource === "configured" || link.predecessorSource === "durable"); }
function requestBody(value: unknown): value is { businessId: string; reviewId?: string; action: Action; targetProductId?: string; name?: string; link?: StandaloneLink } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every((key) => ["businessId", "reviewId", "action", "targetProductId", "name", "link"].includes(key)) && typeof input.businessId === "string" && input.businessId.length > 0 && ["confirm_candidate", "reject", "create_tenant_product", "revoke_link"].includes(input.action as string) && ((typeof input.reviewId === "string" && input.reviewId.length > 0) || (input.action === "revoke_link" && standaloneLink(input.link))) && (input.targetProductId === undefined || typeof input.targetProductId === "string") && (input.name === undefined || typeof input.name === "string");
}
function isManager(actor: ApplyActor): boolean { return actor.role === "owner" || actor.role === "admin"; }
function chosenCandidate(review: IdentityReview, targetProductId: string | undefined): string | undefined { return targetProductId && review.decision.candidates.some((candidate) => candidate.productId === targetProductId) ? targetProductId : undefined; }
async function boundedText(request: Request): Promise<string> { const reader = request.body?.getReader(); if (!reader) return ""; const chunks: Uint8Array[] = []; let bytes = 0; while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maxBodyBytes) { await reader.cancel(); throw new Error("too_large"); } chunks.push(chunk.value); } return new TextDecoder().decode(Buffer.concat(chunks)); }

export function createIdentityReviewRoute(dependencies: Dependencies): (request: Request) => Promise<NextResponse> {
  return async (request) => {
    if (!dependencies.enabled()) return json({ error: "Identity reviews are unavailable." }, 404);
    const url = new URL(request.url);
    const businessId = request.method === "GET" ? url.searchParams.get("businessId") ?? "" : "";
    let body: { businessId: string; reviewId?: string; action: Action; targetProductId?: string; name?: string; link?: StandaloneLink } | undefined;
    if (request.method === "POST") { if (Number(request.headers.get("content-length")) > maxBodyBytes) return json({ error: "Identity review request was too large." }, 400); try { const parsed: unknown = JSON.parse(await boundedText(request)); if (!requestBody(parsed)) return json({ error: "Identity review request was invalid." }, 400); body = parsed; } catch (error) { return json({ error: error instanceof Error && error.message === "too_large" ? "Identity review request was too large." : "Body must be valid JSON." }, 400); } }
    const scope = body?.businessId ?? businessId;
    if (!scope) return json({ error: "Business access is required." }, 400);
    let actor: ApplyActor | undefined; try { actor = await dependencies.authorize(request, scope); } catch { return json({ error: "Business access is required." }, 403); }
    if (!actor || actor.businessId !== scope) return json({ error: "Business access is required." }, 403);
    if (request.method === "GET") { try { const requestedBucket = url.searchParams.get("bucket"); if (requestedBucket && !bucketValues.has(requestedBucket as Bucket)) return json({ error: "Identity review filter was invalid." }, 400); const pageSize = positiveInteger(url.searchParams.get("pageSize"), 25, 25), requestedPage = positiveInteger(url.searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER), linkPage = positiveInteger(url.searchParams.get("linkPage"), 1, Number.MAX_SAFE_INTEGER); const all = dependencies.repository.pageIdentityReviews ? undefined : await dependencies.repository.listIdentityReviews(scope), filtered = all?.filter((review) => !requestedBucket || review.decision.kind === requestedBucket) ?? [], reviewPage = dependencies.repository.pageIdentityReviews ? await dependencies.repository.pageIdentityReviews(scope, { ...(requestedBucket ? { bucket: requestedBucket } : {}), page: requestedPage, pageSize }) : { items: filtered.slice((requestedPage - 1) * pageSize, requestedPage * pageSize), total: filtered.length, bucketTotals: Object.fromEntries([...bucketValues].map((bucket) => [bucket, all!.filter((review) => review.decision.kind === bucket).length])) }, page = Math.min(requestedPage, Math.max(1, Math.ceil(reviewPage.total / pageSize))), lookups = reviewPage.items.flatMap((review) => { const key = review.decision.normalizedKeys[0]; return key && review.scope ? [{ businessId: scope, sourceSystem: review.scope.sourceSystem, vendorId: review.scope.vendorId, sourceSignature: review.scope.sourceSignature, identifierType: key.type, namespace: key.namespace ?? "", normalizedValue: key.value }] : []; }), links = dependencies.repository.findCurrentIdentityLinks ? await dependencies.repository.findCurrentIdentityLinks(scope, lookups) : dependencies.repository.listCurrentIdentityLinks ? await dependencies.repository.listCurrentIdentityLinks(scope) : []; const approvedPage = dependencies.pageCurrentApprovedLinks ? await dependencies.pageCurrentApprovedLinks(scope, { page: linkPage, pageSize }) : dependencies.currentApprovedLinks ? (() => dependencies.currentApprovedLinks!(scope).then((items) => ({ items: items.slice((linkPage - 1) * pageSize, linkPage * pageSize), total: items.length })))() : Promise.resolve({ items: [] as CurrentApprovedIdentityLink[], total: 0 }); const approved = await approvedPage; const enrich = (review: IdentityReview) => { const key = review.decision.normalizedKeys[0], link = key && review.scope ? links.find((entry) => entry.status === "approved" && entry.sourceSystem === review.scope!.sourceSystem && entry.vendorId === review.scope!.vendorId && entry.sourceSignature === review.scope!.sourceSignature && entry.identifierType === key.type && entry.namespace === (key.namespace ?? "") && entry.normalizedValue === key.value) : undefined; return link ? { ...review, currentApprovedLink: { targetProductId: link.targetProductId, version: link.version } } : review; }; return json({ reviews: reviewPage.items.map(enrich), currentApprovedLinks: approved.items, page, linkPage, pageSize, total: reviewPage.total, linkTotal: approved.total, bucketTotals: reviewPage.bucketTotals }); } catch { return json({ error: "Unable to load identity reviews." }, 500); } }
    if (request.method !== "POST" || !body) return json({ error: "Method not allowed." }, 405);
    if (!isManager(actor)) return json({ error: "Only owners and admins can resolve identity reviews." }, 403);
    try {
    if (body.action === "revoke_link" && !body.reviewId && body.link) {
      const current = dependencies.currentApprovedLinks ? await dependencies.currentApprovedLinks(scope) : [];
      const predecessor = current.find((link) => ["sourceSystem", "sourceSignature", "vendorId", "identifierType", "namespace", "normalizedValue", "targetProductId", "version", "predecessorFingerprint", "predecessorSource"].every((key) => link[key as keyof StandaloneLink] === body!.link![key as keyof StandaloneLink]));
      if (!predecessor || !dependencies.repository.revokeIdentityLink) return json({ error: "The approved identity link is no longer current." }, 409);
      const link: IdentityLink = { businessId: scope, sourceSystem: predecessor.sourceSystem, sourceSignature: predecessor.sourceSignature, vendorId: predecessor.vendorId, identifierType: predecessor.identifierType, namespace: predecessor.namespace, rawValue: predecessor.normalizedValue, normalizedValue: predecessor.normalizedValue, targetProductId: predecessor.targetProductId, status: "revoked", evidence: [`links:${(await dependencies.currentVersions(scope)).linkVersion}`], createdBy: actor.actorId, createdAt: new Date().toISOString(), version: 0 };
      return json({ link: await dependencies.repository.revokeIdentityLink({ link, predecessor: { source: predecessor.predecessorSource, fingerprint: predecessor.predecessorFingerprint, version: predecessor.version } }) });
    }
    const review = (await dependencies.repository.listIdentityReviews(scope)).find((item) => item.reviewId === body!.reviewId);
    if (!review) return json({ error: "Identity review was not found." }, 404);
    const actionId = request.headers.get("Idempotency-Key") ?? `review:${review.reviewId}:${body.action}`;
    const apply = async (resolution: NonNullable<IdentityReview["resolution"]>, link?: IdentityLink, product?: TenantIdentityProduct) => {
      const payloadFingerprint = await canonicalSha256({ reviewId: review.reviewId, action: body!.action, targetProductId: body!.targetProductId ?? "", name: body!.name?.trim() ?? "" });
      if (dependencies.repository.applyReviewAction) return dependencies.repository.applyReviewAction({ businessId: scope, reviewId: review.reviewId, actionId, payloadFingerprint, action: body!.action, resolution, resolvedBy: actor.actorId, ...(link ? { link } : {}), ...(product ? { product } : {}) });
      if (product) await dependencies.repository.createTenantProduct?.(product); if (link) await dependencies.repository.saveIdentityLink?.(link);
      return { review: await dependencies.repository.resolveIdentityReview!(scope, review.reviewId, resolution, actor.actorId, new Date().toISOString()), ...(link ? { link } : {}), ...(product ? { product } : {}) };
    };
    if (body.action === "reject") return json(await apply("rejected"));
    if (body.action === "create_tenant_product") {
      const name = body.name?.trim(); if (!name || name.length > 200) return json({ error: "A tenant product name is required." }, 400);
      const product: TenantIdentityProduct = { productId: `tenant:${randomUUID()}`, businessId: scope, name, createdBy: actor.actorId, createdAt: new Date().toISOString() };
      const key = review.decision.normalizedKeys[0]; if (!key || !review.scope) return json({ error: "The review has no durable identifier." }, 409);
      const versions = await dependencies.currentVersions(scope); const link: IdentityLink = { businessId: scope, sourceSystem: review.scope.sourceSystem, vendorId: review.scope.vendorId, sourceSignature: review.scope.sourceSignature, identifierType: key.type, namespace: key.namespace ?? "", rawValue: key.value, normalizedValue: key.value, targetProductId: product.productId, status: "approved", evidence: [...review.decision.decisionBasis.map((basis) => basis.evidenceId), `catalog:${versions.catalogVersion}`, `links:${versions.linkVersion}`, `review:${review.reviewId}`], createdBy: actor.actorId, createdAt: new Date().toISOString(), approvedBy: actor.actorId, approvedAt: new Date().toISOString(), version: 1 };
      return json(await apply("create_product", link, product));
    }
    const targetProductId = chosenCandidate(review, body.targetProductId);
    if (!targetProductId || !review.scope) return json({ error: "The selected candidate is not available for this review." }, 409);
    const key = review.decision.normalizedKeys[0]; if (!key) return json({ error: "The review has no durable identifier." }, 409);
    const model = dependencies.currentModel ? await dependencies.currentModel() : undefined;
    if (dependencies.currentModel && (!model || !await model.hasCurrentTarget({ businessId: scope, sourceSystem: review.scope.sourceSystem, sourceSignature: review.scope.sourceSignature, vendorId: review.scope.vendorId, targetProductId, identifiers: [{ type: key.type, raw: key.value, normalized: key.value, namespace: key.namespace, source: "review", evidenceAuthority: "vendor_import", evidenceId: review.reviewId, evidenceVersion: review.decision.decisionFingerprint }] }))) return json({ error: "The selected target is stale or no longer supported by its exact identifier." }, 409);
    const versions = await dependencies.currentVersions(scope);
    if (body.action !== "revoke_link" && dependencies.repository.listCurrentIdentityLinks) {
      const current = (await dependencies.repository.listCurrentIdentityLinks(scope)).find((link) => link.sourceSystem === review.scope!.sourceSystem && link.vendorId === review.scope!.vendorId && link.sourceSignature === review.scope!.sourceSignature && link.identifierType === key.type && link.namespace === (key.namespace ?? "") && link.normalizedValue === key.value);
      if (current?.status === "approved" && current.targetProductId !== targetProductId) return json({ error: "The approved identity link is no longer current." }, 409);
    }
    if (body.action === "revoke_link" && dependencies.repository.listCurrentIdentityLinks) {
      const current = (await dependencies.repository.listCurrentIdentityLinks(scope)).find((link) => link.sourceSystem === review.scope!.sourceSystem && link.vendorId === review.scope!.vendorId && link.sourceSignature === review.scope!.sourceSignature && link.identifierType === key.type && link.namespace === (key.namespace ?? "") && link.normalizedValue === key.value);
      if (!current || current.status !== "approved" || current.targetProductId !== targetProductId) return json({ error: "The approved identity link is no longer current." }, 409);
    }
    const link: IdentityLink = { businessId: scope, sourceSystem: review.scope.sourceSystem, vendorId: review.scope.vendorId, sourceSignature: review.scope.sourceSignature, identifierType: key.type, namespace: key.namespace ?? "", rawValue: key.value, normalizedValue: key.value, targetProductId, status: body.action === "revoke_link" ? "revoked" : "approved", evidence: [...review.decision.decisionBasis.map((basis) => basis.evidenceId), `catalog:${versions.catalogVersion}`, `links:${versions.linkVersion}`, `review:${review.reviewId}`], createdBy: actor.actorId, createdAt: new Date().toISOString(), ...(body.action === "confirm_candidate" ? { approvedBy: actor.actorId, approvedAt: new Date().toISOString() } : {}), version: 0 };
    return json(await apply(body.action === "revoke_link" ? "rejected" : "confirmed", link));
    } catch (error) { if (error instanceof Error && /identity_(?:review_(?:action_conflict|terminal|revoke_conflict|target_conflict)|link_revoke_conflict)/.test(error.message)) return json({ error: "The identity review changed before this action could be applied." }, 409); return json({ error: "Unable to update identity review." }, 500); }
  };
}

async function defaultCurrentApprovedLinks(businessId: string): Promise<CurrentApprovedIdentityLink[]> { const model = await defaultModel(); return model?.listCurrentApprovedLinks ? model.listCurrentApprovedLinks(businessId) : []; }
async function defaultPageCurrentApprovedLinks(businessId: string, input: { page: number; pageSize: number }) { const model = await defaultModel(); if (!model?.pageCurrentApprovedLinks) return { items: [] as CurrentApprovedIdentityLink[], total: 0 }; return model.pageCurrentApprovedLinks(businessId, input); }
export const defaultIdentityReviewRoute = createIdentityReviewRoute({ enabled: isLocalIdentityApplyEnabled, authorize: async (_request, businessId) => actorFromEnvironment(businessId), repository: defaultRepository, currentVersions: defaultVersions, currentModel: defaultModel, currentApprovedLinks: defaultCurrentApprovedLinks, pageCurrentApprovedLinks: defaultPageCurrentApprovedLinks });
