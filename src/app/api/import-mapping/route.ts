// src/app/api/import-mapping/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebaseAdmin";
import { isLiveAuth } from "@/authentication/service/authMode";
import { isAuthBypassEnabled } from "@/authentication/service/authBypass";
import { COLLECTIONS, memberDocId } from "@/sync-database/types";
import type { ColumnMapping } from "@/import/importSchema";
import {
  getImportMappingMemory,
  putImportMappingMemory,
} from "@/import/importMappingMemory";
import { logServerEvent } from "@/server/log";

export const runtime = "nodejs";
const MAX_MAPPING_BODY_BYTES = 32 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Bearer tokens must travel in the Authorization header, never a URL query string (query strings
// land in server/proxy access logs). Strips a leading "Bearer " case-insensitively; returns "" if
// no header or an unrecognized scheme is present.
function bearerToken(request: NextRequest): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

function authConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential|GOOGLE_APPLICATION_CREDENTIALS|default credentials|service account|ENOENT/i.test(message);
}

// Live mode verifies the caller's ID token and businessMembers membership before any read/write.
// The credential-free bypass is mock mode or the hardened test/demo gate (isAuthBypassEnabled), which
// short-circuits to false in production before reading any flag - a stray IS_E2E can never open this.
async function authorize(businessId: string, idToken: string): Promise<NextResponse | null> {
  if (isAuthBypassEnabled() || !isLiveAuth()) return null;
  if (!idToken) {
    logServerEvent({ route: "/api/import-mapping", event: "auth_reject", reasonCode: "unauthenticated", businessId, status: 401 });
    return json({ error: "Sign in required." }, 401);
  }
  let uid: string;
  try {
    uid = (await getAdminAuth().verifyIdToken(idToken)).uid;
  } catch (error) {
    if (authConfigurationError(error)) {
      logServerEvent({ route: "/api/import-mapping", event: "auth_unavailable", reasonCode: "auth_unavailable", businessId, status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/import-mapping", event: "auth_reject", reasonCode: "bad_token", businessId, status: 401 });
    return json({ error: "Invalid or expired sign-in." }, 401);
  }
  try {
    const member = await getAdminDb()
      .doc(`${COLLECTIONS.businessMembers}/${memberDocId(businessId, uid)}`)
      .get();
    if (member.exists) return null;
    logServerEvent({ route: "/api/import-mapping", event: "auth_reject", reasonCode: "not_member", businessId, status: 403 });
    return json({ error: "Not a member of this business." }, 403);
  } catch (error) {
    if (authConfigurationError(error)) {
      logServerEvent({ route: "/api/import-mapping", event: "auth_unavailable", reasonCode: "auth_unavailable", businessId, status: 503 });
      return json({ error: "Server auth is not configured." }, 503);
    }
    logServerEvent({ route: "/api/import-mapping", event: "error", reasonCode: "membership_check_failed", businessId, status: 503 });
    return json({ error: "Could not verify business membership." }, 503);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = new URL(request.url).searchParams;
  const businessId = text(searchParams.get("businessId"));
  const sourceSignature = text(searchParams.get("sourceSignature"));
  const idToken = bearerToken(request);
  if (!businessId || !sourceSignature) {
    return json({ error: "businessId and sourceSignature are required." }, 400);
  }
  const denied = await authorize(businessId, idToken);
  if (denied) return denied;
  const record = await getImportMappingMemory(businessId, sourceSignature);
  return json({ mapping: record?.mapping ?? null });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MAPPING_BODY_BYTES) {
    return json({ error: "Import mapping must be 32KB or smaller." }, 413);
  }
  const raw = await request.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > MAX_MAPPING_BODY_BYTES) {
    return json({ error: "Import mapping must be 32KB or smaller." }, 413);
  }
  let body: { businessId?: unknown; sourceSignature?: unknown; mapping?: unknown; idToken?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const businessId = text(body.businessId);
  const sourceSignature = text(body.sourceSignature);
  const idToken = text(body.idToken);
  if (!businessId || !sourceSignature || !body.mapping || typeof body.mapping !== "object") {
    return json({ error: "businessId, sourceSignature, and mapping are required." }, 400);
  }
  const denied = await authorize(businessId, idToken);
  if (denied) return denied;
  await putImportMappingMemory({
    businessId,
    sourceSignature,
    mapping: body.mapping as ColumnMapping,
    updatedAt: new Date().toISOString(),
  });
  return json({ ok: true });
}
