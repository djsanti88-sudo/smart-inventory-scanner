import "server-only";

import { NextResponse } from "next/server";
import type { ApplyActor, ApplyIdentityImportInput, ApplyResult } from "@/server/identity/applyService";
import { applyComposedIdentityImport, authorizeLocalIdentityApply, isLocalIdentityApplyEnabled } from "@/server/identity/applyComposition";

function json(body: unknown, status: number): NextResponse { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
const maxApplyBodyBytes = 32 * 1024 * 1024;
async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxApplyBodyBytes) { await reader.cancel("apply_body_too_large"); throw new Error("apply_body_too_large"); } parts.push(next.value); } }
  finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0; for (const part of parts) { body.set(part, offset); offset += part.byteLength; } return body;
}
function request(value: unknown): value is ApplyIdentityImportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every((key) => key === "signedPayloads" || key === "mode" || key === "corrections") && Array.isArray(body.signedPayloads) && body.signedPayloads.length > 0 && body.signedPayloads.length <= 64 && body.signedPayloads.every((token) => typeof token === "string" && token.length > 0 && token.length <= 512 * 1024) && (body.mode === "physical_count" || body.mode === "reconcile") && (body.corrections === undefined || Array.isArray(body.corrections) && body.corrections.length <= 5_000 && body.corrections.every((correction) => correction && typeof correction === "object" && !Array.isArray(correction) && Object.keys(correction).every((key) => key === "rowId" || key === "targetProductId" || key === "businessId") && typeof (correction as Record<string, unknown>).rowId === "string" && typeof (correction as Record<string, unknown>).targetProductId === "string" && ((correction as Record<string, unknown>).businessId === undefined || typeof (correction as Record<string, unknown>).businessId === "string")));
}
export function createIdentityApplyRoute(dependencies: { enabled: () => boolean; authorize: (request: Request, input: ApplyIdentityImportInput) => Promise<ApplyActor | undefined>; apply: (input: ApplyIdentityImportInput, actor: ApplyActor) => Promise<ApplyResult>; }): (request: Request) => Promise<NextResponse> {
  return async (httpRequest) => {
    if (!dependencies.enabled()) return json({ error: "Identity apply is unavailable." }, 404);
    const declared = Number(httpRequest.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxApplyBodyBytes) return json({ error: "Identity apply body is too large." }, 400);
    let body: unknown; try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(httpRequest))) as unknown; } catch (error) { return json({ error: error instanceof Error && error.message === "apply_body_too_large" ? "Identity apply body is too large." : "Body must be valid JSON." }, 400); }
    if (!request(body)) return json({ error: "Identity apply request was invalid." }, 400);
    let actor: ApplyActor | undefined; try { actor = await dependencies.authorize(httpRequest, { ...body, corrections: body.corrections ?? [] }); } catch (error) { return json({ error: error instanceof Error && error.message === "apply_nonmember" ? "Business access is required." : "Identity apply is temporarily unavailable." }, error instanceof Error && error.message === "apply_nonmember" ? 403 : 503); }
    if (!actor) return json({ error: "Sign in is required." }, 401);
    if (actor.role !== "owner" && actor.role !== "admin") return json({ error: "Only owners and admins can apply an import." }, 403);
    try { return json(await dependencies.apply({ ...body, corrections: body.corrections ?? [] }, actor), 200); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "apply_source_unavailable") return json({ error: "Identity apply is temporarily unavailable.", code }, 503);
      const conflict = new Set(["apply_in_progress", "apply_idempotency_conflict", "apply_target_stale", "apply_correction_target_invalid", "apply_preview_invalidated", "preview_versions_stale"]);
      const publicCode = conflict.has(code) ? code : "apply_internal_error";
      return json({ error: "Identity apply was rejected.", code: publicCode }, conflict.has(code) ? 409 : 400);
    }
  };
}

export const defaultIdentityApplyRoute = createIdentityApplyRoute({
  enabled: isLocalIdentityApplyEnabled,
  authorize: (request, input) => authorizeLocalIdentityApply(request, input.signedPayloads[0]!),
  apply: applyComposedIdentityImport,
});
