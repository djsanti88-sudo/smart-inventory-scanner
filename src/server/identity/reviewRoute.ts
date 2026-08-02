import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isLocalIdentityApplyEnabled, localIdentityStorageRoot } from "@/server/identity/applyComposition";
import { createFileAtomicLocalStorage } from "@/server/identity/atomicLocalStorage";
import { createLocalRepository, type LocalIdentityRepository } from "@/server/identity/localRepository";
import { decodeLinkCursor, decodeReviewCursor, encodeLinkCursor, encodeReviewCursor } from "@/server/identity/reviewCursor";
import { deriveAuthoritativeLinkSnapshotHash, loadAuthoritativeLocalIdentityReadModel, loadConfiguredLocalIdentityReadModel, type CurrentApprovedIdentityLink } from "@/server/identity/localIdentityReadModel";
import type { ApplyActor } from "@/server/identity/applyService";
import { createLocalAtomicCountedApply, type LocalAtomicCountedApplyInput, type LocalAtomicCountedApplyResult } from "@/server/identity/localAtomicCountedApply";
import { createLocalAtomicReviewCountedApply, type LocalAtomicReviewCountedApplyInput, type LocalAtomicReviewCountedApplyResult } from "@/server/identity/localAtomicReviewCountedApply";
import { createAggregateImportEvent } from "@/services/identity/importLedger";
import type { IdentityLink, IdentityReview, TenantIdentityProduct } from "@/services/identity/types";
import { canonicalSha256, isValidIdentityNamespace } from "@/services/identity/canonical";

type ReviewRole = ApplyActor["role"];
type ReviewRepository = Pick<LocalIdentityRepository, "listIdentityReviews"> & Partial<Pick<LocalIdentityRepository, "getIdentityReview" | "pageIdentityReviews" | "listCurrentIdentityLinks" | "pageCurrentIdentityLinks" | "findCurrentIdentityLinks" | "applyReviewAction" | "resolveIdentityReview" | "saveIdentityLink" | "createTenantProduct" | "revokeIdentityLink">>;
type Versions = { catalogVersion: string; linkVersion: string };
const roles: ReviewRole[] = ["owner", "admin", "counter", "viewer"];

function json(body: unknown, status = 200): NextResponse { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function actorFromEnvironment(businessId: string): ApplyActor | undefined {
  const actorId = process.env.SCANBIN_LOCAL_ACTOR_ID;
  const raw = process.env.IDENTITY_PREVIEW_LOCAL_MEMBERSHIPS_JSON;
  if (!actorId || !raw || raw.length > 64 * 1024) return undefined;
  try { const members: unknown = JSON.parse(raw); if (!Array.isArray(members)) return undefined; const member = members.find((value) => value && typeof value === "object" && (value as ApplyActor).actorId === actorId && (value as ApplyActor).businessId === businessId && roles.includes((value as ApplyActor).role)); return member as ApplyActor | undefined; } catch { return undefined; }
}
const defaultStorage = createFileAtomicLocalStorage({ root: localIdentityStorageRoot() });
const defaultRepository = createLocalRepository(defaultStorage);
async function defaultModel() { return loadAuthoritativeLocalIdentityReadModel(defaultRepository); }
async function defaultVersions(businessId?: string): Promise<Versions> { const model = await defaultModel(); if (!model) throw new Error("review_configuration_unavailable"); return { catalogVersion: model.snapshot.catalogVersion, linkVersion: businessId ? await deriveAuthoritativeLinkSnapshotHash(model, defaultRepository, businessId) : model.linkSnapshotHash }; }
const defaultAtomicCountedRow = createLocalAtomicCountedApply(defaultStorage, async (validation) => {
  const model = await defaultModel();
  return Boolean(model && await model.hasCurrentTarget({
    businessId: validation.businessId, sourceSystem: validation.sourceSystem,
    sourceSignature: validation.sourceSignature, vendorId: validation.vendorId,
    targetProductId: validation.targetProductId, identifiers: validation.identifiers,
  }));
}, { allowedRunStates: ["completed"] });
const defaultAtomicReviewApply = createLocalAtomicReviewCountedApply(defaultStorage);

type Dependencies = { enabled: () => boolean; authorize: (request: Request, businessId: string) => Promise<ApplyActor | undefined>; repository: ReviewRepository; currentVersions: (businessId?: string) => Promise<Versions>; currentModel?: () => ReturnType<typeof loadAuthoritativeLocalIdentityReadModel>; configuredModel?: () => ReturnType<typeof loadConfiguredLocalIdentityReadModel>; currentApprovedLinks?: (businessId: string) => Promise<CurrentApprovedIdentityLink[]>; pageCurrentApprovedLinks?: (businessId: string, input: { pageSize: number; after?: { normalizedValue: string; familyKey: string } }) => Promise<{ items: CurrentApprovedIdentityLink[]; total: number; nextAfter: { normalizedValue: string; familyKey: string } | null }>; atomicCountedRow?: (input: LocalAtomicCountedApplyInput) => Promise<LocalAtomicCountedApplyResult>; atomicReviewApply?: (input: LocalAtomicReviewCountedApplyInput) => Promise<LocalAtomicReviewCountedApplyResult> };
type Action = "confirm_candidate" | "reject" | "create_tenant_product" | "revoke_link";
type Bucket = "automatic" | "review" | "abstain" | "non_product" | "invalid";
const bucketValues = new Set<Bucket>(["automatic", "review", "abstain", "non_product", "invalid"]);
const maxBodyBytes = 16 * 1024;
function positiveInteger(value: string | null, fallback: number, maximum: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback; }
type StandaloneLink = Pick<CurrentApprovedIdentityLink, "sourceSystem" | "sourceSignature" | "vendorId" | "identifierType" | "namespace" | "normalizedValue" | "targetProductId" | "version" | "predecessorFingerprint" | "predecessorSource">;
function currentLinkFamilyKey(link: Pick<CurrentApprovedIdentityLink, "businessId" | "sourceSystem" | "vendorId" | "sourceSignature" | "identifierType" | "namespace" | "normalizedValue">): string { return JSON.stringify([link.businessId, link.sourceSystem, link.vendorId, link.sourceSignature, link.identifierType, link.namespace, link.normalizedValue]); }
function standaloneLink(value: unknown): value is StandaloneLink { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const link = value as Record<string, unknown>; return Object.keys(link).every((key) => ["sourceSystem", "sourceSignature", "vendorId", "identifierType", "namespace", "normalizedValue", "targetProductId", "version", "predecessorFingerprint", "predecessorSource"].includes(key)) && ["sourceSystem", "sourceSignature", "vendorId", "identifierType", "normalizedValue", "targetProductId", "predecessorFingerprint"].every((key) => typeof link[key] === "string" && Boolean((link[key] as string).trim())) && isValidIdentityNamespace(link.identifierType, link.namespace) && Number.isSafeInteger(link.version) && (link.predecessorSource === "configured" || link.predecessorSource === "durable"); }
function requestBody(value: unknown): value is { businessId: string; reviewId?: string; action: Action; targetProductId?: string; name?: string; link?: StandaloneLink } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every((key) => ["businessId", "reviewId", "action", "targetProductId", "name", "link"].includes(key)) && typeof input.businessId === "string" && input.businessId.length > 0 && ["confirm_candidate", "reject", "create_tenant_product", "revoke_link"].includes(input.action as string) && ((typeof input.reviewId === "string" && input.reviewId.length > 0) || (input.action === "revoke_link" && standaloneLink(input.link))) && (input.targetProductId === undefined || typeof input.targetProductId === "string") && (input.name === undefined || typeof input.name === "string");
}
function isManager(actor: ApplyActor): boolean { return actor.role === "owner" || actor.role === "admin"; }
type ReviewCandidate = IdentityReview["decision"]["candidates"][number];
type IdentifierFamily = NonNullable<ReviewCandidate["identifierFamily"]>;
function chosenCandidate(review: IdentityReview, targetProductId: string | undefined): ReviewCandidate | undefined { return targetProductId ? review.decision.candidates.find((candidate) => candidate.productId === targetProductId) : undefined; }
function candidateFamilies(review: IdentityReview): IdentifierFamily[] { return review.decision.candidates.flatMap((candidate) => candidate.identifierFamily ? [candidate.identifierFamily] : []); }
function creationIdentifierFamily(review: IdentityReview): IdentifierFamily | undefined {
  const candidate = candidateFamilies(review)[0];
  if (candidate) return candidate;
  return review.signedRowContext?.identifiers
    .map((identifier) => ({ type: identifier.type, ...(identifier.namespace ? { namespace: identifier.namespace } : {}), value: identifier.normalized }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))[0];
}
function reviewActionResponse(review: IdentityReview): Record<string, unknown> {
  const action = review.reviewAction;
  if (!action) throw new Error("identity_review_action_missing");
  return { review, ...(action.link ? { link: action.link } : {}), ...(action.product ? { product: action.product } : {}), action, ...(action.countResult ? { laterCount: action.countResult } : {}) };
}
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
    if (request.method === "GET") {
      try {
        const requestedBucket = url.searchParams.get("bucket");
        if (requestedBucket && !bucketValues.has(requestedBucket as Bucket)) return json({ error: "Identity review filter was invalid." }, 400);
        const pageSize = positiveInteger(url.searchParams.get("pageSize"), 25, 25);
        let reviewAfter;
        let linkAfter;
        try {
          reviewAfter = decodeReviewCursor(url.searchParams.get("afterReview"), scope, requestedBucket ?? undefined);
          linkAfter = decodeLinkCursor(url.searchParams.get("afterLink"), scope);
        } catch { return json({ error: "Identity review cursor was invalid." }, 400); }
        const all = dependencies.repository.pageIdentityReviews ? undefined : await dependencies.repository.listIdentityReviews(scope);
        const filtered = all?.filter((review) => (!requestedBucket || review.decision.kind === requestedBucket) && (!reviewAfter || review.reviewId.localeCompare(reviewAfter.reviewId) > 0)) ?? [];
        const reviewPage = dependencies.repository.pageIdentityReviews
          ? await dependencies.repository.pageIdentityReviews(scope, { ...(requestedBucket ? { bucket: requestedBucket } : {}), pageSize, ...(reviewAfter ? { after: reviewAfter } : {}) })
          : { items: filtered.slice(0, pageSize), total: all!.filter((review) => !requestedBucket || review.decision.kind === requestedBucket).length, bucketTotals: Object.fromEntries([...bucketValues].map((bucket) => [bucket, all!.filter((review) => review.decision.kind === bucket).length])), nextAfter: filtered.length > pageSize ? { reviewId: filtered[pageSize - 1]!.reviewId } : null };
        const lookups = reviewPage.items.flatMap((review) => review.scope ? candidateFamilies(review).map((family) => ({
          businessId: scope, sourceSystem: review.scope!.sourceSystem, vendorId: review.scope!.vendorId,
          sourceSignature: review.scope!.sourceSignature, identifierType: family.type,
          namespace: family.namespace ?? "", normalizedValue: family.value,
        })) : []);
        const links = dependencies.repository.findCurrentIdentityLinks
          ? await dependencies.repository.findCurrentIdentityLinks(scope, lookups)
          : dependencies.repository.listCurrentIdentityLinks ? await dependencies.repository.listCurrentIdentityLinks(scope) : [];
        const approvedPage = dependencies.pageCurrentApprovedLinks
          ? await dependencies.pageCurrentApprovedLinks(scope, { pageSize, ...(linkAfter ? { after: linkAfter } : {}) })
          : dependencies.currentApprovedLinks
            ? dependencies.currentApprovedLinks(scope).then((items) => { const sorted = [...items].sort((left, right) => left.normalizedValue.localeCompare(right.normalizedValue) || currentLinkFamilyKey(left).localeCompare(currentLinkFamilyKey(right))); const visible = linkAfter ? sorted.filter((item) => item.normalizedValue.localeCompare(linkAfter!.normalizedValue) > 0 || (item.normalizedValue === linkAfter!.normalizedValue && currentLinkFamilyKey(item).localeCompare(linkAfter!.familyKey) > 0)) : sorted; return { items: visible.slice(0, pageSize), total: sorted.length, nextAfter: visible.length > pageSize ? { normalizedValue: visible[pageSize - 1]!.normalizedValue, familyKey: currentLinkFamilyKey(visible[pageSize - 1]!) } : null }; })
            : Promise.resolve({ items: [] as CurrentApprovedIdentityLink[], total: 0, nextAfter: null });
        const approved = await approvedPage;
        const enrich = (review: IdentityReview) => {
          const families = candidateFamilies(review);
          const link = review.scope ? links.find((entry) => entry.status === "approved"
            && entry.sourceSystem === review.scope!.sourceSystem && entry.vendorId === review.scope!.vendorId
            && entry.sourceSignature === review.scope!.sourceSignature && families.some((family) =>
              entry.identifierType === family.type && entry.namespace === (family.namespace ?? "") && entry.normalizedValue === family.value)) : undefined;
          return link ? { ...review, currentApprovedLink: { targetProductId: link.targetProductId, version: link.version } } : review;
        };
        return json({ reviews: reviewPage.items.map(enrich), currentApprovedLinks: approved.items, pageSize, total: reviewPage.total, linkTotal: approved.total, bucketTotals: reviewPage.bucketTotals, nextReviewCursor: reviewPage.nextAfter ? encodeReviewCursor(scope, requestedBucket ?? "", reviewPage.nextAfter) : null, nextLinkCursor: approved.nextAfter ? encodeLinkCursor(scope, approved.nextAfter) : null });
      } catch { return json({ error: "Unable to load identity reviews." }, 500); }
    }
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
    const review = dependencies.repository.getIdentityReview
      ? await dependencies.repository.getIdentityReview(scope, body!.reviewId!)
      : (await dependencies.repository.listIdentityReviews(scope)).find((item) => item.reviewId === body!.reviewId);
    if (!review) return json({ error: "Identity review was not found." }, 404);
    const actionId = request.headers.get("Idempotency-Key") ?? `review:${review.reviewId}:${body.action}`;
    const payloadFingerprint = await canonicalSha256({ reviewId: review.reviewId, action: body.action, targetProductId: body.targetProductId ?? "", name: body.name?.trim() ?? "" });
    // Durable replay authority comes before every freshness/model read. A retry must not be
    // invalidated by catalog/link changes after the original committed decision.
    if (review.reviewAction) {
      if (review.reviewAction.actionId !== actionId || review.reviewAction.payloadFingerprint !== payloadFingerprint) {
        return json({ error: "The identity review changed before this action could be applied." }, 409);
      }
      if (dependencies.atomicReviewApply && review.resolution) {
        const replay = await dependencies.atomicReviewApply({ businessId: scope, reviewId: review.reviewId, actionId, payloadFingerprint, action: body.action, resolution: review.resolution, resolvedBy: actor.actorId });
        if (replay.kind === "stale" || replay.kind === "idempotency_conflict") return json({ error: "The identity review changed before this action could be applied." }, 409);
        if (replay.kind !== "applied" && replay.kind !== "replayed") throw new Error("invalid_atomic_review_result");
        return json(reviewActionResponse(replay.review));
      }
      return json(reviewActionResponse(review));
    }
    const apply = async (resolution: NonNullable<IdentityReview["resolution"]>, link?: IdentityLink, product?: TenantIdentityProduct) => {
      if (dependencies.repository.applyReviewAction) return dependencies.repository.applyReviewAction({ businessId: scope, reviewId: review.reviewId, actionId, payloadFingerprint, action: body!.action, resolution, resolvedBy: actor.actorId, ...(link ? { link } : {}), ...(product ? { product } : {}) });
      if (product) await dependencies.repository.createTenantProduct?.(product); if (link) await dependencies.repository.saveIdentityLink?.(link);
      return { review: await dependencies.repository.resolveIdentityReview!(scope, review.reviewId, resolution, actor.actorId, new Date().toISOString()), ...(link ? { link } : {}), ...(product ? { product } : {}) };
    };
    const countLaterApproval = async (targetProductId: string, applied: Record<string, unknown>) => {
      const context = review.signedRowContext;
      if (!context || context.mode !== "physical_count") return json(applied);
      if (!dependencies.atomicCountedRow || !review.scope) throw new Error("review_counting_unavailable");
      const countRowId = `review-count:${review.reviewId}`;
      const event = await createAggregateImportEvent({
        businessId: scope, importId: review.importId, rowId: countRowId, sessionId: context.sessionId,
        quantity: context.quantity, sourceFileOrdinal: context.sourceFileOrdinal, sheetName: context.sheetName,
        sourceRowNumber: context.sourceRowNumber, createdAt: context.eventCreatedAt, mode: "physical_count",
        decision: { kind: "review", approvedProductId: targetProductId },
      });
      const operationFingerprint = await canonicalSha256({ reviewId: review.reviewId, payloadFingerprint, eventFingerprint: event.fingerprint });
      const row = { quantity: context.quantity, unitOfMeasure: context.unitOfMeasure, sourceFileOrdinal: context.sourceFileOrdinal, sheetName: context.sheetName, sourceRowNumber: context.sourceRowNumber, identifiers: context.identifiers };
      const atomic = await dependencies.atomicCountedRow({
        validation: { businessId: scope, sourceSystem: review.scope.sourceSystem, sourceSignature: review.scope.sourceSignature, vendorId: review.scope.vendorId, targetProductId, identifiers: context.identifiers, row, decision: review.decision, corrected: true },
        operation: { businessId: scope, importId: review.importId, rowId: countRowId, idempotencyKey: `identity-review-count:${review.reviewId}`, payloadFingerprint: await canonicalSha256({ payloadFingerprint, eventFingerprint: event.fingerprint }) },
        event, operationFingerprint,
        result: { row: { rowId: review.rowId, status: "counted", eventId: event.eventId, audit: { action: "counted", sourceQuantity: context.quantity, targetProductId, decisionKind: "review", decisionFingerprint: review.decision.decisionFingerprint, evidenceSnapshot: review.decision.decisionBasis, constraintSnapshot: review.decision.constraintOutcomes } } },
      });
      if (atomic.kind === "stale") return json({ error: "The selected target is stale or no longer supported by its exact identifier." }, 409);
      if (atomic.kind === "in_progress") return json({ error: "The approved row count is still being applied." }, 409);
      if (atomic.kind === "idempotency_conflict") return json({ error: "The approved row count conflicts with an earlier action." }, 409);
      return json({ ...applied, laterCount: { kind: atomic.kind, eventId: atomic.event.eventId, quantity: atomic.event.quantity } });
    };
    const applyAtomically = async (resolution: NonNullable<IdentityReview["resolution"]>, targetProductId?: string, link?: IdentityLink, product?: TenantIdentityProduct, configuredCurrentLink?: LocalAtomicReviewCountedApplyInput["configuredCurrentLink"], revalidate?: LocalAtomicReviewCountedApplyInput["revalidate"]): Promise<NextResponse | undefined> => {
      if (!dependencies.atomicReviewApply) return undefined;
      let count: LocalAtomicReviewCountedApplyInput["count"];
      const context = review.signedRowContext;
      if (targetProductId && context?.mode === "physical_count" && (body!.action === "confirm_candidate" || body!.action === "create_tenant_product")) {
        if (!review.scope) throw new Error("review_counting_unavailable");
        const countRowId = `review-count:${review.reviewId}`;
        const event = await createAggregateImportEvent({ businessId: scope, importId: review.importId, rowId: countRowId, sessionId: context.sessionId, quantity: context.quantity, sourceFileOrdinal: context.sourceFileOrdinal, sheetName: context.sheetName, sourceRowNumber: context.sourceRowNumber, createdAt: context.eventCreatedAt, mode: "physical_count", decision: { kind: "review", approvedProductId: targetProductId } });
        const operationFingerprint = await canonicalSha256({ reviewId: review.reviewId, payloadFingerprint, eventFingerprint: event.fingerprint });
        count = { event, operationFingerprint, operationIdempotencyKey: `identity-review-count:${review.reviewId}`, result: { row: { rowId: review.rowId, status: "counted", eventId: event.eventId, audit: { action: "counted", sourceQuantity: context.quantity, targetProductId, decisionKind: "review", decisionFingerprint: review.decision.decisionFingerprint, evidenceSnapshot: review.decision.decisionBasis, constraintSnapshot: review.decision.constraintOutcomes } } } };
      }
      const atomic = await dependencies.atomicReviewApply({ businessId: scope, reviewId: review.reviewId, actionId, payloadFingerprint, action: body!.action, resolution, resolvedBy: actor.actorId, ...(targetProductId ? { targetProductId } : {}), ...(link ? { link } : {}), ...(product ? { product } : {}), ...(count ? { count } : {}), ...(configuredCurrentLink ? { configuredCurrentLink } : {}), ...(revalidate ? { revalidate } : {}) });
      if (atomic.kind === "stale") return json({ error: "The selected target is stale or no longer supported by its exact identifier." }, 409);
      if (atomic.kind === "idempotency_conflict") return json({ error: "The identity review changed before this action could be applied." }, 409);
      if (atomic.kind !== "applied" && atomic.kind !== "replayed") throw new Error("invalid_atomic_review_result");
      return json(reviewActionResponse(atomic.review));
    };
    if (body.action === "reject") return (await applyAtomically("rejected")) ?? json(await apply("rejected"));
    if (body.action === "create_tenant_product") {
      const name = body.name?.trim(); if (!name || name.length > 200) return json({ error: "A tenant product name is required." }, 400);
      const product: TenantIdentityProduct = { productId: `tenant:${randomUUID()}`, businessId: scope, name, createdBy: actor.actorId, createdAt: new Date().toISOString() };
      const key = creationIdentifierFamily(review); if (!key || !review.scope) return json({ error: "The review has no durable identifier." }, 409);
      const configured = dependencies.configuredModel ? await dependencies.configuredModel() : undefined;
      const configuredMatches = configured ? await configured.lookupApprovedLinks({ businessId: scope, sourceSystem: review.scope.sourceSystem, sourceSignature: review.scope.sourceSignature, vendorId: review.scope.vendorId, identifiers: [{ type: key.type, raw: key.value, normalized: key.value, ...(key.namespace ? { namespace: key.namespace } : {}), source: "review", evidenceAuthority: "vendor_import", evidenceId: review.reviewId, evidenceVersion: review.decision.decisionFingerprint }] }) : [];
      const configuredCurrentLink = configuredMatches.find((item) => item.status === "approved" && item.identifierType === key.type && item.namespace === (key.namespace ?? "") && item.normalizedValue === key.value);
      const versions = await dependencies.currentVersions(scope); const link: IdentityLink = { businessId: scope, sourceSystem: review.scope.sourceSystem, vendorId: review.scope.vendorId, sourceSignature: review.scope.sourceSignature, identifierType: key.type, namespace: key.namespace ?? "", rawValue: key.value, normalizedValue: key.value, targetProductId: product.productId, status: "approved", evidence: [...review.decision.decisionBasis.map((basis) => basis.evidenceId), `catalog:${versions.catalogVersion}`, `links:${versions.linkVersion}`, `review:${review.reviewId}`], createdBy: actor.actorId, createdAt: new Date().toISOString(), approvedBy: actor.actorId, approvedAt: new Date().toISOString(), version: 1 };
      const atomic = await applyAtomically("create_product", product.productId, link, product, configuredCurrentLink); if (atomic) return atomic;
      const applied = await apply("create_product", link, product);
      return countLaterApproval(product.productId, applied as Record<string, unknown>);
    }
    const candidate = chosenCandidate(review, body.targetProductId);
    if (!candidate || !review.scope) return json({ error: "The selected candidate is not available for this review." }, 409);
    const targetProductId = candidate.productId;
    const key = candidate.identifierFamily; if (!key) return json({ error: "The review has no durable candidate identifier." }, 409);
    const model = dependencies.configuredModel ? await dependencies.configuredModel() : dependencies.currentModel ? await dependencies.currentModel() : undefined;
    const targetInput = { businessId: scope, sourceSystem: review.scope.sourceSystem, sourceSignature: review.scope.sourceSignature, vendorId: review.scope.vendorId, targetProductId, identifiers: [{ type: key.type, raw: key.value, normalized: key.value, namespace: key.namespace, source: "review" as const, evidenceAuthority: "vendor_import" as const, evidenceId: review.reviewId, evidenceVersion: review.decision.decisionFingerprint }] };
    const configuredTargetIsCurrent = Boolean(model && await model.hasCurrentTarget(targetInput));
    if (!dependencies.atomicReviewApply && (dependencies.configuredModel || dependencies.currentModel) && !configuredTargetIsCurrent) return json({ error: "The selected target is stale or no longer supported by its exact identifier." }, 409);
    const versions = await dependencies.currentVersions(scope);
    if (!dependencies.atomicReviewApply && body.action !== "revoke_link" && dependencies.repository.listCurrentIdentityLinks) {
      const current = (await dependencies.repository.listCurrentIdentityLinks(scope)).find((link) => link.sourceSystem === review.scope!.sourceSystem && link.vendorId === review.scope!.vendorId && link.sourceSignature === review.scope!.sourceSignature && link.identifierType === key.type && link.namespace === (key.namespace ?? "") && link.normalizedValue === key.value);
      if (current?.status === "approved" && current.targetProductId !== targetProductId) return json({ error: "The approved identity link is no longer current." }, 409);
    }
    if (!dependencies.atomicReviewApply && body.action === "revoke_link" && dependencies.repository.listCurrentIdentityLinks) {
      const current = (await dependencies.repository.listCurrentIdentityLinks(scope)).find((link) => link.sourceSystem === review.scope!.sourceSystem && link.vendorId === review.scope!.vendorId && link.sourceSignature === review.scope!.sourceSignature && link.identifierType === key.type && link.namespace === (key.namespace ?? "") && link.normalizedValue === key.value);
      if (!current || current.status !== "approved" || current.targetProductId !== targetProductId) return json({ error: "The approved identity link is no longer current." }, 409);
    }
    const link: IdentityLink = { businessId: scope, sourceSystem: review.scope.sourceSystem, vendorId: review.scope.vendorId, sourceSignature: review.scope.sourceSignature, identifierType: key.type, namespace: key.namespace ?? "", rawValue: key.value, normalizedValue: key.value, targetProductId, status: body.action === "revoke_link" ? "revoked" : "approved", evidence: [...review.decision.decisionBasis.map((basis) => basis.evidenceId), `catalog:${versions.catalogVersion}`, `links:${versions.linkVersion}`, `review:${review.reviewId}`], createdBy: actor.actorId, createdAt: new Date().toISOString(), ...(body.action === "confirm_candidate" ? { approvedBy: actor.actorId, approvedAt: new Date().toISOString() } : {}), version: 0 };
    const configuredMatches = model ? await model.lookupApprovedLinks({ businessId: scope, sourceSystem: review.scope.sourceSystem, sourceSignature: review.scope.sourceSignature, vendorId: review.scope.vendorId, identifiers: [{ type: key.type, raw: key.value, normalized: key.value, ...(key.namespace ? { namespace: key.namespace } : {}), source: "review", evidenceAuthority: "vendor_import", evidenceId: review.reviewId, evidenceVersion: review.decision.decisionFingerprint }] }) : [];
    const configuredCurrentLink = configuredMatches.find((item) => item.status === "approved" && item.identifierType === key.type && item.namespace === (key.namespace ?? "") && item.normalizedValue === key.value);
    const revalidate: LocalAtomicReviewCountedApplyInput["revalidate"] = async (transaction) => {
      const durable = ((await transaction.get<IdentityLink[]>("identity-links")) ?? []).filter((item) => item.businessId === scope && item.sourceSystem === review.scope!.sourceSystem && item.vendorId === review.scope!.vendorId && item.sourceSignature === review.scope!.sourceSignature && item.identifierType === key.type && item.namespace === (key.namespace ?? "") && item.normalizedValue === key.value).sort((left, right) => right.version - left.version)[0];
      if (durable) {
        if (durable.status !== "approved" || durable.targetProductId !== targetProductId) return false;
        if (configuredTargetIsCurrent) return true;
        return ((await transaction.get<TenantIdentityProduct[]>("identity-tenant-products")) ?? []).some((item) => item.businessId === scope && item.productId === targetProductId);
      }
      return body!.action === "revoke_link" ? configuredCurrentLink?.targetProductId === targetProductId : configuredTargetIsCurrent;
    };
    const atomic = await applyAtomically(body.action === "revoke_link" ? "rejected" : "confirmed", targetProductId, link, undefined, configuredCurrentLink, revalidate); if (atomic) return atomic;
    const applied = await apply(body.action === "revoke_link" ? "rejected" : "confirmed", link);
    return body.action === "confirm_candidate" ? countLaterApproval(targetProductId, applied as Record<string, unknown>) : json(applied);
    } catch (error) { if (error instanceof Error && /identity_(?:review_(?:action_conflict|terminal|revoke_conflict|target_conflict)|link_revoke_conflict)/.test(error.message)) return json({ error: "The identity review changed before this action could be applied." }, 409); return json({ error: "Unable to update identity review." }, 500); }
  };
}

async function defaultCurrentApprovedLinks(businessId: string): Promise<CurrentApprovedIdentityLink[]> { const model = await defaultModel(); return model?.listCurrentApprovedLinks ? model.listCurrentApprovedLinks(businessId) : []; }
async function defaultPageCurrentApprovedLinks(businessId: string, input: { pageSize: number; after?: { normalizedValue: string; familyKey: string } }) { const model = await defaultModel(); if (!model?.pageCurrentApprovedLinks) return { items: [] as CurrentApprovedIdentityLink[], total: 0, nextAfter: null }; return model.pageCurrentApprovedLinks(businessId, input); }
export const defaultIdentityReviewRoute = createIdentityReviewRoute({ enabled: isLocalIdentityApplyEnabled, authorize: async (_request, businessId) => actorFromEnvironment(businessId), repository: defaultRepository, currentVersions: defaultVersions, currentModel: defaultModel, configuredModel: loadConfiguredLocalIdentityReadModel, currentApprovedLinks: defaultCurrentApprovedLinks, pageCurrentApprovedLinks: defaultPageCurrentApprovedLinks, atomicCountedRow: defaultAtomicCountedRow, atomicReviewApply: defaultAtomicReviewApply });
