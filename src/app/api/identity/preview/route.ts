import "server-only";

import { NextResponse } from "next/server";
import { isLiveAuth } from "@/services/auth/authMode";
import type { CreateIdentityPreviewInput } from "@/services/identity/preview";
import { validateIdentityInput } from "@/services/identity/canonical";
import { authorizeLocalIdentityPreview, createComposedIdentityPreview } from "@/server/identity/previewComposition";

const MAX_REQUEST_BYTES = 512 * 1024;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isPreviewRequest(value: unknown): value is Omit<CreateIdentityPreviewInput, "actorId" | "versions" | "maxChunkBytes"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["rows", "orderedMappings", "sourceFileHashes", "importerVersion", "issuedAt", "expiresAt"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || !Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 5_000
    || !body.rows.every((row) => validateIdentityInput(row).length === 0)
    || !Array.isArray(body.sourceFileHashes) || !body.sourceFileHashes.every((hash) => typeof hash === "string" && hash.length > 0 && hash.length <= 256)
    || typeof body.importerVersion !== "string" || !body.importerVersion || body.importerVersion.length > 128
    || typeof body.issuedAt !== "string" || typeof body.expiresAt !== "string" || !Array.isArray(body.orderedMappings) || body.orderedMappings.length > 128) return false;
  return body.orderedMappings.every((mapping) => mapping && typeof mapping === "object" && !Array.isArray(mapping)
    && typeof (mapping as { sheetName?: unknown }).sheetName === "string" && (mapping as { sheetName: string }).sheetName.length > 0
    && (mapping as { mapping?: unknown }).mapping && typeof (mapping as { mapping: unknown }).mapping === "object" && !Array.isArray((mapping as { mapping: unknown }).mapping));
}

/** Server-only loader. The browser never receives this key and production routes are disabled. */
export function loadLocalPreviewSigningKey(): string {
  const key = process.env.IDENTITY_PREVIEW_SIGNING_KEY;
  if (!key || key.length < 32) throw new Error("local_preview_signing_key_unavailable");
  return key;
}

export function isLocalIdentityPreviewEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && !isLiveAuth() && process.env.NEXT_PUBLIC_LOCAL_HYBRID_IDENTITY_V1 === "1";
}

export function createIdentityPreviewRoute(dependencies: {
  enabled: () => boolean;
  authorize?: (request: Request, businessId: string) => Promise<{ actorId: string; role: "owner" | "admin" | "counter" | "viewer" } | undefined>;
  createPreview: (input: CreateIdentityPreviewInput, actor?: { actorId: string; role: "owner" | "admin" | "counter" | "viewer" }) => Promise<unknown>;
}): (request: Request) => Promise<NextResponse> {
  return async (request) => {
    if (!dependencies.enabled()) return json({ error: "Identity preview is unavailable." }, 404);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return json({ error: "Preview request must be 512KB or smaller." }, 413);
    let body: unknown;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return json({ error: "Preview request must be 512KB or smaller." }, 413);
      body = JSON.parse(raw) as unknown;
    } catch { return json({ error: "Body must be valid JSON." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Body must be an identity preview request." }, 400);
    if (!isPreviewRequest(body)) return json({ error: "Identity preview request was invalid." }, 400);
    const input = body;
    const actor = dependencies.authorize ? await dependencies.authorize(request, input.rows[0].businessId) : undefined;
    if (dependencies.authorize && !actor) return json({ error: "Sign in with business access is required." }, 403);
    try { return json(await dependencies.createPreview(input as CreateIdentityPreviewInput, actor), 200); }
    catch (error) {
      const code = error instanceof Error ? error.message : "identity_preview_unavailable";
      return json({ error: code === "local_snapshot_unavailable" || code === "local_preview_signing_key_unavailable" ? "Identity preview is temporarily unavailable." : "Identity preview request was invalid." }, 400);
    }
  };
}

// No default snapshot/repository is permitted: an unconfigured local route fails closed instead of
// silently reading a cache, initializing a provider, or falling back to an external catalog.
export const POST = createIdentityPreviewRoute({
  enabled: isLocalIdentityPreviewEnabled,
  authorize: authorizeLocalIdentityPreview,
  async createPreview(input, actor) {
    if (!actor) throw new Error("identity_preview_unauthorized");
    return createComposedIdentityPreview(input, actor);
  },
});
