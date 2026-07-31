import "server-only";

import { canonicalSha256 } from "@/services/identity/canonical";
import { createAggregateImportEvent } from "@/services/identity/importLedger";
import type { PreviewVerificationExpectation, SignedPreviewChunk } from "@/services/identity/preview";
import type { AggregateLedgerPort, ExpectedInventorySession, IdentityDecision, ImportRun } from "@/services/identity/types";
import type { ImportOperationClaim, LocalIdentityRepository } from "./localRepository";

type Role = "owner" | "admin" | "counter" | "viewer";
type Mode = "physical_count" | "reconcile";
export interface ApplyCorrection { rowId: string; targetProductId: string; businessId?: string; }
export interface ApplyIdentityImportInput { signedPayloads: string[]; mode: Mode; corrections: ApplyCorrection[]; }
export interface ApplyActor { actorId: string; businessId: string; role: Role; }
/** A concrete server-owned read model. It must reject missing, cross-tenant, revoked, or stale targets. */
export interface ApplySource {
  versions: PreviewVerificationExpectation["versions"];
  revalidateCountableTarget?: (input: { businessId: string; targetProductId: string; row: Record<string, unknown>; decision: IdentityDecision; corrected: boolean }) => Promise<boolean>;
}
type ApplyRepository = {
  createImportRun: (...args: Parameters<LocalIdentityRepository["createImportRun"]>) => Promise<unknown>;
  getImportRun?: (...args: Parameters<LocalIdentityRepository["getImportRun"]>) => Promise<ImportRun | undefined>;
  transitionImportRun: (...args: Parameters<LocalIdentityRepository["transitionImportRun"]>) => Promise<unknown>;
  completeImportRun?: (...args: Parameters<LocalIdentityRepository["completeImportRun"]>) => Promise<unknown>;
  saveExpectedInventorySession?: (...args: Parameters<LocalIdentityRepository["saveExpectedInventorySession"]>) => Promise<unknown>;
  claimImportOperation: (...args: Parameters<LocalIdentityRepository["claimImportOperation"]>) => Promise<unknown>;
  completeImportOperation: (...args: Parameters<LocalIdentityRepository["completeImportOperation"]>) => Promise<unknown>;
};
export interface ApplyDependencies {
  repository: ApplyRepository;
  verifier: (payloads: string[], now: string, expected: PreviewVerificationExpectation) => Promise<SignedPreviewChunk[]>;
  source: ApplySource; ledger: Pick<AggregateLedgerPort, "applyOnce" | "findByIdempotencyKey">; clock: () => string; actor: ApplyActor;
}
export interface ApplyAuditRecord { action: "counted" | "reconciled" | "not_counted"; sourceQuantity: number; targetProductId?: string; decisionKind: IdentityDecision["kind"]; correctionTargetProductId?: string; }
export interface ApplyResult { importId: string; mode: Mode; countedRows: number; countQuantity: number; rows: Array<{ rowId: string; status: "counted" | "reconciled" | "not_counted"; eventId?: string; audit: ApplyAuditRecord }>; reconciliation?: { expectedRows: number; expectedQuantity: number; currentInventoryStatus: "unavailable"; varianceQuantity: null }; }
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
  return row && typeof row.rowId === "string" && (row.status === "counted" || row.status === "reconciled" || row.status === "not_counted") && Boolean(row.audit) ? row : undefined;
}

type PreflightRow = { rowId: string; row: Record<string, unknown>; decision: ApplyDecision; correction?: ApplyCorrection };

async function preflightRows(chunks: SignedPreviewChunk[], input: ApplyIdentityImportInput, source: ApplySource, corrections: Map<string, ApplyCorrection>): Promise<PreflightRow[]> {
  const rowIds = chunks.flatMap((chunk) => chunk.rowIds);
  const rows = chunks.flatMap((chunk) => chunk.rows);
  const decisions = chunks.flatMap((chunk) => chunk.decisions);
  if (rowIds.length !== rows.length || rows.length !== decisions.length || new Set(rowIds).size !== rowIds.length) throw new Error("apply_row_id_duplicate");
  const preflight: PreflightRow[] = [];
  for (let index = 0; index < rowIds.length; index += 1) {
    const rowId = rowIds[index]!, row = rows[index]; const original = decisions[index];
    if (!row || typeof row !== "object" || Array.isArray(row) || !original || typeof original !== "object") throw new Error("apply_row_invalid");
    const record = row as Record<string, unknown>, quantity = record.quantity;
    if (!Number.isSafeInteger(quantity) || (quantity as number) < 0 || !Number.isSafeInteger(record.sourceFileOrdinal) || typeof record.sheetName !== "string" || !record.sheetName || !Number.isSafeInteger(record.sourceRowNumber) || (record.sourceRowNumber as number) < 1) throw new Error("apply_row_invalid");
    const correction = corrections.get(rowId);
    const decision: ApplyDecision = correction ? { ...original, kind: "review", approvedProductId: correction.targetProductId } : original;
    const targetProductId = decision.kind === "automatic" ? decision.targetProductId : decision.kind === "review" ? decision.approvedProductId : undefined;
    if (input.mode === "physical_count" && targetProductId) {
      if (!source.revalidateCountableTarget) throw new Error("apply_source_unavailable");
      if (!await source.revalidateCountableTarget({ businessId: chunks[0]!.scope.businessId, targetProductId, row: record, decision: original, corrected: Boolean(correction) })) throw new Error(correction ? "apply_correction_target_invalid" : "apply_target_stale");
    }
    preflight.push({ rowId, row: record, decision, correction });
  }
  return preflight;
}

/** Server-only durable apply. Preview tokens are verified before run/operation/ledger mutation. */
export async function applyIdentityImport(input: ApplyIdentityImportInput, dependencies: ApplyDependencies): Promise<ApplyResult> {
  if (!isAdmin(dependencies.actor)) throw new Error("apply_forbidden");
  if (!Array.isArray(input.signedPayloads) || input.signedPayloads.length === 0 || input.signedPayloads.length > 64 || !Array.isArray(input.corrections) || input.corrections.length > 5_000 || (input.mode !== "physical_count" && input.mode !== "reconcile")) throw new Error("apply_request_invalid");
  const chunks = await dependencies.verifier(input.signedPayloads, dependencies.clock(), { actorId: dependencies.actor.actorId, businessId: dependencies.actor.businessId, versions: dependencies.source.versions });
  const first = chunks[0];
  if (!first) throw new Error("apply_preview_invalid");
  const allRowIds = chunks.flatMap((chunk) => chunk.rowIds);
  const combined = { ...first, rowIds: allRowIds };
  const corrections = correctionMap(input.corrections, combined);
  const preflight = await preflightRows(chunks, input, dependencies.source, corrections);
  const operationFingerprint = await canonicalSha256({ previewFingerprint: first.previewFingerprint, mode: input.mode, corrections: [...corrections.values()].sort((a, b) => a.rowId.localeCompare(b.rowId)) });
  const prior = await dependencies.repository.getImportRun?.(first.scope.businessId, first.importId);
  if (prior?.state === "invalidated") throw new Error("apply_preview_invalidated");
  const createdAt = prior?.createdAt ?? dependencies.clock();
  const proposedRun = { importId: first.importId, businessId: first.scope.businessId, sourceFingerprint: first.sanitizedContentRootHash, mappingFingerprint: await canonicalSha256(first.orderedMappings), previewFingerprint: first.previewFingerprint, actorId: dependencies.actor.actorId, engineVersion: first.versions.engineVersion, pluginVersion: first.versions.pluginVersions.join(","), catalogVersion: first.versions.catalogVersion, operationFingerprint, createdAt };
  let created: ImportRun;
  try { created = await dependencies.repository.createImportRun(proposedRun) as ImportRun; }
  catch (error) { if (error instanceof Error && /idempotency conflict/i.test(error.message)) throw new Error("apply_idempotency_conflict"); throw error; }
  const run = created;
  if (run.state === "completed") {
    const stored = run.result as ApplyResult | undefined;
    if (!stored || stored.importId !== run.importId || stored.mode !== input.mode) throw new Error("apply_idempotency_conflict");
    return stored;
  }
  if (run.state === "previewed" || run.state === "failed") await dependencies.repository.transitionImportRun(run.businessId, run.importId, "applying");
  const events = new Map<string, Awaited<ReturnType<typeof createAggregateImportEvent>>>();
  if (input.mode === "physical_count") for (const item of preflight) {
    const targetProductId = item.decision.kind === "automatic" ? item.decision.targetProductId : item.decision.kind === "review" ? item.decision.approvedProductId : undefined;
    if (targetProductId) events.set(item.rowId, await createAggregateImportEvent({ businessId: run.businessId, importId: run.importId, rowId: item.rowId, sessionId: `identity-import:${run.importId}`, quantity: item.row.quantity as number, sourceFileOrdinal: item.row.sourceFileOrdinal as number, sheetName: item.row.sheetName as string, sourceRowNumber: item.row.sourceRowNumber as number, createdAt: run.createdAt, mode: "physical_count", decision: item.decision.kind === "automatic" ? { kind: "automatic", targetProductId } : { kind: "review", approvedProductId: targetProductId } }));
  }
  const rows: ApplyResult["rows"] = [];
  const allRows = preflight.map((item) => item.row);
  for (const item of preflight) {
    const { rowId, row, decision, correction } = item;
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
    const targetProductId = decision.kind === "automatic" ? decision.targetProductId : decision.kind === "review" ? decision.approvedProductId : undefined;
    let rowResult: ApplyResult["rows"][number] = { rowId, status: input.mode === "reconcile" ? "reconciled" : "not_counted", audit: { action: input.mode === "reconcile" ? "reconciled" : "not_counted", sourceQuantity: row.quantity as number, ...(targetProductId ? { targetProductId } : {}), decisionKind: decision.kind, ...(correction ? { correctionTargetProductId: correction.targetProductId } : {}) } };
    if (input.mode === "physical_count" && (decision.kind === "automatic" || decision.kind === "review" && decision.approvedProductId)) {
      // The run's original timestamp is part of the aggregate-event fingerprint; retries must not
      // turn a recovered post-ledger crash into a conflicting new event.
      const event = events.get(rowId)!;
      const recovered = await dependencies.ledger.findByIdempotencyKey({ businessId: run.businessId, idempotencyKey: event.idempotencyKey, expectedFingerprint: event.fingerprint });
      const stored = recovered ?? await dependencies.ledger.applyOnce(event, event.idempotencyKey);
      if (!("event" in stored)) throw new Error("apply_ledger_conflict");
      rowResult = { rowId, status: "counted", eventId: stored.event.eventId, audit: { action: "counted", sourceQuantity: row.quantity as number, targetProductId: stored.event.productId, decisionKind: decision.kind, ...(correction ? { correctionTargetProductId: correction.targetProductId } : {}) } };
    }
    await dependencies.repository.completeImportOperation(claim.operation, claim.leaseId, { row: rowResult } satisfies RowApplyResult);
    rows.push(rowResult);
  }
  const result: ApplyResult = { importId: run.importId, mode: input.mode, countedRows: rows.filter((row) => row.status === "counted").length, countQuantity: rows.filter((row) => row.status === "counted").reduce((sum, row) => sum + (row.status === "counted" ? Number((allRows[allRowIds.indexOf(row.rowId)] as Record<string, unknown>).quantity) : 0), 0), rows, ...(input.mode === "reconcile" ? { reconciliation: { expectedRows: rows.length, expectedQuantity: rows.reduce((sum, row) => sum + row.audit.sourceQuantity, 0), currentInventoryStatus: "unavailable" as const, varianceQuantity: null } } : {}) };
  if (input.mode === "reconcile" && dependencies.repository.saveExpectedInventorySession) {
    const session: ExpectedInventorySession = { importId: run.importId, businessId: run.businessId, sourceEvidenceSnapshot: run.sourceFingerprint, rows: rows.map((row) => ({ rowId: row.rowId, ...(row.audit.targetProductId ? { targetProductId: row.audit.targetProductId } : {}), expectedQuantity: row.audit.sourceQuantity, currentQuantity: null, varianceQuantity: null, status: "unavailable", ...(row.audit.correctionTargetProductId ? { correctionTargetProductId: row.audit.correctionTargetProductId } : {}) })) };
    await dependencies.repository.saveExpectedInventorySession(session);
  }
  if (dependencies.repository.completeImportRun) await dependencies.repository.completeImportRun(run.businessId, run.importId, result);
  else await dependencies.repository.transitionImportRun(run.businessId, run.importId, "completed");
  return result;
}
