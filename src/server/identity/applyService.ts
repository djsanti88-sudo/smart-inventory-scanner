import "server-only";

import { canonicalSha256 } from "@/services/identity/canonical";
import { createAggregateImportEvent } from "@/services/identity/importLedger";
import type { PreviewVerificationExpectation, SignedPreviewChunk } from "@/services/identity/preview";
import type { AggregateLedgerPort, IdentityDecision, ImportRun } from "@/services/identity/types";
import type { ImportOperationClaim, LocalIdentityRepository } from "./localRepository";

type Role = "owner" | "admin" | "counter" | "viewer";
type Mode = "physical_count" | "reconcile";
export interface ApplyCorrection { rowId: string; targetProductId: string; businessId?: string; }
export interface ApplyIdentityImportInput { signedPayloads: string[]; mode: Mode; corrections: ApplyCorrection[]; }
export interface ApplyActor { actorId: string; businessId: string; role: Role; }
export interface ApplySource { versions: PreviewVerificationExpectation["versions"]; validateCorrectionTarget?: (input: { businessId: string; targetProductId: string }) => Promise<boolean>; }
type ApplyRepository = {
  createImportRun: (...args: Parameters<LocalIdentityRepository["createImportRun"]>) => Promise<unknown>;
  getImportRun?: (...args: Parameters<LocalIdentityRepository["getImportRun"]>) => Promise<ImportRun | undefined>;
  transitionImportRun: (...args: Parameters<LocalIdentityRepository["transitionImportRun"]>) => Promise<unknown>;
  claimImportOperation: (...args: Parameters<LocalIdentityRepository["claimImportOperation"]>) => Promise<unknown>;
  completeImportOperation: (...args: Parameters<LocalIdentityRepository["completeImportOperation"]>) => Promise<unknown>;
};
export interface ApplyDependencies {
  repository: ApplyRepository;
  verifier: (payloads: string[], now: string, expected: PreviewVerificationExpectation) => Promise<SignedPreviewChunk[]>;
  source: ApplySource; ledger: Pick<AggregateLedgerPort, "applyOnce" | "findByIdempotencyKey">; clock: () => string; actor: ApplyActor;
}
export interface ApplyResult { importId: string; mode: Mode; countedRows: number; countQuantity: number; rows: Array<{ rowId: string; status: "counted" | "reconciled" | "not_counted"; eventId?: string }>; }
type ApplyDecision = IdentityDecision & { approvedProductId?: string };
type RowApplyResult = { row: ApplyResult["rows"][number] };

function isAdmin(actor: ApplyActor): boolean { return actor.role === "owner" || actor.role === "admin"; }
function correctionMap(corrections: ApplyCorrection[], chunk: SignedPreviewChunk): Map<string, ApplyCorrection> {
  const ids = new Set(chunk.rowIds); const result = new Map<string, ApplyCorrection>();
  for (const correction of corrections) {
    if (!correction || typeof correction.rowId !== "string" || typeof correction.targetProductId !== "string" || !correction.rowId || !correction.targetProductId || correction.businessId !== undefined && correction.businessId !== chunk.scope.businessId) throw new Error("apply_correction_scope_invalid");
    if (!ids.has(correction.rowId) || result.has(correction.rowId)) throw new Error("apply_correction_invalid");
    result.set(correction.rowId, correction);
  }
  return result;
}
function rowResultFrom(value: unknown): ApplyResult["rows"][number] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = (value as Partial<RowApplyResult>).row;
  return row && typeof row.rowId === "string" && (row.status === "counted" || row.status === "reconciled" || row.status === "not_counted") ? row : undefined;
}

/** Server-only durable apply. Preview tokens are verified before run/operation/ledger mutation. */
export async function applyIdentityImport(input: ApplyIdentityImportInput, dependencies: ApplyDependencies): Promise<ApplyResult> {
  if (!isAdmin(dependencies.actor)) throw new Error("apply_forbidden");
  if (!Array.isArray(input.signedPayloads) || input.signedPayloads.length === 0 || !Array.isArray(input.corrections) || (input.mode !== "physical_count" && input.mode !== "reconcile")) throw new Error("apply_request_invalid");
  const chunks = await dependencies.verifier(input.signedPayloads, dependencies.clock(), { actorId: dependencies.actor.actorId, businessId: dependencies.actor.businessId, versions: dependencies.source.versions });
  const first = chunks[0];
  if (!first) throw new Error("apply_preview_invalid");
  const allRowIds = chunks.flatMap((chunk) => chunk.rowIds);
  const combined = { ...first, rowIds: allRowIds };
  const corrections = correctionMap(input.corrections, combined);
  if (dependencies.source.validateCorrectionTarget) for (const correction of corrections.values()) if (!(await dependencies.source.validateCorrectionTarget({ businessId: first.scope.businessId, targetProductId: correction.targetProductId }))) throw new Error("apply_correction_target_invalid");
  const operationFingerprint = await canonicalSha256({ previewFingerprint: first.previewFingerprint, mode: input.mode, corrections: [...corrections.values()].sort((a, b) => a.rowId.localeCompare(b.rowId)) });
  const proposedRun = { importId: first.importId, businessId: first.scope.businessId, sourceFingerprint: first.sanitizedContentRootHash, mappingFingerprint: await canonicalSha256(first.orderedMappings), previewFingerprint: first.previewFingerprint, actorId: dependencies.actor.actorId, engineVersion: first.versions.engineVersion, pluginVersion: first.versions.pluginVersions.join(","), catalogVersion: first.versions.catalogVersion, createdAt: dependencies.clock() };
  const existing = await dependencies.repository.getImportRun?.(proposedRun.businessId, proposedRun.importId);
  if (!existing) await dependencies.repository.createImportRun(proposedRun);
  const run = existing ?? proposedRun;
  if (!existing || existing.state === "previewed" || existing.state === "failed") await dependencies.repository.transitionImportRun(run.businessId, run.importId, "applying");
  const rows: ApplyResult["rows"] = [];
  const allRows = chunks.flatMap((chunk) => chunk.rows), allDecisions = chunks.flatMap((chunk) => chunk.decisions);
  for (let index = 0; index < allRowIds.length; index += 1) {
    const rowId = allRowIds[index]!; const row = allRows[index] as Record<string, unknown>; const original = allDecisions[index]!;
    const correction = corrections.get(rowId); const decision: ApplyDecision = correction ? { ...original, kind: "review", approvedProductId: correction.targetProductId } : original;
    // Never serialize undefined correction fields into the durable idempotency projection.
    const decisionProjection = decision.kind === "review" && correction
      ? { ...decision, approvedProductId: correction.targetProductId }
      : { ...decision };
    if (decisionProjection.kind === "review") delete (decisionProjection as { targetProductId?: string }).targetProductId;
    const payloadFingerprint = await canonicalSha256({ operationFingerprint, rowId, decision: decisionProjection });
    const claim = await dependencies.repository.claimImportOperation({ businessId: run.businessId, importId: run.importId, rowId, idempotencyKey: `identity-apply:${rowId}`, payloadFingerprint }, 60_000) as ImportOperationClaim;
    if (claim.kind === "completed") { const completed = rowResultFrom(claim.result); if (!completed) throw new Error("apply_recovery_invalid"); rows.push(completed); continue; }
    if (claim.kind === "in_progress") throw new Error("apply_in_progress");
    if (claim.kind === "idempotency_conflict" || claim.kind === "terminal") throw new Error("apply_idempotency_conflict");
    let rowResult: ApplyResult["rows"][number] = { rowId, status: input.mode === "reconcile" ? "reconciled" : "not_counted" };
    if (input.mode === "physical_count" && (decision.kind === "automatic" || decision.kind === "review" && decision.approvedProductId)) {
      // The run's original timestamp is part of the aggregate-event fingerprint; retries must not
      // turn a recovered post-ledger crash into a conflicting new event.
      const event = await createAggregateImportEvent({ businessId: run.businessId, importId: run.importId, rowId, sessionId: `identity-import:${run.importId}`, quantity: Number(row.quantity), sourceFileOrdinal: Number(row.sourceFileOrdinal), sheetName: String(row.sheetName), sourceRowNumber: Number(row.sourceRowNumber), createdAt: run.createdAt, mode: "physical_count", decision: decision.kind === "automatic" ? { kind: "automatic", targetProductId: decision.targetProductId! } : { kind: "review", approvedProductId: decision.approvedProductId! } });
      const recovered = await dependencies.ledger.findByIdempotencyKey({ businessId: run.businessId, idempotencyKey: event.idempotencyKey, expectedFingerprint: event.fingerprint });
      const stored = recovered ?? await dependencies.ledger.applyOnce(event, event.idempotencyKey);
      if (!("event" in stored)) throw new Error("apply_ledger_conflict");
      rowResult = { rowId, status: "counted", eventId: stored.event.eventId };
    }
    await dependencies.repository.completeImportOperation(claim.operation, claim.leaseId, { row: rowResult } satisfies RowApplyResult);
    rows.push(rowResult);
  }
  const result: ApplyResult = { importId: run.importId, mode: input.mode, countedRows: rows.filter((row) => row.status === "counted").length, countQuantity: rows.filter((row) => row.status === "counted").reduce((sum, row) => sum + (row.status === "counted" ? Number((allRows[allRowIds.indexOf(row.rowId)] as Record<string, unknown>).quantity) : 0), 0), rows };
  return result;
}
