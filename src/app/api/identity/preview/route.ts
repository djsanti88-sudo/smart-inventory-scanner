import "server-only";

import { NextResponse } from "next/server";
import { isLiveAuth } from "@/services/auth/authMode";
import type { CreateIdentityPreviewInput } from "@/services/identity/preview";
import { authorizeLocalIdentityPreview, createComposedIdentityPreview } from "@/server/identity/previewComposition";
import { decodePreviewSigningKey } from "@/server/identity/previewSigner";

const MAX_REQUEST_BYTES = 512 * 1024;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBounded(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error("preview_request_too_large");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function isPreviewRequest(value: unknown): value is Omit<CreateIdentityPreviewInput, "actorId" | "versions" | "maxChunkBytes"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["rows", "orderedMappings", "sourceFileHashes", "importerVersion"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || !Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 5_000
    || !body.rows.every((row) => row && typeof row === "object" && !Array.isArray(row)
      && ["businessId", "sourceSystem", "sourceSignature", "vendorId"].every((key) => {
        const field = (row as Record<string, unknown>)[key];
        return typeof field === "string" && field.length > 0 && field.length <= 256;
      }))
    || !Array.isArray(body.sourceFileHashes) || !body.sourceFileHashes.every((hash) => typeof hash === "string" && hash.length > 0 && hash.length <= 256)
    || typeof body.importerVersion !== "string" || !body.importerVersion || body.importerVersion.length > 128
    || !Array.isArray(body.orderedMappings) || body.orderedMappings.length > 128) return false;
  const first = body.rows[0] as Record<string, unknown>;
  if (!body.rows.every((row) => ["businessId", "sourceSystem", "sourceSignature", "vendorId"].every((key) => (row as Record<string, unknown>)[key] === first[key]))) return false;
  return body.orderedMappings.every((mapping) => mapping && typeof mapping === "object" && !Array.isArray(mapping)
    && typeof (mapping as { sheetName?: unknown }).sheetName === "string" && (mapping as { sheetName: string }).sheetName.length > 0
    && (mapping as { mapping?: unknown }).mapping && typeof (mapping as { mapping: unknown }).mapping === "object" && !Array.isArray((mapping as { mapping: unknown }).mapping));
}

/** Server-only loader. The browser never receives this key and production routes are disabled. */
export function loadLocalPreviewSigningKey(): string {
  const key = process.env.IDENTITY_PREVIEW_SIGNING_KEY;
  decodePreviewSigningKey(key);
  if (!key) throw new Error("local_preview_signing_key_unavailable");
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
      const raw = await readBounded(request);
      body = JSON.parse(raw) as unknown;
    } catch (error) { return error instanceof Error && error.message === "preview_request_too_large" ? json({ error: "Preview request must be 512KB or smaller." }, 413) : json({ error: "Body must be valid JSON." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Body must be an identity preview request." }, 400);
    if (!isPreviewRequest(body)) return json({ error: "Identity preview request was invalid." }, 400);
    const input = body;
    let actor;
    try { actor = dependencies.authorize ? await dependencies.authorize(request, input.rows[0].businessId) : undefined; }
    catch { return json({ error: "Identity preview is temporarily unavailable." }, 503); }
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
