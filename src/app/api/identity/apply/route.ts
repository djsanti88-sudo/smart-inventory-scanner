import "server-only";

import { NextResponse } from "next/server";
import type { ApplyActor, ApplyIdentityImportInput, ApplyResult } from "@/server/identity/applyService";

function json(body: unknown, status: number): NextResponse { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function request(value: unknown): value is ApplyIdentityImportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every((key) => key === "signedPayloads" || key === "mode" || key === "corrections") && Array.isArray(body.signedPayloads) && body.signedPayloads.length > 0 && body.signedPayloads.length <= 64 && body.signedPayloads.every((token) => typeof token === "string" && token.length > 0) && (body.mode === "physical_count" || body.mode === "reconcile") && (body.corrections === undefined || Array.isArray(body.corrections));
}
export function createIdentityApplyRoute(dependencies: { enabled: () => boolean; authorize: (request: Request) => Promise<ApplyActor | undefined>; apply: (input: ApplyIdentityImportInput, actor: ApplyActor) => Promise<ApplyResult>; }): (request: Request) => Promise<NextResponse> {
  return async (httpRequest) => {
    if (!dependencies.enabled()) return json({ error: "Identity apply is unavailable." }, 404);
    let body: unknown; try { body = await httpRequest.json(); } catch { return json({ error: "Body must be valid JSON." }, 400); }
    if (!request(body)) return json({ error: "Identity apply request was invalid." }, 400);
    let actor: ApplyActor | undefined; try { actor = await dependencies.authorize(httpRequest); } catch { return json({ error: "Identity apply is temporarily unavailable." }, 503); }
    if (!actor) return json({ error: "Sign in is required." }, 401);
    if (actor.role !== "owner" && actor.role !== "admin") return json({ error: "Only owners and admins can apply an import." }, 403);
    try { return json(await dependencies.apply({ ...body, corrections: body.corrections ?? [] }, actor), 200); } catch { return json({ error: "Identity apply was rejected." }, 400); }
  };
}
